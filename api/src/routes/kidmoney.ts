/**
 * Kid & teen money: one big "spendable" number, the allowance (parent-set,
 * paid automatically on its weekday), a ledger, spending by category, and
 * savings goals. Teens can see a real bank account read-only, linked and
 * revoked by a parent, and only when the household allows it.
 *
 * MyDay never moves a minor's money: everything here is record-keeping, and
 * the bank link is read-only.
 */
import { Router, type Request } from 'express';
import {
  WEEKDAYS,
  type DateStr,
  type HouseholdMember,
  type KidMoneyResponse,
  type LedgerEntry,
  type LedgerKind,
  type LinkTokenResponse,
  type SavingsGoal,
} from '@myday/shared';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, isoWeekday, today } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { memberByKey, self } from '../lib/members.js';
import { encryptToken, moneyProvider } from '../lib/money/provider.js';
import { registerJob } from '../lib/schedulers.js';
import { moneyView, revokeItem, syncItem } from './money.js';

export const kidMoneyRouter = Router();

export const TEEN_AGE = 13;
const IN_KINDS: LedgerKind[] = ['allowance', 'cash', 'gift', 'earned'];
const PARENT_KINDS: LedgerKind[] = ['allowance', 'cash', 'gift', 'earned', 'spend'];
export const SPEND_CATEGORIES = ['Food & snacks', 'Games & apps', 'Clothes', 'Fun & outings', 'Gifts', 'School', 'Other'];

function amountOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 10_000) throw new HttpError(400, 'Enter an amount');
  return Math.round(n * 100) / 100;
}

/** Whose money: a kid sees their own; grown-ups pick a kid with ?member=key or :key. */
async function whose(req: Request, key?: string): Promise<{ me: HouseholdMember; kid: HouseholdMember; canManage: boolean }> {
  const me = self(req);
  const k = key ?? (typeof req.query.member === 'string' ? req.query.member : '');
  if (me.kind === 'kid') {
    if (k && k !== me.key) throw new HttpError(403, 'You can only see your own money');
    return { me, kid: me, canManage: false };
  }
  if (!k) throw new HttpError(400, 'Pick a kid');
  const kid = await memberByKey(k);
  if (!kid || kid.kind !== 'kid') throw new HttpError(404, 'No such kid');
  return { me, kid, canManage: true };
}

/** Pay any allowance due since the last payout (at most 4 weeks back). */
export async function payAllowance(memberId: number, t: DateStr = today()): Promise<number> {
  const { rows } = await pool.query<{ amount: string; weekday: number; last_paid: DateStr | null }>(
    'SELECT amount, weekday, last_paid::text AS last_paid FROM allowances WHERE member_id = $1',
    [memberId],
  );
  const a = rows[0];
  if (!a) return 0;
  // The most recent payday on or before today.
  let pay = addDays(t, -((isoWeekday(t) - a.weekday + 7) % 7));
  const due: DateStr[] = [];
  for (let i = 0; i < 4 && (!a.last_paid || pay > a.last_paid); i++) {
    due.push(pay);
    pay = addDays(pay, -7);
  }
  // A brand-new allowance starts with the next payday, not back pay.
  if (!a.last_paid) due.splice(1);
  for (const d of due.reverse()) {
    await pool.query("INSERT INTO kid_ledger (member_id, day, amount, kind, note) VALUES ($1, $2, $3, 'allowance', 'Weekly allowance')", [memberId, d, a.amount]);
  }
  if (due.length) await pool.query('UPDATE allowances SET last_paid = $2 WHERE member_id = $1', [memberId, due[due.length - 1]]);
  return due.length;
}

async function teenBankAllowed(): Promise<boolean> {
  const { rows } = await pool.query<{ ok: boolean }>("SELECT allow_teen_bank_link AS ok FROM households WHERE id = NULLIF(current_setting('app.household_id', true), '')::int");
  return rows[0]?.ok === true;
}

