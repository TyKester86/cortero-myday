/**
 * Q6: the Financial Mind — the household's whole money picture, computed from tools, never vibes.
 * Parents only. She PREPARES (fixes, moves, payments as loops); a parent does every one of them.
 * Nothing here can move money: there is no payment, transfer or purchase call anywhere in it.
 *
 *   - safe-to-spend: cash in checking − every committed outflow until payday (recurring charges
 *     from checking, the family's bills, debt minimums, sinking-fund reserves), with pace;
 *   - overdraft prediction: the checking balance walked forward day by day, the dip found early,
 *     the fix prepared (a transfer from savings, a due-date move, a split);
 *   - payday choreography: every obligation on the income rhythm, the tight stretches named and
 *     the due-date moves drafted;
 *   - debt command: every liability, utilization, avalanche vs snowball (interest and debt-free
 *     dates for each) with the assumptions labeled;
 *   - sinking funds, the 24-hour list, capture checks (unclaimed match, use-it-or-lose-it money,
 *     charges after a cancel, subscriptions to review, price changes, unusual bills), and wins.
 *
 * Tone is facts, never judgment: a blown week is new data and a new pace.
 */
import type {
  CaptureCheck,
  DateStr,
  MindCommitment,
  MindDebt,
  MindDebts,
  MindMove,
  MindOverdraft,
  MindPeriod,
  MindSafeToSpend,
  MoneyBenefit,
  MoneyMark,
  MoneyMind,
  MoneyPhysical,
  MoneySettings,
  MoneyWant,
  PayoffPlan,
  Recurring,
  SinkingFund,
} from '@myday/shared';
import { pool } from '../../db.js';
import { addDays, daysBetween, today } from '../dates.js';
import { HttpError } from '../http.js';
import type { HouseholdMember } from '@myday/shared';
import { detectRecurring, normalizeMerchant, occurrences, sameDayNextMonth, type TxnLite } from './analyze.js';

const r2 = (x: number): number => Math.round(x * 100) / 100;
const MONTH_DAYS = 30.44;

