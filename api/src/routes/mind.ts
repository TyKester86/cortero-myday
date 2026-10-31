/**
 * Q6: the Financial Mind on Money (grown-ups only). Everything here describes, models or
 * prepares — nothing moves money.
 *
 * GET    /api/money/mind                 — safe-to-spend + pace, overdraft, choreography, debts, funds, checks, wins
 * PUT    /api/money/settings             — wait-list threshold, extra debt payment, cushion, pay schedule
 * POST   /api/money/debts, PUT/DELETE /api/money/debts/:id
 * GET    /api/money/payoff?extra=        — avalanche vs snowball at another extra amount (the live model)
 * POST   /api/money/funds, PUT/DELETE /api/money/funds/:id
 * POST   /api/money/wants, POST /api/money/wants/:id/decide   — the 24-hour list
 * PUT    /api/money/marks                — "cancelled" / "keep" on a recurring charge
 * POST   /api/money/benefits, DELETE /api/money/benefits/:id
 * GET    /api/money/physical             — the money physical
 */
import { Router } from 'express';
import type { DateStr } from '@myday/shared';
import { pool } from '../db.js';
import { bool, HttpError, idParam, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { normalizeMerchant } from '../lib/money/analyze.js';
import { debtPlan, moneyMind, moneyPhysical, moneySettings } from '../lib/money/mind.js';
import { today } from '../lib/dates.js';

export const mindRouter = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function amt(v: unknown, field: string, { max = 10_000_000, nullable = false } = {}): number | null {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,%\s]/g, '')) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} must be an amount`);
  return Math.round(n * 100) / 100;
}
const amount = (v: unknown, field: string, max?: number): number => amt(v, field, { max }) as number;
function day(v: unknown, field: string, nullable = false): DateStr | null {
  if (nullable && (v === null || v === undefined || v === '')) return null;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, `${field} is a date (YYYY-MM-DD)`);
  return v as DateStr;
}
function dueDay(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new HttpError(400, 'Due day is 1–31');
  return n;
}

mindRouter.get('/api/money/mind', async (req, res) => {
  requireAdult(req);
  res.json(await moneyMind());
});

mindRouter.put('/api/money/settings', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const cur = await moneySettings();
  const cadence = b.payCadence === undefined ? cur.payCadence : b.payCadence === null || b.payCadence === '' ? null : b.payCadence;
  if (cadence !== null && !['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(String(cadence))) throw new HttpError(400, 'Pay cadence is weekly, biweekly, semimonthly or monthly');
  const next = {
    want: b.wantThreshold === undefined ? cur.wantThreshold : amount(b.wantThreshold, 'wantThreshold', 100_000),
    extra: b.extraPayment === undefined ? cur.extraPayment : amount(b.extraPayment, 'extraPayment', 1_000_000),
    cushion: b.cushion === undefined ? cur.cushion : amount(b.cushion, 'cushion', 1_000_000),
    anchor: b.payAnchor === undefined ? cur.payAnchor : day(b.payAnchor, 'payAnchor', true),
    pay: b.payAmount === undefined ? cur.payAmount : amt(b.payAmount, 'payAmount', { max: 10_000_000, nullable: true }),
  };
  await pool.query(
    `INSERT INTO money_settings (want_threshold, extra_payment, cushion, pay_anchor, pay_cadence, pay_amount, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (household_id) DO UPDATE SET want_threshold = EXCLUDED.want_threshold, extra_payment = EXCLUDED.extra_payment, cushion = EXCLUDED.cushion,
       pay_anchor = EXCLUDED.pay_anchor, pay_cadence = EXCLUDED.pay_cadence, pay_amount = EXCLUDED.pay_amount, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [next.want, next.extra, next.cushion, next.anchor, cadence, next.pay, me.id, new Date()],
  );
  res.json(await moneyMind());
});

const DEBT_KINDS = ['credit_card', 'auto', 'student', 'mortgage', 'personal', 'medical', 'other'];

async function saveDebt(memberId: number, id: number | null, b: Record<string, unknown>): Promise<void> {
  const kind = typeof b.kind === 'string' && DEBT_KINDS.includes(b.kind) ? b.kind : 'other';
  let account: number | null = null;
  if (b.accountId !== undefined && b.accountId !== null && b.accountId !== '') {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT a.id FROM money_accounts a JOIN money_items i ON i.id = a.item_id WHERE a.id = $1 AND a.type = 'credit' AND i.member_id IS NULL",
      [idParam(b.accountId)],
    );
    if (!rows[0]) throw new HttpError(404, 'No such linked card');
    account = rows[0].id;
  }
  const vals = [
    str(b.name, 'name', 60, true),
    kind,
    amount(b.balance ?? 0, 'balance'),
    amt(b.apr, 'apr', { max: 100, nullable: true }),
    amount(b.minimum ?? 0, 'minimum', 1_000_000),
    dueDay(b.dueDay),
    amt(b.limit, 'limit', { nullable: true }) || null,
    account,
    b.autopay === undefined ? false : bool(b.autopay, 'autopay'),
  ];
  if (id === null) {
    await pool.query('INSERT INTO debts (name, kind, balance, apr, minimum, due_day, credit_limit, account_id, autopay, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [...vals, memberId]);
  } else {
    const r = await pool.query('UPDATE debts SET name = $2, kind = $3, balance = $4, apr = $5, minimum = $6, due_day = $7, credit_limit = $8, account_id = $9, autopay = $10 WHERE id = $1', [id, ...vals]);
    if (!r.rowCount) throw new HttpError(404, 'No such debt');
  }
}

