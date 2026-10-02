/**
 * Investments / retirement (grown-ups, manual entry): accounts (401k, IRA,
 * brokerage…), balance snapshots with that day's asset mix, monthly
 * contributions + employer match, the household's target mix vs the actual
 * balance-weighted mix, and a simple long-range projection. No broker links.
 */
import { Router } from 'express';
import {
  ASSET_CLASSES,
  INVEST_KINDS,
  projectInvestments,
  type Allocation,
  type DateStr,
  type InvestAccount,
  type InvestPlan,
  type InvestResponse,
} from '@myday/shared';
import { pool } from '../db.js';
import { today } from '../lib/dates.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { memberByKey, requireAdult } from '../lib/members.js';

export const investRouter = Router();

function amount(v: unknown, field: string, max = 100_000_000): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} must be an amount`);
  return Math.round(n * 100) / 100;
}

function mix(b: Record<string, unknown>, prefix: '' | 'target'): Allocation {
  const out = {} as Allocation;
  for (const c of ASSET_CLASSES) {
    const key = prefix ? `target${c[0]?.toUpperCase()}${c.slice(1)}` : `${c}Pct`;
    const v = b[key] === undefined || b[key] === '' ? 0 : Number(b[key]);
    if (!Number.isFinite(v) || v < 0 || v > 100) throw new HttpError(400, `${key} must be 0–100`);
    out[c] = Math.round(v * 100) / 100;
  }
  const sum = ASSET_CLASSES.reduce((s, c) => s + out[c], 0);
  if (Math.abs(sum - 100) > 0.01) throw new HttpError(400, `The mix must add up to 100% (it adds to ${sum}%)`);
  return out;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

async function investView(): Promise<InvestResponse> {
  const { rows: accts } = await pool.query<{ id: number; name: string; kind: InvestAccount['kind']; owner: string | null; monthly_contribution: string; employer_match: string }>(
    `SELECT a.id, a.name, a.kind, m.name AS owner, a.monthly_contribution, a.employer_match
       FROM invest_accounts a LEFT JOIN household_members m ON m.id = a.owner_id ORDER BY a.id`,
  );
  const { rows: bals } = await pool.query<{ account_id: number; as_of: DateStr; balance: string; stocks_pct: string; bonds_pct: string; cash_pct: string; other_pct: string }>(
    'SELECT account_id, as_of::text AS as_of, balance, stocks_pct, bonds_pct, cash_pct, other_pct FROM invest_balances ORDER BY as_of',
  );
  const { rows: pl } = await pool.query<Record<string, string>>('SELECT * FROM invest_plans');
  const p = pl[0];
  const plan: InvestPlan = {
    target: {
      stocks: Number(p?.target_stocks ?? 80),
      bonds: Number(p?.target_bonds ?? 15),
      cash: Number(p?.target_cash ?? 5),
      other: Number(p?.target_other ?? 0),
    },
    expectedReturnPct: Number(p?.expected_return_pct ?? 6),
    inflationPct: Number(p?.inflation_pct ?? 2.5),
    yearsToRetire: Number(p?.years_to_retire ?? 25),
    withdrawalPct: Number(p?.withdrawal_pct ?? 4),
  };
  const accounts = accts.map((a): InvestAccount => {
    const mine = bals.filter((b) => b.account_id === a.id);
    const last = mine[mine.length - 1];
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      owner: a.owner,
      balance: last ? Number(last.balance) : 0,
      asOf: last?.as_of ?? null,
      allocation: {
        stocks: Number(last?.stocks_pct ?? 0),
        bonds: Number(last?.bonds_pct ?? 0),
        cash: Number(last?.cash_pct ?? 0),
        other: Number(last?.other_pct ?? 0),
      },
      monthlyContribution: Number(a.monthly_contribution),
      employerMatch: Number(a.employer_match),
      history: mine.map((b) => ({ asOf: b.as_of, balance: Number(b.balance) })),
    };
  });
  const total = accounts.reduce((s, a) => s + a.balance, 0);
  const actual = {} as Allocation;
  const drift = {} as Allocation;
  for (const c of ASSET_CLASSES) {
    actual[c] = total ? round1(accounts.reduce((s, a) => s + (a.balance * a.allocation[c]) / 100, 0) / total * 100) : 0;
    drift[c] = total ? round1(actual[c] - plan.target[c]) : 0;
  }
  const monthly = accounts.reduce((s, a) => s + a.monthlyContribution + a.employerMatch, 0);
  const projection = projectInvestments(total, monthly, Math.max(1, Math.min(60, plan.yearsToRetire)), plan.expectedReturnPct, plan.inflationPct);
  const end = projection[projection.length - 1] ?? { nominal: 0, real: 0 };
  return {
    accounts,
    total: Math.round(total * 100) / 100,
    actual,
    plan,
    drift,
    monthlyContributions: Math.round(monthly * 100) / 100,
    projection,
    atRetirement: { real: end.real, nominal: end.nominal, yearlyIncomeReal: Math.round((end.real * plan.withdrawalPct) / 100) },
  };
}

investRouter.get('/api/invest', async (req, res) => {
  requireAdult(req);
  res.json(await investView());
});

investRouter.post('/api/invest/accounts', async (req, res) => {
  requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const kind = INVEST_KINDS.find((k) => k === b.kind);
  if (!kind) throw new HttpError(400, 'Pick an account type');
  const owner = typeof b.owner === 'string' && b.owner ? await memberByKey(b.owner) : null;
  if (b.owner && !owner) throw new HttpError(404, 'No such household member');
  await pool.query('INSERT INTO invest_accounts (owner_id, name, kind, monthly_contribution, employer_match) VALUES ($1, $2, $3, $4, $5)', [
    owner?.id ?? null, str(b.name, 'name', 60, true), kind, amount(b.monthlyContribution ?? 0, 'monthlyContribution', 1_000_000), amount(b.employerMatch ?? 0, 'employerMatch', 1_000_000),
  ]);
  res.status(201).json(await investView());
});

investRouter.patch('/api/invest/accounts/:id', async (req, res) => {
  requireAdult(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const { rows } = await pool.query<{ name: string; monthly_contribution: string; employer_match: string }>('SELECT name, monthly_contribution, employer_match FROM invest_accounts WHERE id = $1', [id]);
  const cur = rows[0];
  if (!cur) throw new HttpError(404, 'No such account');
  await pool.query('UPDATE invest_accounts SET name = $2, monthly_contribution = $3, employer_match = $4 WHERE id = $1', [
    id,
    b.name === undefined ? cur.name : str(b.name, 'name', 60, true),
    b.monthlyContribution === undefined ? cur.monthly_contribution : amount(b.monthlyContribution, 'monthlyContribution', 1_000_000),
    b.employerMatch === undefined ? cur.employer_match : amount(b.employerMatch, 'employerMatch', 1_000_000),
  ]);
  res.json(await investView());
});

investRouter.delete('/api/invest/accounts/:id', async (req, res) => {
  requireAdult(req);
  const r = await pool.query('DELETE FROM invest_accounts WHERE id = $1', [idParam(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'No such account');
  res.json(await investView());
});

/** Record a balance (and that day's mix). Same day again = a correction. */
investRouter.post('/api/invest/accounts/:id/balances', async (req, res) => {
  requireAdult(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const asOf = typeof b.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.asOf) ? b.asOf : today();
  if (asOf > today()) throw new HttpError(400, 'A balance can’t be in the future');
  const m = mix(b, '');
  const exists = await pool.query('SELECT 1 FROM invest_accounts WHERE id = $1', [id]);
  if (!exists.rowCount) throw new HttpError(404, 'No such account');
  await pool.query(
    `INSERT INTO invest_balances (account_id, as_of, balance, stocks_pct, bonds_pct, cash_pct, other_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (account_id, as_of) DO UPDATE SET balance = EXCLUDED.balance, stocks_pct = EXCLUDED.stocks_pct,
       bonds_pct = EXCLUDED.bonds_pct, cash_pct = EXCLUDED.cash_pct, other_pct = EXCLUDED.other_pct`,
    [id, asOf, amount(b.balance, 'balance'), m.stocks, m.bonds, m.cash, m.other],
  );
  res.status(201).json(await investView());
});

investRouter.put('/api/invest/plan', async (req, res) => {
  requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const t = mix(b, 'target');
  const ret = Number(b.expectedReturnPct ?? 6);
  const inf = Number(b.inflationPct ?? 2.5);
  const wd = Number(b.withdrawalPct ?? 4);
  if (![ret, inf, wd].every(Number.isFinite) || ret < -10 || ret > 20 || inf < 0 || inf > 15 || wd < 1 || wd > 10) {
    throw new HttpError(400, 'Return −10–20%, inflation 0–15%, withdrawal 1–10%');
  }
  await pool.query(
    `INSERT INTO invest_plans (target_stocks, target_bonds, target_cash, target_other, expected_return_pct, inflation_pct, years_to_retire, withdrawal_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (household_id) DO UPDATE SET target_stocks = EXCLUDED.target_stocks, target_bonds = EXCLUDED.target_bonds,
       target_cash = EXCLUDED.target_cash, target_other = EXCLUDED.target_other, expected_return_pct = EXCLUDED.expected_return_pct,
       inflation_pct = EXCLUDED.inflation_pct, years_to_retire = EXCLUDED.years_to_retire, withdrawal_pct = EXCLUDED.withdrawal_pct`,
    [t.stocks, t.bonds, t.cash, t.other, ret, inf, int(b.yearsToRetire ?? 25, 'yearsToRetire', 1, 60), wd],
  );
  res.json(await investView());
});