export const usd = (n: number): string => `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (n: number): string => `${n < 0 ? '−' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
export const dayLabel = (d: DateStr): string =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const monthLabel = (ym: string): string => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** The date a day-of-month falls on in a month (clamped to month end). */
function dueIn(month: string, day: number): DateStr {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}` as DateStr;
}

/** Each date a day-of-month bill falls on in [from, until). */
function monthlyDates(day: number, from: DateStr, until: DateStr): DateStr[] {
  const out: DateStr[] = [];
  let month = from.slice(0, 7);
  for (let i = 0; i < 4; i++) {
    const d = dueIn(month, day);
    if (d >= from && d < until) out.push(d);
    month = addMonths(month, 1);
  }
  return out;
}

const sameThing = (a: string, b: string): boolean => {
  const x = normalizeMerchant({ merchant: a, name: a });
  const y = normalizeMerchant({ merchant: b, name: b });
  if (!x || !y) return false;
  const first = (s: string): string => s.split(' ').find((w) => w.length > 2) ?? s;
  return x.includes(y) || y.includes(x) || first(x) === first(y);
};

/* ---------------- payoff math (pure; also professor mode's calculator) ---------------- */

export interface DebtIn {
  name: string;
  balance: number;
  apr: number;
  minimum: number;
}

/**
 * Month by month: interest accrues (APR/12 on the balance), every minimum is paid, then the
 * extra — plus the minimums freed by debts already gone (the rollover) — goes to the target debt
 * (avalanche: highest APR first; snowball: smallest balance first). 'minimums' pays minimums only.
 */
export function simulatePayoff(debts: DebtIn[], extra: number, strategy: PayoffPlan['strategy']): { months: number | null; interest: number | null; order: string[] } {
  const open = debts.filter((d) => d.balance > 0.004).map((d) => ({ ...d }));
  if (!open.length) return { months: 0, interest: 0, order: [] };
  const budget = open.reduce((s, d) => s + d.minimum, 0) + (strategy === 'minimums' ? 0 : extra);
  const order: string[] = [];
  let interest = 0;
  for (let month = 1; month <= 600; month++) {
    for (const d of open) {
      if (d.balance <= 0.004) continue;
      const i = (d.balance * d.apr) / 1200;
      d.balance += i;
      interest += i;
    }
    let pool = budget;
    for (const d of open) {
      if (d.balance <= 0.004) continue;
      const pay = Math.min(d.balance, d.minimum);
      d.balance -= pay;
      pool -= pay;
    }
    if (strategy !== 'minimums') {
      const targets = open
        .filter((d) => d.balance > 0.004)
        .sort((a, b) => (strategy === 'avalanche' ? b.apr - a.apr || a.balance - b.balance : a.balance - b.balance || b.apr - a.apr));
      for (const d of targets) {
        if (pool <= 0.004) break;
        const pay = Math.min(d.balance, pool);
        d.balance -= pay;
        pool -= pay;
      }
    }
    for (const d of open) if (d.balance <= 0.004 && !order.includes(d.name)) order.push(d.name);
    if (open.every((d) => d.balance <= 0.004)) return { months: month, interest: r2(interest), order };
  }
  return { months: null, interest: null, order };
}

/** Fixed-payment loan: payment, total interest. */
export function amortize(principal: number, apr: number, months: number): { payment: number; interest: number } {
  const r = apr / 1200;
  const payment = r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
  return { payment: r2(payment), interest: r2(payment * months - principal) };
}

/** Months to pay a balance at a fixed payment (null when the payment never covers the interest). */
export function monthsToPay(balance: number, apr: number, payment: number): { months: number | null; interest: number | null } {
  const r = apr / 1200;
  if (payment <= balance * r) return { months: null, interest: null };
  const n = r === 0 ? balance / payment : -Math.log(1 - (r * balance) / payment) / Math.log(1 + r);
  const months = Math.ceil(n - 1e-9);
  const s = simulatePayoff([{ name: 'x', balance, apr, minimum: payment }], 0, 'minimums');
  return { months, interest: s.interest };
}

/** Future value of a start amount plus monthly additions at an annual rate, compounded monthly. */
export function growth(start: number, monthly: number, ratePct: number, years: number): { value: number; contributed: number } {
  const r = ratePct / 1200;
  const n = Math.round(years * 12);
  const fv = r === 0 ? start + monthly * n : start * (1 + r) ** n + (monthly * ((1 + r) ** n - 1)) / r;
  return { value: r2(fv), contributed: r2(start + monthly * n) };
}

/* ---------------- loading ---------------- */

interface Loaded {
  t: DateStr;
  txns: Array<TxnLite & { category: string; acctType: string; acctName: string }>;
  checking: Array<{ name: string; cash: number }>;
  savings: Array<{ name: string; cash: number }>;
  cards: Array<{ id: number; name: string; current: number; available: number | null }>;
  cashAll: number;
  syncedAt: Date | null;
  bills: Array<{ id: number; name: string; amount: number; dueDay: number | null; autopay: boolean; owner: string }>;
  debtRows: Array<{ id: number; name: string; kind: string; balance: number; apr: number | null; minimum: number; due_day: number | null; credit_limit: number | null; account_id: number | null; autopay: boolean }>;
  settings: MoneySettings;
  funds: SinkingFund[];
  wants: MoneyWant[];
  marks: MoneyMark[];
  benefits: MoneyBenefit[];
  invest: Array<{ name: string; balance: number; match: number; matchMax: number }>;
}

const N = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const Nn = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export async function moneySettings(): Promise<MoneySettings> {
  const { rows } = await pool.query<{ want_threshold: string; extra_payment: string; cushion: string; pay_anchor: string | null; pay_cadence: MoneySettings['payCadence']; pay_amount: string | null }>(
    'SELECT want_threshold, extra_payment, cushion, pay_anchor::text AS pay_anchor, pay_cadence, pay_amount FROM money_settings LIMIT 1',
  );
  const s = rows[0];
  return {
    wantThreshold: s ? N(s.want_threshold) : 100,
    extraPayment: s ? N(s.extra_payment) : 0,
    cushion: s ? N(s.cushion) : 0,
    payAnchor: (s?.pay_anchor ?? null) as DateStr | null,
    payCadence: s?.pay_cadence ?? null,
    payAmount: s ? Nn(s.pay_amount) : null,
  };
}

async function load(): Promise<Loaded> {
  const t = today();
  const { rows: tx } = await pool.query<{ day: DateStr; name: string; merchant: string; amount: string; pending: boolean; category: string; type: string; acct: string }>(
    `SELECT t.day::text AS day, t.name, t.merchant, t.amount, t.pending, t.category, a.type, a.name AS acct
       FROM money_transactions t JOIN money_accounts a ON a.id = t.account_id JOIN money_items i ON i.id = a.item_id
      WHERE i.member_id IS NULL AND t.day >= $1 ORDER BY t.day, t.id`,
    [addDays(t, -400)],
  );
  const { rows: ac } = await pool.query<{ id: number; name: string; type: string; subtype: string; current: string | null; available: string | null; updated_at: Date }>(
    `SELECT a.id, a.name, a.type, a.subtype, a.current, a.available, a.updated_at FROM money_accounts a JOIN money_items i ON i.id = a.item_id
      WHERE i.member_id IS NULL ORDER BY a.id`,
  );
  const cashOf = (a: { available: string | null; current: string | null }): number => (a.available !== null ? N(a.available) : N(a.current));
  const dep = ac.filter((a) => a.type === 'depository');
  // An account with no subtype (or 'checking') is spending money; savings is where a fix can come from.
  const checking = dep.filter((a) => a.subtype !== 'savings' && a.subtype !== 'money market' && a.subtype !== 'cd').map((a) => ({ name: a.name, cash: cashOf(a) }));
  const savings = dep.filter((a) => a.subtype === 'savings' || a.subtype === 'money market').map((a) => ({ name: a.name, cash: cashOf(a) }));
  const { rows: bl } = await pool.query<{ id: number; name: string; amount: string; due_day: number | null; autopay: boolean; owner: string }>(
    `SELECT b.id, b.name, b.amount, b.due_day, b.autopay, m.name AS owner FROM bills b JOIN household_members m ON m.id = b.member_id
      WHERE m.kind = 'adult' AND m.archived_at IS NULL ORDER BY b.due_day NULLS LAST, b.id`,
  );
  const { rows: dr } = await pool.query<{ id: number; name: string; kind: string; balance: string; apr: string | null; minimum: string; due_day: number | null; credit_limit: string | null; account_id: number | null; autopay: boolean }>(
    'SELECT id, name, kind, balance, apr, minimum, due_day, credit_limit, account_id, autopay FROM debts ORDER BY id',
  );
  const { rows: fr } = await pool.query<{ id: number; name: string; amount: string; due_on: DateStr; saved: string; yearly: boolean }>(
    'SELECT id, name, amount, due_on::text AS due_on, saved, yearly FROM sinking_funds ORDER BY due_on, id',
  );
  const { rows: wr } = await pool.query<{ id: number; what: string; amount: string; added_at: Date; decided: MoneyWant['decided']; by: string }>(
    `SELECT w.id, w.what, w.amount, w.added_at, w.decided, m.name AS by FROM money_wants w JOIN household_members m ON m.id = w.member_id
      WHERE w.decided IS NULL OR w.decided_at > $1 ORDER BY w.added_at DESC, w.id DESC`,
    [new Date(Date.now() - 30 * 86_400_000)],
  );
  const { rows: mr } = await pool.query<{ merchant_key: string; label: string; mark: MoneyMark['mark']; marked_on: DateStr }>(
    'SELECT merchant_key, label, mark, marked_on::text AS marked_on FROM money_marks ORDER BY id',
  );
  const { rows: br } = await pool.query<{ id: number; kind: MoneyBenefit['kind']; label: string; amount: string; deadline: DateStr }>(
    'SELECT id, kind, label, amount, deadline::text AS deadline FROM money_benefits ORDER BY deadline, id',
  );
  const { rows: ir } = await pool.query<{ name: string; balance: string | null; employer_match: string; match_max: string }>(
    `SELECT a.name, (SELECT b.balance FROM invest_balances b WHERE b.account_id = a.id ORDER BY b.as_of DESC LIMIT 1) AS balance, a.employer_match, a.match_max
       FROM invest_accounts a ORDER BY a.id`,
  );
  const now = Date.now();
  return {
    t,
    txns: tx.map((x) => ({ date: x.day, name: x.name, merchant: x.merchant, amount: N(x.amount), pending: x.pending, category: x.category, acctType: x.type, acctName: x.acct })),
    checking,
    savings,
    cards: ac.filter((a) => a.type === 'credit').map((a) => ({ id: a.id, name: a.name, current: N(a.current), available: Nn(a.available) })),
    cashAll: r2(dep.reduce((s, a) => s + cashOf(a), 0)),
    syncedAt: ac.length ? ac.reduce((m, a) => (a.updated_at < m ? a.updated_at : m), ac[0]?.updated_at ?? new Date()) : null,
    bills: bl.map((b) => ({ id: b.id, name: b.name, amount: N(b.amount), dueDay: b.due_day, autopay: b.autopay, owner: b.owner })),
    debtRows: dr.map((d) => ({ ...d, balance: N(d.balance), apr: Nn(d.apr), minimum: N(d.minimum), credit_limit: Nn(d.credit_limit) })),
    settings: await moneySettings(),
    funds: fr.map((f) => fund(f, t)),
    wants: wr.map((w) => {
      const ready = new Date(w.added_at.getTime() + 86_400_000);
      return { id: w.id, what: w.what, amount: N(w.amount), by: w.by, addedAt: w.added_at.toISOString(), readyAt: ready.toISOString(), ready: ready.getTime() <= now, decided: w.decided };
    }),
    marks: mr.map((m) => ({ merchantKey: m.merchant_key, label: m.label, mark: m.mark, markedOn: m.marked_on })),
    benefits: br.map((b) => ({ id: b.id, kind: b.kind, label: b.label, amount: N(b.amount), deadline: b.deadline })),
    invest: ir.map((i) => ({ name: i.name, balance: N(i.balance), match: N(i.employer_match), matchMax: N(i.match_max) })),
  };
}

function fund(f: { id: number; name: string; amount: string; due_on: DateStr; saved: string; yearly: boolean }, t: DateStr): SinkingFund {
  let due = f.due_on;
  // A yearly fund whose date passed rolls to next year's (what it's for comes around again).
  while (f.yearly && due < t) due = `${Number(due.slice(0, 4)) + 1}${due.slice(4)}` as DateStr;
  const amount = N(f.amount);
  const saved = N(f.saved);
  const months = Math.max(1, Math.ceil(daysBetween(t, due) / MONTH_DAYS));
  return { id: f.id, name: f.name, amount, dueOn: due, saved, yearly: f.yearly, months, monthly: r2(Math.max(0, amount - saved) / months) };
}

/* ---------------- the rhythm: paydays ---------------- */

interface Pay {
  date: DateStr;
  amount: number;
  label: string;
}

function scheduleDates(s: MoneySettings, from: DateStr, until: DateStr): DateStr[] {
  if (!s.payAnchor || !s.payCadence) return [];
  const out: DateStr[] = [];
  if (s.payCadence === 'weekly' || s.payCadence === 'biweekly') {
    const step = s.payCadence === 'weekly' ? 7 : 14;
    let d = s.payAnchor;
    const behind = daysBetween(d, from);
    if (behind > 0) d = addDays(d, Math.floor(behind / step) * step);
    for (let i = 0; i < 200 && d < until; i++, d = addDays(d, step)) if (d >= from) out.push(d);
    return out;
  }
  const a = Number(s.payAnchor.slice(8, 10));
  const days = s.payCadence === 'monthly' ? [a] : [a, a <= 15 ? a + 15 : a - 15];
  for (const day of days) out.push(...monthlyDates(day, from, until));
  return out.sort();
}

/** Paydays in [from, until): from the bank's detected paychecks, else the family's pay schedule. */
function paydays(L: Loaded, income: Recurring[], from: DateStr, until: DateStr): { pays: Pay[]; basis: 'paycheck' | 'pay schedule' | null } {
  const detected = income.flatMap((i) => occurrences(i, from, until).map((date) => ({ date, amount: i.amount, label: i.merchant })));
  if (detected.length) return { pays: detected.sort((a, b) => (a.date < b.date ? -1 : 1)), basis: 'paycheck' };
  const sched = scheduleDates(L.settings, from, until).map((date) => ({ date, amount: L.settings.payAmount ?? 0, label: 'Paycheck' }));
  return { pays: sched, basis: sched.length ? 'pay schedule' : null };
}

/** The most recent payday on or before today (for pace). */
function lastPayday(L: Loaded, income: Recurring[]): DateStr | null {
  const fromBank = income.map((i) => i.lastDate).sort().reverse()[0];
  if (fromBank) return fromBank;
  const past = scheduleDates(L.settings, addDays(L.t, -40), addDays(L.t, 1));
  return past[past.length - 1] ?? null;
}

/* ---------------- commitments ---------------- */

const SKIP_DISCRETIONARY = /TRANSFER|LOAN_PAYMENTS|INCOME|RENT_AND_UTILITIES|BANK_FEES/i;

interface Ctx {
  L: Loaded;
  subs: Recurring[];
  income: Recurring[];
  checkingSubs: Recurring[];
  debts: MindDebt[];
}

/** Paid already this cycle: a matching charge in the 25 days before the due date. */
function paidFor(L: Loaded, name: string, amount: number, due: DateStr): { date: DateStr; amount: number } | null {
  const hit = L.txns.find((x) => x.amount > 0 && x.date >= addDays(due, -25) && x.date <= addDays(due, 3) && x.amount >= amount * 0.9 && sameThing(x.merchant || x.name, name));
  return hit ? { date: hit.date, amount: hit.amount } : null;
}

/** Every outflow already promised out of checking in [from, until) — not reserves (those are set aside, not spent). */
function obligations(c: Ctx, from: DateStr, until: DateStr): MindCommitment[] {
  const out: MindCommitment[] = [];
  for (const s of c.checkingSubs) for (const date of occurrences(s, from, until)) out.push({ what: s.merchant, amount: s.amount, date, kind: 'recurring' });
  const covered = (name: string): boolean => c.checkingSubs.some((s) => sameThing(s.merchant, name)) || c.subs.some((s) => sameThing(s.merchant, name));
  for (const b of c.L.bills) {
    if (b.dueDay === null || covered(b.name)) continue;
    for (const date of monthlyDates(b.dueDay, from, until)) if (!paidFor(c.L, b.name, b.amount, date)) out.push({ what: b.name, amount: b.amount, date, kind: 'bill' });
  }
  for (const d of c.debts) {
    if (!d.dueDay || d.minimum <= 0 || covered(d.name)) continue;
    for (const date of monthlyDates(d.dueDay, from, until)) if (!paidFor(c.L, d.name, d.minimum, date)) out.push({ what: `${d.name} minimum`, amount: d.minimum, date, kind: 'minimum' });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
}

/* ---------------- the pieces ---------------- */

function debtsOf(L: Loaded): MindDebt[] {
  const t = L.t;
  const nextDue = (day: number | null): DateStr | null => (day ? (monthlyDates(day, t, addDays(t, 45))[0] ?? null) : null);
  const used = new Set<number>();
  const out: MindDebt[] = L.debtRows.map((d) => {
    const card = d.account_id ? L.cards.find((c) => c.id === d.account_id) : undefined;
    if (card) used.add(card.id);
    const balance = card ? card.current : d.balance;
    const limit = d.credit_limit ?? (card && card.available !== null ? r2(card.current + card.available) : null);
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      balance: r2(balance),
      apr: d.apr,
      minimum: d.minimum,
      dueDay: d.due_day,
      limit,
      utilization: limit ? Math.round((1000 * balance) / limit) / 10 : null,
      nextDue: nextDue(d.due_day),
      autopay: d.autopay,
      linked: !!card,
    };
  });
  // A linked card nobody has described yet is still a liability — in the picture, its APR unknown.
  for (const c of L.cards) {
    if (used.has(c.id) || c.current <= 0) continue;
    const limit = c.available !== null ? r2(c.current + c.available) : null;
    out.push({ id: null, name: c.name, kind: 'credit_card', balance: r2(c.current), apr: null, minimum: 0, dueDay: null, limit, utilization: limit ? Math.round((1000 * c.current) / limit) / 10 : null, nextDue: null, autopay: false, linked: true });
  }
  return out;
}

export function debtPlan(debts: MindDebt[], extra: number): MindDebts {
  const open = debts.filter((d) => d.balance > 0);
  const assumptions = [
    'Interest compounds monthly at the APR as entered.',
    'Minimums stay what they are today; the extra is the same every month.',
    extra > 0 ? `${usd(extra)} extra a month on top of the minimums; a paid-off debt's minimum rolls to the next.` : 'No extra payment set — add one to see how much sooner it ends.',
  ];
  for (const d of open) {
    if (d.apr === null) assumptions.push(`${d.name}: no APR entered — modeled at 0%, so its interest is missing from these numbers.`);
    if (d.minimum <= 0) assumptions.push(`${d.name}: no minimum entered — modeled as $0 a month.`);
  }
  const ins: DebtIn[] = open.map((d) => ({ name: d.name, balance: d.balance, apr: d.apr ?? 0, minimum: d.minimum }));
  const base = simulatePayoff(ins, 0, 'minimums');
  const ym = today().slice(0, 7);
  const plan = (strategy: PayoffPlan['strategy']): PayoffPlan => {
    const s = strategy === 'minimums' ? base : simulatePayoff(ins, extra, strategy);
    return {
      strategy,
      months: s.months,
      debtFree: s.months === null ? null : addMonths(ym, s.months),
      interest: s.interest,
      saved: s.interest !== null && base.interest !== null ? r2(base.interest - s.interest) : null,
      order: s.order,
    };
  };
  const plans = open.length ? [plan('avalanche'), plan('snowball'), plan('minimums')] : [];
  const [av, sn] = plans;
  let recommended: MindDebts['recommended'] = null;
  let why = '';
  if (av && sn && av.interest !== null && sn.interest !== null) {
    const gap = r2(sn.interest - av.interest);
    if (gap >= 25) {
      recommended = 'avalanche';
      why = `Avalanche costs ${usd(gap)} less in interest than snowball. Snowball gets a first debt gone sooner, if a quick win matters more than the ${usd(gap)}.`;
    } else {
      recommended = 'snowball';
      why = `The two cost within ${usd(Math.max(0, gap))} of each other, so snowball's quicker first win is nearly free.`;
    }
  } else if (av && av.months === null) {
    why = 'At these payments the balances never reach zero — the interest outruns the minimums. Any extra a month changes that; the plan updates as soon as it does.';
  }
  const warnings: string[] = [];
  for (const d of open) {
    if (d.utilization === null) continue;
    if (d.utilization >= 100) warnings.push(`${d.name} is over its limit (${usd(d.balance)} of ${usd(d.limit ?? 0)}) — an over-limit fee or a declined card can come next.`);
    else if (d.utilization >= 90) warnings.push(`${d.name} is at ${d.utilization}% of its ${usd(d.limit ?? 0)} limit — ${usd((d.limit ?? 0) - d.balance)} of room before it's over.`);
    else if (d.utilization >= 30) warnings.push(`${d.name} is at ${d.utilization}% of its limit; below 30% is what credit scores reward.`);
  }
  return {
    debts,
    total: r2(open.reduce((s, d) => s + d.balance, 0)),
    minimums: r2(open.reduce((s, d) => s + d.minimum, 0)),
    extra,
    plans,
    recommended,
    why,
    assumptions,
    warnings,
  };
}