mindRouter.post('/api/money/debts', async (req, res) => {
  const me = requireAdult(req);
  await saveDebt(me.id, null, req.body as Record<string, unknown>);
  res.status(201).json(await moneyMind());
});

mindRouter.put('/api/money/debts/:id', async (req, res) => {
  const me = requireAdult(req);
  await saveDebt(me.id, idParam(req.params.id), req.body as Record<string, unknown>);
  res.json(await moneyMind());
});

mindRouter.delete('/api/money/debts/:id', async (req, res) => {
  requireAdult(req);
  const r = await pool.query('DELETE FROM debts WHERE id = $1', [idParam(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'No such debt');
  res.json(await moneyMind());
});

/** "What if we put $X extra a month toward it?" — the plan, modeled live. */
mindRouter.get('/api/money/payoff', async (req, res) => {
  requireAdult(req);
  const extra = amount(req.query.extra ?? 0, 'extra', 1_000_000);
  res.json(debtPlan((await moneyMind()).debts.debts, extra));
});

async function saveFund(memberId: number, id: number | null, b: Record<string, unknown>): Promise<void> {
  const vals = [str(b.name, 'name', 60, true), amount(b.amount, 'amount'), day(b.dueOn, 'dueOn'), amount(b.saved ?? 0, 'saved'), b.yearly === undefined ? true : bool(b.yearly, 'yearly')];
  if ((vals[1] as number) <= 0) throw new HttpError(400, 'amount must be more than $0');
  if (id === null) await pool.query('INSERT INTO sinking_funds (name, amount, due_on, saved, yearly, created_by) VALUES ($1, $2, $3, $4, $5, $6)', [...vals, memberId]);
  else {
    const r = await pool.query('UPDATE sinking_funds SET name = $2, amount = $3, due_on = $4, saved = $5, yearly = $6 WHERE id = $1', [id, ...vals]);
    if (!r.rowCount) throw new HttpError(404, 'No such fund');
  }
}

mindRouter.post('/api/money/funds', async (req, res) => {
  const me = requireAdult(req);
  await saveFund(me.id, null, req.body as Record<string, unknown>);
  res.status(201).json(await moneyMind());
});

mindRouter.put('/api/money/funds/:id', async (req, res) => {
  const me = requireAdult(req);
  await saveFund(me.id, idParam(req.params.id), req.body as Record<string, unknown>);
  res.json(await moneyMind());
});

mindRouter.delete('/api/money/funds/:id', async (req, res) => {
  requireAdult(req);
  const r = await pool.query('DELETE FROM sinking_funds WHERE id = $1', [idParam(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'No such fund');
  res.json(await moneyMind());
});

/** Hold a want for a day. Nothing is blocked; everything is remembered. */
export async function holdWant(memberId: number, what: unknown, amountIn: unknown): Promise<void> {
  const a = amount(amountIn, 'amount', 1_000_000);
  if (a <= 0) throw new HttpError(400, 'amount must be more than $0');
  await pool.query('INSERT INTO money_wants (member_id, what, amount, added_at) VALUES ($1, $2, $3, $4)', [memberId, str(what, 'what', 120, true), a, new Date()]);
}

mindRouter.post('/api/money/wants', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  await holdWant(me.id, b.what, b.amount);
  res.status(201).json(await moneyMind());
});

mindRouter.post('/api/money/wants/:id/decide', async (req, res) => {
  requireAdult(req);
  const d = (req.body as { decided?: unknown }).decided;
  if (d !== 'bought' && d !== 'let_go') throw new HttpError(400, 'decided is bought or let_go');
  const r = await pool.query('UPDATE money_wants SET decided = $2, decided_at = $3 WHERE id = $1 AND decided IS NULL', [idParam(req.params.id), d, new Date()]);
  if (!r.rowCount) throw new HttpError(404, 'Not on the list');
  res.json(await moneyMind());
});

mindRouter.put('/api/money/marks', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const label = str(b.merchant, 'merchant', 80, true);
  const key = typeof b.merchantKey === 'string' && b.merchantKey ? b.merchantKey.slice(0, 80) : normalizeMerchant({ merchant: label, name: label });
  if (b.mark === null) {
    await pool.query('DELETE FROM money_marks WHERE merchant_key = $1', [key]);
  } else {
    if (b.mark !== 'cancelled' && b.mark !== 'keep') throw new HttpError(400, 'mark is cancelled or keep');
    await pool.query(
      `INSERT INTO money_marks (merchant_key, label, mark, marked_on, marked_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (household_id, merchant_key) DO UPDATE SET label = EXCLUDED.label, mark = EXCLUDED.mark, marked_on = EXCLUDED.marked_on, marked_by = EXCLUDED.marked_by`,
      [key, label, b.mark, today(), me.id],
    );
  }
  res.json(await moneyMind());
});

mindRouter.post('/api/money/benefits', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const kind = typeof b.kind === 'string' && ['fsa', 'dependent_care_fsa', 'hsa', 'other'].includes(b.kind) ? b.kind : 'other';
  await pool.query('INSERT INTO money_benefits (kind, label, amount, deadline, created_by) VALUES ($1, $2, $3, $4, $5)', [kind, str(b.label, 'label', 60, true), amount(b.amount, 'amount'), day(b.deadline, 'deadline'), me.id]);
  res.status(201).json(await moneyMind());
});

mindRouter.delete('/api/money/benefits/:id', async (req, res) => {
  requireAdult(req);
  const r = await pool.query('DELETE FROM money_benefits WHERE id = $1', [idParam(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Not found');
  res.json(await moneyMind());
});

mindRouter.get('/api/money/physical', async (req, res) => {
  requireAdult(req);
  res.json({ physical: await moneyPhysical() });
});