async function kidMoney(kid: HouseholdMember, canManage: boolean): Promise<KidMoneyResponse> {
  await payAllowance(kid.id);
  const t = today();
  const { rows: l } = await pool.query<{ id: number; day: DateStr; amount: string; kind: LedgerKind; category: string; note: string; goal_id: number | null }>(
    'SELECT id, day::text AS day, amount, kind, category, note, goal_id FROM kid_ledger WHERE member_id = $1 ORDER BY day DESC, id DESC',
    [kid.id],
  );
  const { rows: g } = await pool.query<{ id: number; name: string; target: string; done: boolean }>(
    'SELECT id, name, target, done FROM savings_goals WHERE member_id = $1 ORDER BY done, id',
    [kid.id],
  );
  const { rows: al } = await pool.query<{ amount: string; weekday: number; last_paid: DateStr | null }>(
    'SELECT amount, weekday, last_paid::text AS last_paid FROM allowances WHERE member_id = $1',
    [kid.id],
  );
  let spendable = 0;
  const saved = new Map<number, number>();
  const cats = new Map<string, number>();
  for (const e of l) {
    const amt = Number(e.amount);
    if (IN_KINDS.includes(e.kind)) spendable += amt;
    else if (e.kind === 'spend') {
      spendable -= amt;
      if (e.day >= addDays(t, -30)) cats.set(e.category || 'Other', (cats.get(e.category || 'Other') ?? 0) + amt);
    } else if (e.goal_id !== null) {
      const sign = e.kind === 'to_goal' ? 1 : -1;
      spendable -= sign * amt;
      saved.set(e.goal_id, (saved.get(e.goal_id) ?? 0) + sign * amt);
    }
  }
  const isTeen = (kid.age ?? 0) >= TEEN_AGE;
  const allowed = await teenBankAllowed();
  let bank: KidMoneyResponse['bank'] = null;
  if (isTeen) {
    const v = await moneyView(kid.id);
    if (v.items.length) bank = { institution: v.items[0]?.institution ?? 'Bank', accounts: v.accounts, recent: v.transactions.slice(0, 15) };
  }
  const goals = g.map((x): SavingsGoal => {
    const s = Math.round((saved.get(x.id) ?? 0) * 100) / 100;
    const target = Number(x.target);
    return { id: x.id, name: x.name, target, saved: s, pct: Math.min(100, Math.round((s / target) * 100)), done: x.done };
  });
  const a = al[0];
  return {
    member: kid,
    spendable: Math.round(spendable * 100) / 100,
    allowance: a ? { amount: Number(a.amount), weekday: WEEKDAYS[a.weekday - 1] ?? 'Sat', lastPaid: a.last_paid } : null,
    ledger: l.slice(0, 60).map((e): LedgerEntry => ({ id: e.id, date: e.day, amount: Number(e.amount), kind: e.kind, category: e.category, note: e.note })),
    goals,
    categories: [...cats].map(([category, spent]) => ({ category, spent: Math.round(spent * 100) / 100 })).sort((x, y) => y.spent - x.spent),
    isTeen,
    bank,
    bankLinkAllowed: isTeen && allowed,
    canManage,
  };
}

kidMoneyRouter.get('/api/kidmoney', async (req, res) => {
  const { kid, canManage } = await whose(req);
  res.json(await kidMoney(kid, canManage));
});

/** Grown-ups add money in (or record spending); kids record their own spending. */
kidMoneyRouter.post('/api/kidmoney/entries', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const { me, kid, canManage } = await whose(req, typeof b.member === 'string' ? b.member : undefined);
  const kind = (canManage ? PARENT_KINDS : (['spend'] as LedgerKind[])).find((k) => k === b.kind);
  if (!kind) throw new HttpError(canManage ? 400 : 403, canManage ? 'Pick what kind of money this is' : 'Ask a grown-up to add money');
  const amount = amountOf(b.amount);
  if (kind === 'spend') {
    const now = await kidMoney(kid, canManage);
    if (amount > now.spendable) throw new HttpError(409, `That's more than the $${now.spendable.toFixed(2)} you can spend`);
  }
  const category = kind === 'spend' ? SPEND_CATEGORIES.find((c) => c === b.category) ?? 'Other' : '';
  await pool.query('INSERT INTO kid_ledger (member_id, day, amount, kind, category, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    kid.id, today(), amount, kind, category, str(b.note, 'note', 80), me.id,
  ]);
  res.status(201).json(await kidMoney(kid, canManage));
});

kidMoneyRouter.delete('/api/kidmoney/entries/:id', async (req, res) => {
  const { kid, canManage } = await whose(req);
  if (!canManage) throw new HttpError(403, 'Ask a grown-up to fix an entry');
  const r = await pool.query("DELETE FROM kid_ledger WHERE id = $1 AND member_id = $2 AND kind NOT IN ('to_goal', 'from_goal')", [idParam(req.params.id), kid.id]);
  if (!r.rowCount) throw new HttpError(404, 'No such entry');
  res.json(await kidMoney(kid, canManage));
});

kidMoneyRouter.put('/api/kidmoney/allowance', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const { kid, canManage } = await whose(req, typeof b.member === 'string' ? b.member : undefined);
  if (!canManage) throw new HttpError(403, 'Only grown-ups set the allowance');
  if (b.amount === null || b.amount === 0 || b.amount === '0') {
    await pool.query('DELETE FROM allowances WHERE member_id = $1', [kid.id]);
  } else {
    const wd = WEEKDAYS.indexOf(b.weekday as (typeof WEEKDAYS)[number]);
    if (wd < 0) throw new HttpError(400, 'Pick a payday');
    await pool.query(
      `INSERT INTO allowances (member_id, amount, weekday) VALUES ($1, $2, $3)
       ON CONFLICT (member_id) DO UPDATE SET amount = EXCLUDED.amount, weekday = EXCLUDED.weekday`,
      [kid.id, amountOf(b.amount), wd + 1],
    );
  }
  res.json(await kidMoney(kid, canManage));
});

kidMoneyRouter.post('/api/kidmoney/goals', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const { kid, canManage } = await whose(req, typeof b.member === 'string' ? b.member : undefined);
  await pool.query('INSERT INTO savings_goals (member_id, name, target) VALUES ($1, $2, $3)', [kid.id, str(b.name, 'name', 40, true), amountOf(b.target)]);
  res.status(201).json(await kidMoney(kid, canManage));
});