function safeNow(c: Ctx, until: DateStr, basis: MindSafeToSpend['basis'], funds: SinkingFund[]): MindSafeToSpend {
  const L = c.L;
  const t = L.t;
  const cash = r2(L.checking.reduce((s, a) => s + a.cash, 0));
  const daysLeft = Math.max(1, daysBetween(t, until));
  const committed = obligations(c, t, until);
  for (const f of funds) {
    if (f.monthly <= 0) continue;
    committed.push({ what: `Set aside for ${f.name}`, amount: r2((f.monthly * daysLeft) / MONTH_DAYS), date: t, kind: 'reserve' });
  }
  const committedTotal = r2(committed.reduce((s, x) => s + x.amount, 0));
  const amount = r2(cash - committedTotal);
  const onCards = c.subs
    .filter((s) => !c.checkingSubs.includes(s))
    .flatMap((s) => occurrences(s, t, until).map((date) => ({ merchant: s.merchant, amount: s.amount, date })));

  // Pace: everyday spending since the last payday against an even line to the next.
  const start = lastPayday(L, c.income) ?? addDays(t, -14);
  const periodDays = Math.max(1, daysBetween(start, until));
  const elapsed = Math.min(periodDays, Math.max(1, daysBetween(start, t) + 1));
  const recurringKeys = new Set(c.subs.map((s) => normalizeMerchant({ merchant: s.merchant, name: s.merchant })));
  const spent = r2(
    L.txns
      .filter((x) => x.amount > 0 && x.date >= start && x.date <= t && !SKIP_DISCRETIONARY.test(x.category) && !recurringKeys.has(normalizeMerchant(x)) && !L.bills.some((b) => sameThing(b.name, x.merchant || x.name)))
      .reduce((s, x) => s + x.amount, 0),
  );
  const budget = Math.max(0, spent + amount);
  const expected = r2((budget * elapsed) / periodDays);
  const hot = r2(spent - expected);
  const thr = Math.max(20, budget * 0.05);
  const perDay = r2(Math.max(0, amount) / daysLeft);
  const span = `the ${daysLeft} day${daysLeft === 1 ? '' : 's'} to ${basis === '14-days' ? dayLabel(until) : 'payday'}`;
  let label: MindSafeToSpend['pace']['label'];
  let text: string;
  if (amount < 0) {
    label = 'short';
    text = `What's already promised before ${basis === '14-days' ? dayLabel(until) : 'payday'} is ${usd(-amount)} more than the cash in checking.`;
  } else if (hot > thr) {
    label = 'hot';
    text = `${usd0(hot)} hot — about ${usd(perDay)} a day for ${span} evens it out.`;
  } else if (hot < -thr) {
    label = 'ahead';
    text = `Ahead of pace by ${usd0(-hot)} — about ${usd(perDay)} a day for ${span}.`;
  } else {
    label = 'on pace';
    text = `On pace — about ${usd(perDay)} a day for ${span}.`;
  }
  return { amount, cash, until, basis, committed, committedTotal, onCards, pace: { label, text, spent, expected, hot, perDay, daysLeft } };
}

