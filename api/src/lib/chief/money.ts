/**
 * Q6: the Financial Mind in the watch and the brief (parents only).
 *
 * Payments a parent makes become loops (C4) with the payment prepared: bills not on autopay and
 * debt minimums, due within a week — closed on the bank's own evidence when the payment posts,
 * so a minimum never breaks silently. A predicted overdraft is a loop too, days early, with the
 * fix attached; it closes itself when the projection stops dipping. The watch also says, once
 * each: utilization near the limit, capture checks, and a 24-hour want whose day is up.
 */
import type { DateStr, HanaWatchCategory } from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import type { HouseholdMember } from '@myday/shared';
import { dayLabel, moneyMind, paymentsDue, snapshot, usd, type DuePayment } from '../money/mind.js';
import { openLoop } from './loops.js';

export const MONEY_SOURCE = 'Linked bank + your bills, debts and funds';

export interface MoneyFinding {
  key: string;
  category: HanaWatchCategory;
  text: string;
  sameDay: boolean;
  to?: number[];
  subjectId: number | null;
  source: string;
  asOf: string;
  once?: boolean;
}

export const paymentLine = (p: DuePayment): string => `Pay ${p.what} ${usd(p.amount)} by ${dayLabel(p.date)}${p.from ? ` — prepared from ${p.from}; you make the payment` : ''}`;

/** Loops for what's due and what's predicted; closed on evidence. */
export async function moneyLoops(): Promise<void> {
  const now = new Date();
  for (const p of await paymentsDue(7)) {
    if (p.paid) {
      await pool.query('UPDATE open_loops SET closed_at = $2, closed_evidence = $3 WHERE source_ref = $1 AND closed_at IS NULL', [
        p.ref,
        now,
        `A ${usd(p.paid.amount)} payment to ${p.what.replace(/ minimum$/, '')} posted on ${dayLabel(p.paid.date)}`,
      ]);
    } else if (p.date >= today()) {
      await openLoop(null, { what: paymentLine(p), owedBy: p.owner ?? 'the family', due: p.date, source: 'money', sourceRef: p.ref });
    }
  }
}

/** One pass: snapshot, loops, and the findings the watch may say. */
export async function moneyWatch(parents: HouseholdMember[]): Promise<MoneyFinding[]> {
  if (!parents.length) return [];
  const m = await moneyMind();
  await snapshot(m);
  await moneyLoops();
  const t = today();
  const out: MoneyFinding[] = [];
  const base = { category: 'money' as const, sameDay: false, subjectId: null, source: MONEY_SOURCE, asOf: m.asOf, once: true };

  const dipRef = m.overdraft ? `money:overdraft:${m.overdraft.date}` : '';
  if (m.overdraft) {
    const o = m.overdraft;
    const text = `${o.account} dips to ${usd(o.low)} on ${dayLabel(o.date)} unless ${usd(o.shortBy)} moves. Prepared fix: ${o.fix}`;
    await openLoop(null, { what: text, owedBy: 'the family', due: addDays(o.date, -1) as DateStr, source: 'money', sourceRef: dipRef });
    out.push({ ...base, key: dipRef, text });
  }
  // A dip that no longer shows (the fix landed, a paycheck moved): the loop closes on that evidence.
  await pool.query(
    "UPDATE open_loops SET closed_at = $1, closed_evidence = $2 WHERE source = 'money' AND source_ref LIKE 'money:overdraft:%' AND closed_at IS NULL AND source_ref <> $3",
    [new Date(), 'The balance projection no longer dips', dipRef],
  );

  for (const d of m.debts.debts) {
    if (d.utilization !== null && d.utilization >= 90) {
      const w = m.debts.warnings.find((x) => x.startsWith(d.name));
      if (w) out.push({ ...base, key: `money:util:${d.name}:${t.slice(0, 7)}:${d.utilization >= 100 ? 'over' : 'near'}`, text: w });
    }
  }
  for (const c of m.checks) out.push({ ...base, key: `money:check:${c.key}`, text: c.text });

  const { rows: ready } = await pool.query<{ id: number; member_id: number }>(
    'SELECT id, member_id FROM money_wants WHERE decided IS NULL AND added_at <= $1',
    [new Date(Date.now() - 86_400_000)],
  );
  for (const r of ready) {
    const w = m.wants.find((x) => x.id === r.id);
    if (!w) continue;
    const fits = m.safe ? ` Safe to spend today is ${usd(m.safe.amount)}.` : '';
    out.push({ ...base, key: `money:want:${w.id}`, to: [r.member_id], text: `The day is up on “${w.what}” (${usd(w.amount)}). Still want it? Bought or let go — either is fine.${fits}` });
  }
  return out;
}

/** The parents' morning brief: the headline number first, then what needs a hand. */
export async function moneyBrief(): Promise<Array<{ key: string; text: string; headsUp: boolean; source: string; asOf: string; check: string | null }>> {
  const m = await moneyMind();
  const items: Array<{ key: string; text: string; headsUp: boolean; source: string; asOf: string; check: string | null }> = [];
  const t = today();
  if (m.safe) {
    items.push({ key: `money:safe:${t}`, text: `Safe to spend: ${usd(m.safe.amount)} until ${dayLabel(m.safe.until)}. ${m.safe.pace.text}`, headsUp: m.safe.pace.label === 'short', source: MONEY_SOURCE, asOf: m.asOf, check: m.stale });
  }
  if (m.overdraft) {
    items.push({ key: `money:overdraft:${m.overdraft.date}`, text: `${m.overdraft.account} dips to ${usd(m.overdraft.low)} on ${dayLabel(m.overdraft.date)} unless ${usd(m.overdraft.shortBy)} moves. Prepared fix: ${m.overdraft.fix}`, headsUp: true, source: MONEY_SOURCE, asOf: m.asOf, check: m.stale });
  }
  for (const w of m.debts.warnings.filter((x) => /over its limit|% of its .* limit — /.test(x))) items.push({ key: `money:util:${w.slice(0, 40)}`, text: w, headsUp: true, source: MONEY_SOURCE, asOf: m.asOf, check: m.stale });
  const win = m.wins[0];
  if (win) items.push({ key: `money:win:${t}`, text: win, headsUp: false, source: MONEY_SOURCE, asOf: m.asOf, check: null });
  return items;
}