/** Move money into (or back out of) a goal. Reaching the target marks it done. */
kidMoneyRouter.post('/api/kidmoney/goals/:id/move', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const { kid, canManage } = await whose(req, typeof b.member === 'string' ? b.member : undefined);
  const id = idParam(req.params.id);
  const now = await kidMoney(kid, canManage);
  const goal = now.goals.find((g) => g.id === id);
  if (!goal) throw new HttpError(404, 'No such goal');
  const amount = amountOf(b.amount);
  const toGoal = b.direction !== 'out';
  if (toGoal && amount > now.spendable) throw new HttpError(409, `You have $${now.spendable.toFixed(2)} to put in`);
  if (!toGoal && amount > goal.saved) throw new HttpError(409, `That goal has $${goal.saved.toFixed(2)} in it`);
  await pool.query('INSERT INTO kid_ledger (member_id, day, amount, kind, goal_id, note) VALUES ($1, $2, $3, $4, $5, $6)', [
    kid.id, today(), amount, toGoal ? 'to_goal' : 'from_goal', id, goal.name,
  ]);
  await pool.query('UPDATE savings_goals SET done = ($2 >= target) WHERE id = $1', [id, goal.saved + (toGoal ? amount : -amount)]);
  res.json(await kidMoney(kid, canManage));
});

/** Remove a goal; anything saved in it goes back to spendable. */
kidMoneyRouter.delete('/api/kidmoney/goals/:id', async (req, res) => {
  const { kid, canManage } = await whose(req);
  const id = idParam(req.params.id);
  const now = await kidMoney(kid, canManage);
  const goal = now.goals.find((g) => g.id === id);
  if (!goal) throw new HttpError(404, 'No such goal');
  // Dropping the goal's moves puts what it held back into spendable.
  await pool.query('DELETE FROM kid_ledger WHERE member_id = $1 AND goal_id = $2', [kid.id, id]);
  await pool.query('DELETE FROM savings_goals WHERE id = $1', [id]);
  res.json(await kidMoney(kid, canManage));
});

/* ---------- teen read-only bank link: the parent does it, behind the household gate ---------- */

async function teenFor(req: Request): Promise<HouseholdMember> {
  const { kid, canManage } = await whose(req, String(req.params.key));
  if (!canManage) throw new HttpError(403, 'A parent links (and unlinks) the bank');
  if ((kid.age ?? 0) < TEEN_AGE) throw new HttpError(409, 'Bank links are for teens (13+)');
  if (!(await teenBankAllowed())) throw new HttpError(409, 'Turn on “Teens can see a bank account” in Household settings first');
  return kid;
}

kidMoneyRouter.post('/api/kidmoney/:key/bank/link-token', async (req, res) => {
  const kid = await teenFor(req);
  const p = moneyProvider();
  if (!p) throw new HttpError(503, 'Money is not set up on this server yet');
  const out: LinkTokenResponse = { provider: p.kind, linkToken: await p.createLinkToken(`teen-${kid.id}`) };
  res.json(out);
});

kidMoneyRouter.post('/api/kidmoney/:key/bank/exchange', async (req, res) => {
  const kid = await teenFor(req);
  const me = self(req);
  const p = moneyProvider();
  if (!p) throw new HttpError(503, 'Money is not set up on this server yet');
  const b = req.body as Record<string, unknown>;
  const { accessToken, itemId } = await p.exchange(str(b.publicToken, 'publicToken', 300, true));
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO money_items (provider, item_id, access_token_enc, institution, linked_by, member_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_id) DO UPDATE SET access_token_enc = EXCLUDED.access_token_enc RETURNING id`,
    [p.kind, itemId, encryptToken(accessToken), str(b.institution, 'institution', 80) || 'Bank', me.id, kid.id],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('item insert returned nothing');
  await syncItem(p, id, accessToken);
  await logEvent('bank_linked', { teen: true }, kid.id);
  res.status(201).json(await kidMoney(kid, true));
});

kidMoneyRouter.delete('/api/kidmoney/:key/bank', async (req, res) => {
  const { kid, canManage } = await whose(req, String(req.params.key));
  if (!canManage) throw new HttpError(403, 'A parent unlinks the bank');
  const { rows } = await pool.query<{ id: number; access_token_enc: string; provider: string }>(
    'SELECT id, access_token_enc, provider FROM money_items WHERE member_id = $1',
    [kid.id],
  );
  for (const r of rows) await revokeItem(r.id, r);
  res.json(await kidMoney(kid, true));
});

kidMoneyRouter.get('/api/kidmoney/categories', (_req, res) => {
  res.json({ categories: SPEND_CATEGORIES });
});

/** Pay allowances in every household, hourly (also paid lazily on view). */
registerJob({
  name: 'allowances',
  everyMs: 60 * 60 * 1000,
  run: async () => {
    const due = await asSystem(() => pool.query<{ member_id: number; household_id: number }>('SELECT member_id, household_id FROM allowances'));
    for (const a of due.rows) await inHousehold(a.household_id, () => payAllowance(a.member_id).then(() => undefined));
  },
});