const roundUp10 = (x: number): number => Math.ceil(x / 10) * 10;

/** Walk checking forward 35 days: paychecks in, obligations and average everyday checking spend out. */
function overdraft(c: Ctx, pays: Pay[]): MindOverdraft | null {
  const L = c.L;
  if (!L.checking.length) return null;
  const t = L.t;
  const horizon = addDays(t, 35);
  const obl = obligations(c, t, horizon);
  const recurringKeys = new Set(c.subs.map((s) => normalizeMerchant({ merchant: s.merchant, name: s.merchant })));
  const daily = r2(
    L.txns
      .filter((x) => x.acctType === 'depository' && x.amount > 0 && x.date >= addDays(t, -60) && x.date < t && !SKIP_DISCRETIONARY.test(x.category) && !recurringKeys.has(normalizeMerchant(x)))
      .reduce((s, x) => s + x.amount, 0) / 60,
  );
  const cushion = L.settings.cushion;
  let bal = L.checking.reduce((s, a) => s + a.cash, 0);
  let dip: DateStr | null = null;
  let low = Infinity;
  for (let d = t; d < horizon; d = addDays(d, 1)) {
    const incoming = pays.filter((p) => p.date === d).reduce((s, p) => s + p.amount, 0);
    if (dip && incoming > 0) break; // the dip ends at the next paycheck
    bal += incoming;
    bal -= obl.filter((o) => o.date === d).reduce((s, o) => s + o.amount, 0);
    if (d > t) bal -= daily;
    if (bal < cushion) {
      dip ??= d;
      low = Math.min(low, bal);
    }
  }
  if (!dip) return null;
  const shortBy = roundUp10(cushion - low);
  const account = L.checking[0]?.name ?? 'Checking';
  const before = addDays(dip, -1);
  const nextPay = pays.find((p) => p.date > dip);
  const sav = [...L.savings].sort((a, b) => b.cash - a.cash)[0];
  const movable = obl.filter((o) => o.kind !== 'recurring' && o.date <= dip && o.date >= t).sort((a, b) => b.amount - a.amount)[0];
  let fix: string;
  let fixKind: MindOverdraft['fixKind'];
  if (sav && sav.cash >= shortBy) {
    fixKind = 'transfer';
    fix = `Move ${usd0(shortBy)} from ${sav.name} to ${account} by ${dayLabel(before)}.`;
  } else if (movable && nextPay && movable.amount >= shortBy) {
    fixKind = 'move_bill';
    fix = `Ask ${movable.what.replace(/ minimum$/, '')} to move the ${dayLabel(movable.date)} payment to ${dayLabel(addDays(nextPay.date, 1))}, after the ${dayLabel(nextPay.date)} paycheck.`;
  } else if (movable && nextPay) {
    fixKind = 'split';
    fix = `Split ${movable.what}: ${usd(r2(movable.amount - shortBy))} by ${dayLabel(movable.date)}, the other ${usd(shortBy)} after the ${dayLabel(nextPay.date)} paycheck.`;
  } else {
    fixKind = 'call';
    fix = `No savings covers it and nothing due can move — a call to the bank about overdraft protection before ${dayLabel(dip)} is the fix.`;
  }
  return {
    account,
    date: dip,
    low: r2(low),
    shortBy,
    fix,
    fixKind,
    assumptions: [
      'Paychecks land on their usual days at their usual amounts.',
      `Everyday spending from checking continues at ${usd(daily)} a day (the last 60 days' average).`,
      cushion > 0 ? `"Dips" means below your ${usd(cushion)} cushion.` : 'A dip is the balance going below $0.',
    ],
  };
}

