/**
 * Manual money, restored from the script: bills (with autopay → the
 * "autopilot" %), income, what's left each month, and the money check-in
 * ("I looked" + how anxious money feels). Works with no bank linked at all.
 */
import { Router } from 'express';
import type { Bill, BillsResponse, DateStr, IncomeSource } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { bool, HttpError, idParam, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { awardXpOnce } from '../lib/xp.js';

export const billsRouter = Router();

function money(v: unknown, field: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, `${field} must be an amount`);
  return Math.round(n * 100) / 100;
}

/** The date a bill with a day-of-month falls on in a given month (clamped to month end). */
function dueIn(month: string, day: number): DateStr {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export async function billsFor(memberId: number): Promise<BillsResponse> {
  const t = today();
  const { rows: b } = await pool.query<{ id: number; name: string; amount: string; due_day: number | null; autopay: boolean }>(
    'SELECT id, name, amount, due_day, autopay FROM bills WHERE member_id = $1 ORDER BY due_day NULLS LAST, id',
    [memberId],
  );
  const { rows: i } = await pool.query<{ id: number; source: string; amount: string }>('SELECT id, source, amount FROM income_sources WHERE member_id = $1 ORDER BY id', [memberId]);
  const { rows: c } = await pool.query<{ day: DateStr; anxiety: string; looked: boolean }>(
    'SELECT day::text AS day, anxiety, looked FROM money_checkins WHERE member_id = $1 ORDER BY day DESC, id DESC LIMIT 1',
    [memberId],
  );
  const bills = b.map((x): Bill => ({ id: x.id, name: x.name, amount: Number(x.amount), dueDay: x.due_day, autopay: x.autopay }));
  const income = i.map((x): IncomeSource => ({ id: x.id, source: x.source, amount: Number(x.amount) }));
  const totalBills = bills.reduce((s, x) => s + x.amount, 0);
  const totalIncome = income.reduce((s, x) => s + x.amount, 0);
  const horizon = addDays(t, 7);
  const dueSoon: BillsResponse['dueSoon'] = [];
  for (const x of bills) {
    if (x.dueDay === null) continue;
    for (const month of [t.slice(0, 7), horizon.slice(0, 7)]) {
      const d = dueIn(month, x.dueDay);
      if (d >= t && d <= horizon && !dueSoon.some((s) => s.name === x.name && s.date === d)) dueSoon.push({ name: x.name, amount: x.amount, date: d });
    }
  }
  dueSoon.sort((a, z) => a.date.localeCompare(z.date));
  const last = c[0];
  return {
    bills,
    income,
    totalBills: Math.round(totalBills * 100) / 100,
    totalIncome: Math.round(totalIncome * 100) / 100,
    left: Math.round((totalIncome - totalBills) * 100) / 100,
    autopilot: bills.length ? Math.round((100 * bills.filter((x) => x.autopay).length) / bills.length) : 0,
    lastCheck: last ? { date: last.day, anxiety: last.anxiety, looked: last.looked } : null,
    dueSoon,
  };
}

billsRouter.get('/api/bills', async (req, res) => {
  res.json(await billsFor(requireAdult(req).id));
});

billsRouter.post('/api/bills', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const dueDay = b.dueDay === null || b.dueDay === undefined || b.dueDay === '' ? null : Number(b.dueDay);
  if (dueDay !== null && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) throw new HttpError(400, 'Due day is 1–31');
  await pool.query('INSERT INTO bills (member_id, name, amount, due_day, autopay) VALUES ($1, $2, $3, $4, $5)', [
    me.id, str(b.name, 'name', 60, true), money(b.amount, 'amount'), dueDay, b.autopay === true,
  ]);
  res.status(201).json(await billsFor(me.id));
});

billsRouter.patch('/api/bills/:id', async (req, res) => {
  const me = requireAdult(req);
  const r = await pool.query('UPDATE bills SET autopay = $3 WHERE id = $1 AND member_id = $2', [
    idParam(req.params.id), me.id, bool((req.body as { autopay?: unknown }).autopay, 'autopay'),
  ]);
  if (!r.rowCount) throw new HttpError(404, 'No such bill');
  res.json(await billsFor(me.id));
});

billsRouter.delete('/api/bills/:id', async (req, res) => {
  const me = requireAdult(req);
  const r = await pool.query('DELETE FROM bills WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id]);
  if (!r.rowCount) throw new HttpError(404, 'No such bill');
  res.json(await billsFor(me.id));
});

billsRouter.post('/api/income', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  await pool.query('INSERT INTO income_sources (member_id, source, amount) VALUES ($1, $2, $3)', [me.id, str(b.source, 'source', 60, true), money(b.amount, 'amount')]);
  res.status(201).json(await billsFor(me.id));
});

billsRouter.delete('/api/income/:id', async (req, res) => {
  const me = requireAdult(req);
  const r = await pool.query('DELETE FROM income_sources WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id]);
  if (!r.rowCount) throw new HttpError(404, 'No such income');
  res.json(await billsFor(me.id));
});

/** "I looked." Logging it at all is the win — 5 XP once a day. */
billsRouter.post('/api/money/checkin', async (req, res) => {
  const me = requireAdult(req);
  const anxiety = (req.body as { anxiety?: unknown }).anxiety;
  if (anxiety !== 'Low' && anxiety !== 'Medium' && anxiety !== 'High') throw new HttpError(400, 'anxiety is Low, Medium or High');
  const t = today();
  await pool.query('INSERT INTO money_checkins (member_id, day, anxiety, looked) VALUES ($1, $2, $3, true)', [me.id, t, anxiety]);
  await awardXpOnce(me.id, t, 5, 'Money check-in', `moneycheck:${t}`);
  res.status(201).json(await billsFor(me.id));
});