function choreography(c: Ctx, pays: Pay[]): MoneyMind['choreography'] {
  const L = c.L;
  const t = L.t;
  if (!pays.length) {
    return { periods: [], moves: [], note: 'No paycheck is detected in the bank and no pay schedule is set — add one on Money to map the month onto it.' };
  }
  const bounds = [t, ...pays.map((p) => p.date).filter((d) => d > t)].slice(0, 5);
  const cash = L.checking.reduce((s, a) => s + a.cash, 0);
  const periods: MindPeriod[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = bounds[i] as DateStr;
    const end = bounds[i + 1] as DateStr;
    const pay = pays.filter((p) => p.date === start).reduce((s, p) => s + p.amount, 0);
    const income = r2(i === 0 ? cash : pay);
    const obl = obligations(c, start, end).map((o) => ({ what: o.what, amount: o.amount, date: o.date }));
    const total = r2(obl.reduce((s, o) => s + o.amount, 0));
    const net = r2(income - total);
    periods.push({ start, end, income, incomeLabel: i === 0 ? 'cash in checking now' : `paycheck ${dayLabel(start)}`, obligations: obl, total, net, tight: net < L.settings.cushion });
  }
  const moves: MindMove[] = [];
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i] as MindPeriod;
    if (!p.tight) continue;
    const later = periods.slice(i + 1).find((q) => !q.tight && q.net - L.settings.cushion > 0);
    if (!later) continue;
    const room = later.net - L.settings.cushion;
    const candidates = obligations(c, p.start, p.end)
      .filter((o) => o.kind !== 'recurring' && o.amount <= room)
      .sort((a, b) => b.amount - a.amount);
    // The smallest move that closes the gap; else the biggest that fits.
    const need = L.settings.cushion - p.net;
    const pick = [...candidates].reverse().find((o) => o.amount >= need) ?? candidates[0];
    if (!pick) continue;
    const to = addDays(later.start, 1);
    moves.push({
      what: pick.what.replace(/ minimum$/, ''),
      from: pick.date,
      to,
      why: `Moving it from ${dayLabel(pick.date)} to ${dayLabel(to)} puts it after the ${dayLabel(later.start)} paycheck — the stretch to ${dayLabel(p.end)} goes from ${usd(p.net)} to ${usd(r2(p.net + pick.amount))}.`,
    });
  }
  return { periods, moves, note: null };
}

/* ---------------- capture checks ---------------- */

interface Group {
  label: string;
  key: string;
  items: Array<{ date: DateStr; amount: number; category: string }>;
}

function groups(L: Loaded): Group[] {
  const m = new Map<string, Group>();
  for (const x of L.txns) {
    if (x.amount <= 0 || x.pending) continue;
    const key = normalizeMerchant(x);
    if (!key) continue;
    const g = m.get(key) ?? { label: x.merchant || x.name, key, items: [] };
    g.items.push({ date: x.date, amount: x.amount, category: x.category });
    m.set(key, g);
  }
  return [...m.values()];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? (s[i] ?? 0) : ((s[i - 1] ?? 0) + (s[i] ?? 0)) / 2;
};

function captureChecks(L: Loaded, subs: Recurring[]): CaptureCheck[] {
  const t = L.t;
  const out: CaptureCheck[] = [];
  for (const i of L.invest) {
    const gap = r2(i.matchMax - i.match);
    if (i.matchMax > 0 && gap > 0) {
      out.push({ key: `match:${i.name}`, kind: 'match', yearly: r2(gap * 12), merchantKey: null, text: `${i.name}: your employer would add up to ${usd(i.matchMax)} a month and adds ${usd(i.match)} now — ${usd(gap)} a month (${usd0(gap * 12)} a year) of match is unclaimed. Usually that means raising your own contribution.` });
    }
  }
  for (const b of L.benefits) {
    const days = daysBetween(t, b.deadline);
    if (b.amount > 0 && days >= 0 && days <= 120) {
      out.push({ key: `benefit:${b.id}:${b.deadline}`, kind: 'benefit', yearly: b.amount, merchantKey: null, text: `${usd(b.amount)} left in ${b.label} — use it by ${dayLabel(b.deadline)} or it's gone (${days} day${days === 1 ? '' : 's'}).` });
    }
  }
  const gs = groups(L);
  for (const mk of L.marks.filter((x) => x.mark === 'cancelled')) {
    const g = gs.find((x) => x.key === mk.merchantKey);
    for (const it of (g?.items ?? []).filter((x) => x.date > mk.markedOn)) {
      out.push({ key: `cancelled:${mk.merchantKey}:${it.date}`, kind: 'cancelled', yearly: null, merchantKey: mk.merchantKey, text: `${mk.label} charged ${usd(it.amount)} on ${dayLabel(it.date)}, after it was marked cancelled on ${dayLabel(mk.markedOn)} — worth a call to stop it and ask for that back.` });
    }
  }
  // Subscriptions nobody has said they still use in 90 days (the bank shows charges, not whether anyone opens it).
  const marked = (key: string): MoneyMark | undefined => L.marks.find((m) => m.merchantKey === key);
  for (const s of subs) {
    const key = normalizeMerchant({ merchant: s.merchant, name: s.merchant });
    const g = gs.find((x) => x.key === key);
    const cat = g?.items[g.items.length - 1]?.category ?? '';
    if (/RENT|UTILITIES|LOAN|INSURANCE|MEDICAL/i.test(cat) || s.amount >= 500) continue;
    const mk = marked(key);
    if (mk && (mk.mark === 'cancelled' || daysBetween(mk.markedOn, t) < 90)) continue;
    out.push({ key: `review:${key}:${t.slice(0, 4)}q${Math.floor((Number(t.slice(5, 7)) - 1) / 3) + 1}`, kind: 'review', yearly: r2(s.monthly * 12), merchantKey: key, text: `Still using ${s.merchant}? ${usd(s.amount)} ${{ weekly: 'a week', biweekly: 'every two weeks', monthly: 'a month', yearly: 'a year' }[s.cadence]} — ${usd0(s.monthly * 12)} a year. Keep it or mark it cancelled.` });
  }
  for (const g of gs) {
    const items = [...g.items].sort((a, b) => (a.date < b.date ? -1 : 1));
    if (items.length < 4) continue;
    const last = items[items.length - 1];
    const prev = items.slice(-6, -1);
    if (!last || daysBetween(last.date, t) > 45) continue;
    const gaps = items.slice(-5).slice(1).map((x, i) => daysBetween(items.slice(-5)[i]?.date ?? x.date, x.date));
    if (!gaps.every((d) => d >= 25 && d <= 35)) continue; // a monthly bill
    const med = median(prev.map((x) => x.amount));
    const stable = prev.every((x) => Math.abs(x.amount - med) <= med * 0.03);
    if (stable && last.amount >= med * 1.03 && last.amount - med >= 0.5) {
      const pct = Math.round((100 * (last.amount - med)) / med);
      out.push({ key: `price:${g.key}:${last.date}`, kind: 'price', yearly: r2((last.amount - med) * 12), merchantKey: g.key, text: `${g.label} went from ${usd(med)} to ${usd(last.amount)} (+${pct}%) on ${dayLabel(last.date)} — ${usd0((last.amount - med) * 12)} a year more.` });
    } else if (!stable && last.amount >= med * 1.25) {
      const pct = Math.round((100 * (last.amount - med)) / med);
      const lo = Math.min(...prev.map((x) => x.amount));
      const hi = Math.max(...prev.map((x) => x.amount));
      out.push({ key: `unusual:${g.key}:${last.date}`, kind: 'unusual', yearly: null, merchantKey: g.key, text: `${g.label} is unusual this time: ${usd(last.amount)} on ${dayLabel(last.date)} is ${pct}% above your usual ${usd(med)} (the ${prev.length} before ranged ${usd(lo)}–${usd(hi)}). A rate change, an estimated meter read or a one-time charge are the usual reasons — the bill itself will say which.` });
    }
  }
  return out;
}

/* ---------------- wins ---------------- */

async function wins(debts: MindDebts, funds: SinkingFund[], wants: MoneyWant[]): Promise<string[]> {
  const t = today();
  const out: string[] = [];
  const { rows } = await pool.query<{ day: DateStr; debt_total: string; debt_free_month: string | null }>(
    'SELECT day::text AS day, debt_total, debt_free_month FROM money_snapshots WHERE day <= $1 ORDER BY day DESC LIMIT 1',
    [addDays(t, -28)],
  );
  const then = rows[0];
  const now = debts.plans.find((p) => p.strategy === (debts.recommended ?? 'avalanche'))?.debtFree ?? null;
  if (then?.debt_free_month && now && now < then.debt_free_month) out.push(`The debt-free date moved closer: ${monthLabel(then.debt_free_month)} → ${monthLabel(now)}.`);
  if (then && N(then.debt_total) - debts.total >= 50) out.push(`Debt is down ${usd0(N(then.debt_total) - debts.total)} since ${dayLabel(then.day)}.`);
  for (const f of funds) if (f.saved >= f.amount) out.push(`${f.name} is fully saved — when it comes, it's already handled.`);
  const letGo = wants.filter((w) => w.decided === 'let_go');
  if (letGo.length) out.push(`${letGo.length} held want${letGo.length === 1 ? '' : 's'} let go this month — ${usd0(letGo.reduce((s, w) => s + w.amount, 0))} still in the account.`);
  return out;
}

/* ---------------- the whole picture ---------------- */

export function requireParentMember(me: HouseholdMember): void {
  if (me.kind !== 'adult') throw new HttpError(403, 'Money is for grown-ups');
}

export async function moneyMind(): Promise<MoneyMind> {
  const L = await load();
  const t = L.t;
  const lite: TxnLite[] = L.txns.filter((x) => x.date >= addDays(t, -120));
  const subs = detectRecurring(lite, 'out', t);
  const income = detectRecurring(lite, 'in', t);
  const depositKeys = new Set(L.txns.filter((x) => x.acctType === 'depository').map((x) => normalizeMerchant(x)));
  const checkingSubs = subs.filter((s) => depositKeys.has(normalizeMerchant({ merchant: s.merchant, name: s.merchant })));
  const debts = debtsOf(L);
  const c: Ctx = { L, subs, income, checkingSubs, debts };
  const { pays, basis } = paydays(L, income, addDays(t, 1), addDays(t, 75));
  const until = pays[0]?.date ?? addDays(t, 14);
  const hasBank = L.checking.length > 0;
  const plan = debtPlan(debts, L.settings.extraPayment);
  const hours = L.syncedAt ? (Date.now() - L.syncedAt.getTime()) / 3_600_000 : 0;
  return {
    source: hasBank ? 'Linked bank accounts + your bills, debts and funds' : 'Your bills, debts and funds',
    asOf: (L.syncedAt ?? new Date()).toISOString(),
    stale: hours > 36 ? `the bank last synced ${Math.round(hours / 24)} days ago` : null,
    safe: hasBank ? safeNow(c, until, basis ?? '14-days', L.funds) : null,
    safeWhyNot: hasBank ? null : 'No checking account is linked, so there is no balance to start from — link the bank on Money.',
    overdraft: hasBank ? overdraft(c, pays) : null,
    choreography: choreography(c, pays),
    debts: plan,
    funds: L.funds,
    wants: L.wants,
    checks: captureChecks(L, subs),
    benefits: L.benefits,
    marks: L.marks,
    wins: await wins(plan, L.funds, L.wants),
    settings: L.settings,
  };
}

/** Today's row (the record wins are measured against). */
export async function snapshot(m: MoneyMind): Promise<void> {
  const free = m.debts.plans.find((p) => p.strategy === (m.debts.recommended ?? 'avalanche'))?.debtFree ?? null;
  await pool.query(
    `INSERT INTO money_snapshots (day, safe, debt_total, debt_free_month, net) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (household_id, day) DO UPDATE SET safe = EXCLUDED.safe, debt_total = EXCLUDED.debt_total, debt_free_month = EXCLUDED.debt_free_month, net = EXCLUDED.net`,
    [today(), m.safe?.amount ?? null, m.debts.total, free, (await netPosition()).net],
  );
}

async function netPosition(): Promise<{ cash: number; invested: number; debt: number; net: number }> {
  const L = await load();
  const invested = r2(L.invest.reduce((s, i) => s + i.balance, 0));
  const debt = r2(debtsOf(L).reduce((s, d) => s + d.balance, 0));
  return { cash: L.cashAll, invested, debt, net: r2(L.cashAll + invested - debt) };
}

/** The money physical: net position, trajectory, the three highest-value moves for next year. */
export async function moneyPhysical(): Promise<MoneyPhysical | null> {
  const m = await moneyMind();
  const pos = await netPosition();
  if (!pos.cash && !pos.invested && !pos.debt && !m.checks.length) return null;
  const { rows } = await pool.query<{ day: DateStr; net: string | null }>('SELECT day::text AS day, net FROM money_snapshots WHERE net IS NOT NULL AND day <= $1 ORDER BY day LIMIT 1', [addDays(today(), -28)]);
  const first = rows[0];
  const trajectory = first
    ? `Net position is ${pos.net >= N(first.net) ? 'up' : 'down'} ${usd0(Math.abs(pos.net - N(first.net)))} since ${dayLabel(first.day)}.`
    : 'This is the first check-up on record — the next one will show the trend.';
  const moves: MoneyPhysical['moves'] = [];
  const av = m.debts.plans.find((p) => p.strategy === 'avalanche');
  const top = [...m.debts.debts].filter((d) => d.balance > 0 && d.apr !== null).sort((a, b) => (b.apr ?? 0) - (a.apr ?? 0))[0];
  if (top && av && av.saved !== null && av.saved > 0) moves.push({ value: av.saved, text: `Send the extra to ${top.name} (${top.apr}% APR) first: the avalanche plan saves ${usd0(av.saved)} in interest against minimums and ends the debt in ${av.debtFree ? monthLabel(av.debtFree) : 'time'}.` });
  if (top && m.debts.extra === 0 && top.apr !== null && top.apr > 0) {
    const plus = debtPlan(m.debts.debts, 100);
    const p = plus.plans.find((x) => x.strategy === 'avalanche');
    const base = m.debts.plans.find((x) => x.strategy === 'minimums');
    if (p?.interest !== null && p?.interest !== undefined && base?.interest !== null && base?.interest !== undefined) moves.push({ value: r2(base.interest - p.interest), text: `$100 a month extra on the debts saves ${usd0(base.interest - p.interest)} in interest and is debt-free by ${p.debtFree ? monthLabel(p.debtFree) : 'a date you can see'}.` });
  }
  for (const ck of m.checks) if (ck.yearly && ck.kind !== 'review') moves.push({ value: ck.yearly, text: ck.text });
  const review = m.checks.filter((x) => x.kind === 'review');
  if (review.length) moves.push({ value: r2(review.reduce((s, x) => s + (x.yearly ?? 0), 0)), text: `Review ${review.length} subscription${review.length === 1 ? '' : 's'} (${usd0(review.reduce((s, x) => s + (x.yearly ?? 0), 0))} a year) — keep what's used, cancel what isn't.` });
  if (m.overdraft) moves.push({ value: 35, text: `Head off the ${dayLabel(m.overdraft.date)} dip: ${m.overdraft.fix}` });
  const gaps = m.funds.filter((f) => f.saved < f.amount);
  if (!m.funds.length) moves.push({ value: null, text: 'Turn the irregular costs (insurance premiums, holidays, car repairs) into sinking funds, so they stop arriving as surprises.' });
  else if (gaps.length) moves.push({ value: null, text: `Keep setting aside ${usd(gaps.reduce((s, f) => s + f.monthly, 0))} a month across ${gaps.length} sinking fund${gaps.length === 1 ? '' : 's'}.` });
  moves.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  return { asOf: today(), cash: pos.cash, invested: pos.invested, debt: pos.debt, net: pos.net, trajectory, moves: moves.slice(0, 3) };
}

/** Plain lines for Hana (her money tool) — the numbers with the math shown, no account numbers. */
export function mindLines(m: MoneyMind): string[] {
  const out: string[] = [];
  if (m.safe) {
    out.push(`Safe to spend: ${usd(m.safe.amount)} until ${dayLabel(m.safe.until)} (${m.safe.basis === 'paycheck' ? 'next paycheck' : m.safe.basis === 'pay schedule' ? 'next payday on your schedule' : 'no payday known; 14 days'}). ${m.safe.pace.text}`);
    out.push(`  Math: ${usd(m.safe.cash)} in checking − ${usd(m.safe.committedTotal)} committed = ${usd(m.safe.amount)}.`);
    for (const x of m.safe.committed) out.push(`  − ${x.what} ${usd(x.amount)}${x.kind === 'reserve' ? ' (sinking-fund reserve for this stretch)' : ` on ${dayLabel(x.date)}`}`);
  } else if (m.safeWhyNot) out.push(m.safeWhyNot);
  if (m.overdraft) out.push(`Overdraft ahead: ${m.overdraft.account} dips to ${usd(m.overdraft.low)} on ${dayLabel(m.overdraft.date)}. Prepared fix (you do it): ${m.overdraft.fix} Assumes: ${m.overdraft.assumptions.join(' ')}`);
  for (const p of m.choreography.periods.filter((x) => x.tight)) out.push(`Tight stretch ${dayLabel(p.start)}–${dayLabel(p.end)}: ${usd(p.income)} (${p.incomeLabel}) − ${usd(p.total)} due = ${usd(p.net)}.`);
  for (const mv of m.choreography.moves) out.push(`Drafted move: ${mv.what} — ${mv.why}`);
  if (m.debts.debts.length) {
    out.push(`Debts: ${usd(m.debts.total)} total, ${usd(m.debts.minimums)} a month in minimums.`);
    for (const d of m.debts.debts) out.push(`  ${d.name}: ${usd(d.balance)}${d.apr !== null ? ` at ${d.apr}% APR` : ' (APR not entered)'}, minimum ${usd(d.minimum)}${d.nextDue ? ` due ${dayLabel(d.nextDue)}` : ''}${d.utilization !== null ? `, ${d.utilization}% of limit` : ''}`);
    for (const p of m.debts.plans) out.push(`  ${p.strategy}: ${p.months === null ? 'never finishes at these payments' : `${p.months} months, debt-free ${p.debtFree}, ${usd(p.interest ?? 0)} interest${p.saved ? ` (${usd(p.saved)} less than minimums)` : ''}`}${p.order.length ? `; order ${p.order.join(' → ')}` : ''}`);
    if (m.debts.why) out.push(`  ${m.debts.why}`);
    out.push(`  Assumptions: ${m.debts.assumptions.join(' ')}`);
    for (const w of m.debts.warnings) out.push(`  ${w}`);
  }
  for (const f of m.funds) out.push(`Sinking fund ${f.name}: ${usd(f.saved)} of ${usd(f.amount)} by ${dayLabel(f.dueOn)} — ${usd(f.monthly)} a month.`);
  for (const w of m.wants.filter((x) => !x.decided)) out.push(`On the 24-hour list: ${w.what} (${usd(w.amount)})${w.ready ? ' — the day is up' : ''}.`);
  for (const ck of m.checks) out.push(`Check: ${ck.text}`);
  for (const w of m.wins) out.push(`Win: ${w}`);
  return out;
}

/** A payment a parent makes (Hana prepares it as a loop): a bill not on autopay, or a debt minimum. */
export interface DuePayment {
  ref: string;
  what: string;
  amount: number;
  date: DateStr;
  owner: string | null;
  from: string | null;
  paid: { date: DateStr; amount: number } | null;
}

/** Payments due from 3 days ago through `days` ahead — with the bank's evidence when one already posted. */
export async function paymentsDue(days = 7): Promise<DuePayment[]> {
  const L = await load();
  const from = addDays(L.t, -3);
  const until = addDays(L.t, days + 1);
  const acct = L.checking[0]?.name ?? null;
  const out: DuePayment[] = [];
  for (const b of L.bills) {
    if (b.autopay || b.dueDay === null) continue;
    for (const date of monthlyDates(b.dueDay, from, until)) out.push({ ref: `money:bill:${b.id}:${date}`, what: b.name, amount: b.amount, date, owner: b.owner, from: acct, paid: paidFor(L, b.name, b.amount, date) });
  }
  for (const d of debtsOf(L)) {
    if (d.id === null || d.autopay || !d.dueDay || d.minimum <= 0) continue;
    for (const date of monthlyDates(d.dueDay, from, until)) out.push({ ref: `money:min:${d.id}:${date}`, what: `${d.name} minimum`, amount: d.minimum, date, owner: null, from: acct, paid: paidFor(L, d.name, d.minimum, date) });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
