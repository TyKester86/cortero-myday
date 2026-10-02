/**
 * Billing (flat household pricing) + the MyDay admin dashboard.
 *
 * The price is NOT in code: plans live in billing_plans and staff set the
 * price (or leave it "not decided"). Every household gets a 30-day trial at
 * signup. No real charges anywhere: BILLING_PROVIDER=none (default) means
 * payments aren't live; =stub records a test card and never charges. A real
 * provider plugs in behind the same flag later.
 *
 * Admin = a signed-in user whose email is in ADMIN_EMAILS. Admin routes read
 * across households (system scope) and work without a household of your own.
 */
import { Router, type Request } from 'express';
import type {
  AdminDashboard,
  AdminHousehold,
  BillingDisplayStatus,
  BillingPlan,
  BillingResponse,
  BillingStatus,
  HouseholdType,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { mergeHouseholds, planMerge as mergePlan } from '../lib/householdMove.js';
import { bool, HttpError, idParam, int, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';

export const billingRouter = Router();
export const adminRouter = Router();

interface PlanRow {
  id: number;
  code: string;
  name: string;
  price_cents: number | null;
  currency: string;
  interval: 'month' | 'year';
  active: boolean;
  is_default: boolean;
}

const toPlan = (r: PlanRow): BillingPlan => ({
  id: r.id,
  code: r.code,
  name: r.name,
  priceCents: r.price_cents,
  currency: r.currency,
  interval: r.interval,
  active: r.active,
  isDefault: r.is_default,
});

const monthly = (p: Pick<PlanRow, 'price_cents' | 'interval'> | null): number =>
  p?.price_cents == null ? 0 : p.interval === 'year' ? Math.round(p.price_cents / 12) : p.price_cents;

export function displayStatus(status: BillingStatus, trialEndsAt: Date | null, now = Date.now()): BillingDisplayStatus {
  if (status === 'trialing' && trialEndsAt && trialEndsAt.getTime() < now) return 'trial_ended';
  return status;
}

interface HhRow {
  id: number;
  plan_id: number | null;
  billing_status: BillingStatus;
  trial_ends_at: Date | null;
  payment_method: { brand: string; last4: string; test: boolean } | null;
}

async function billingFor(householdId: number, canManage: boolean): Promise<BillingResponse> {
  return asSystem(async () => {
    const { rows } = await pool.query<HhRow>('SELECT id, plan_id, billing_status, trial_ends_at, payment_method FROM households WHERE id = $1', [householdId]);
    const h = rows[0];
    if (!h) throw new HttpError(404, 'No household');
    const { rows: p } = await pool.query<PlanRow>(
      'SELECT * FROM billing_plans WHERE id = COALESCE($1, (SELECT id FROM billing_plans WHERE is_default))',
      [h.plan_id],
    );
    const left = h.trial_ends_at ? Math.max(0, Math.ceil((h.trial_ends_at.getTime() - Date.now()) / 86_400_000)) : null;
    return {
      plan: p[0] ? toPlan(p[0]) : null,
      status: displayStatus(h.billing_status, h.trial_ends_at),
      trialEndsAt: h.trial_ends_at?.toISOString() ?? null,
      trialDaysLeft: h.billing_status === 'trialing' ? left : null,
      paymentMethod: h.payment_method,
      provider: config.billingProvider,
      canManage,
    };
  });
}

async function setBilling(householdId: number, sets: string, params: unknown[]): Promise<void> {
  await asSystem(() => pool.query(`UPDATE households SET ${sets}, billing_updated_at = now() WHERE id = $1`, [householdId, ...params]));
}

function householdOf(req: Request): number {
  if (!req.householdId) throw new HttpError(409, 'No household');
  return req.householdId;
}

/* ---------- the household's billing page ---------- */

billingRouter.get('/api/billing', async (req, res) => {
  const canManage = req.member?.kind === 'adult';
  if (!canManage) throw new HttpError(403, 'Billing is for grown-ups');
  res.json(await billingFor(householdOf(req), true));
});

/** Payment method placeholder. Stub only: records a test card, never charges. */
billingRouter.post('/api/billing/payment-method', async (req, res) => {
  const me = requireAdult(req);
  const hh = householdOf(req);
  if (config.billingProvider !== 'stub') throw new HttpError(503, 'Payments aren’t live yet — nothing to add. Your trial keeps going.');
  const last4 = str((req.body as { last4?: unknown }).last4, 'last4', 4) || '4242';
  if (!/^\d{4}$/.test(last4)) throw new HttpError(400, 'last4 is 4 digits');
  await setBilling(hh, 'payment_method = $2', [JSON.stringify({ brand: 'Test card', last4, test: true })]);
  await logEvent('billing_change', { action: 'payment_method_added', provider: 'stub' }, me.id);
  res.status(201).json(await billingFor(hh, true));
});

billingRouter.delete('/api/billing/payment-method', async (req, res) => {
  const me = requireAdult(req);
  const hh = householdOf(req);
  await setBilling(hh, 'payment_method = NULL', []);
  await logEvent('billing_change', { action: 'payment_method_removed' }, me.id);
  res.json(await billingFor(hh, true));
});

/** Start the paid plan (stub: no charge). Needs a payment method and a priced plan. */
billingRouter.post('/api/billing/subscribe', async (req, res) => {
  const me = requireAdult(req);
  const hh = householdOf(req);
  const b = await billingFor(hh, true);
  if (b.provider !== 'stub') throw new HttpError(503, 'Payments aren’t live yet');
  if (b.status === 'comped') throw new HttpError(409, 'This household is complimentary — nothing to pay');
  if (!b.paymentMethod) throw new HttpError(409, 'Add a payment method first');
  if (b.plan?.priceCents == null) throw new HttpError(409, 'The plan price hasn’t been set yet');
  await setBilling(hh, "billing_status = 'active'", []);
  await logEvent('billing_change', { action: 'subscribed', plan: b.plan.code }, me.id);
  res.json(await billingFor(hh, true));
});

billingRouter.post('/api/billing/cancel', async (req, res) => {
  const me = requireAdult(req);
  const hh = householdOf(req);
  const b = await billingFor(hh, true);
  if (b.status !== 'active' && b.status !== 'past_due') throw new HttpError(409, 'There’s no paid plan to cancel');
  await setBilling(hh, "billing_status = 'canceled'", []);
  await logEvent('billing_change', { action: 'canceled' }, me.id);
  res.json(await billingFor(hh, true));
});

/* ---------- admin ---------- */

function requireAdmin(req: Request): void {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (!config.adminEmails.includes(req.user.email.toLowerCase())) throw new HttpError(403, 'Admins only');
}

async function dashboard(): Promise<AdminDashboard> {
  return asSystem(async () => {
    const { rows: plans } = await pool.query<PlanRow>('SELECT * FROM billing_plans ORDER BY id');
    const { rows } = await pool.query<{
      id: number;
      name: string;
      type: HouseholdType;
      created_at: Date;
      billing_status: BillingStatus;
      trial_ends_at: Date | null;
      plan_id: number | null;
      members: number;
    }>(
      `SELECT h.id, h.name, h.type, h.created_at, h.billing_status, h.trial_ends_at, h.plan_id,
              (SELECT COUNT(*)::int FROM household_members m WHERE m.household_id = h.id AND m.archived_at IS NULL) AS members
         FROM households h ORDER BY h.created_at DESC, h.id DESC`,
    );
    const def = plans.find((p) => p.is_default) ?? null;
    const now = Date.now();
    const households = rows.map((r): AdminHousehold => {
      const plan = plans.find((p) => p.id === r.plan_id) ?? def;
      const status = displayStatus(r.billing_status, r.trial_ends_at, now);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        members: r.members,
        createdAt: r.created_at.toISOString(),
        plan: plan?.name ?? null,
        status,
        trialEndsAt: r.trial_ends_at?.toISOString() ?? null,
        monthlyCents: status === 'active' ? monthly(plan) : 0,
      };
    });
    const n = (s: BillingDisplayStatus): number => households.filter((h) => h.status === s).length;
    const week = now + 7 * 86_400_000;
    return {
      households,
      plans: plans.map(toPlan),
      totals: {
        households: households.length,
        trialing: n('trialing'),
        trialEnded: n('trial_ended'),
        active: n('active'),
        pastDue: n('past_due'),
        canceled: n('canceled'),
        comped: n('comped'),
        trialsEndingThisWeek: rows.filter((r) => r.billing_status === 'trialing' && r.trial_ends_at && r.trial_ends_at.getTime() >= now && r.trial_ends_at.getTime() <= week).length,
        mrrCents: households.reduce((s, h) => s + h.monthlyCents, 0),
        unpriced: households.filter((h) => {
          if (h.status !== 'active') return false;
          const r = rows.find((x) => x.id === h.id);
          const plan = plans.find((p) => p.id === r?.plan_id) ?? def;
          return plan?.price_cents == null;
        }).length,
      },
      provider: config.billingProvider,
    };
  });
}

adminRouter.get('/api/admin/dashboard', async (req, res) => {
  requireAdmin(req);
  res.json(await dashboard());
});

function planFields(b: Record<string, unknown>): { name?: string; price?: number | null; interval?: 'month' | 'year'; active?: boolean } {
  const out: { name?: string; price?: number | null; interval?: 'month' | 'year'; active?: boolean } = {};
  if (b.name !== undefined) out.name = str(b.name, 'name', 60, true);
  if (b.priceCents !== undefined) out.price = b.priceCents === null || b.priceCents === '' ? null : int(b.priceCents, 'priceCents', 0, 1_000_000);
  if (b.interval !== undefined) {
    if (b.interval !== 'month' && b.interval !== 'year') throw new HttpError(400, 'interval is month or year');
    out.interval = b.interval;
  }
  if (b.active !== undefined) out.active = bool(b.active, 'active');
  return out;
}

/** Create a plan (price optional — "not decided" is allowed). */
adminRouter.post('/api/admin/plans', async (req, res) => {
  requireAdmin(req);
  const b = req.body as Record<string, unknown>;
  const f = planFields(b);
  const code = str(b.code, 'code', 40, true).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(code)) throw new HttpError(400, 'code is lowercase letters, digits and dashes');
  await asSystem(async () => {
    const dup = await pool.query('SELECT 1 FROM billing_plans WHERE code = $1', [code]);
    if (dup.rowCount) throw new HttpError(409, 'A plan with that code exists');
    await pool.query('INSERT INTO billing_plans (code, name, price_cents, interval) VALUES ($1, $2, $3, $4)', [code, f.name ?? code, f.price ?? null, f.interval ?? 'month']);
  });
  res.status(201).json(await dashboard());
});

/** Change a plan's price / name / interval / active. Setting isDefault moves new signups to it. */
adminRouter.patch('/api/admin/plans/:id', async (req, res) => {
  requireAdmin(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const f = planFields(b);
  await asSystem(async () => {
    const r = await pool.query<PlanRow>('SELECT * FROM billing_plans WHERE id = $1', [id]);
    const cur = r.rows[0];
    if (!cur) throw new HttpError(404, 'No such plan');
    await pool.query('UPDATE billing_plans SET name = $2, price_cents = $3, interval = $4, active = $5 WHERE id = $1', [
      id,
      f.name ?? cur.name,
      f.price === undefined ? cur.price_cents : f.price,
      f.interval ?? cur.interval,
      f.active ?? cur.active,
    ]);
    if (b.isDefault === true) {
      await pool.query('UPDATE billing_plans SET is_default = false WHERE is_default AND id <> $1', [id]);
      await pool.query('UPDATE billing_plans SET is_default = true, active = true WHERE id = $1', [id]);
    }
  });
  res.json(await dashboard());
});

/** Comp, un-comp or move a household to a plan (support tool). */
adminRouter.patch('/api/admin/households/:id', async (req, res) => {
  requireAdmin(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const statuses: BillingStatus[] = ['trialing', 'active', 'past_due', 'canceled', 'comped'];
  await asSystem(async () => {
    const h = await pool.query('SELECT 1 FROM households WHERE id = $1', [id]);
    if (!h.rowCount) throw new HttpError(404, 'No such household');
    if (b.status !== undefined) {
      const s = statuses.find((x) => x === b.status);
      if (!s) throw new HttpError(400, 'Unknown status');
      await pool.query('UPDATE households SET billing_status = $2, billing_updated_at = now() WHERE id = $1', [id, s]);
    }
    if (b.planId !== undefined) {
      const p = await pool.query('SELECT 1 FROM billing_plans WHERE id = $1', [idParam(b.planId)]);
      if (!p.rowCount) throw new HttpError(404, 'No such plan');
      await pool.query('UPDATE households SET plan_id = $2, billing_updated_at = now() WHERE id = $1', [id, idParam(b.planId)]);
    }
  });
  res.json(await dashboard());
});

/**
 * Delete a household and everything in it (e.g. test sign-ups). The caller must
 * echo the household's exact name; the events log keeps its rows (unlinked).
 */
adminRouter.delete('/api/admin/households/:id', async (req, res) => {
  requireAdmin(req);
  const id = idParam(req.params.id);
  const confirmName = typeof req.query.confirm === 'string' ? req.query.confirm : '';
  await asSystem(async () => {
    const r = await pool.query<{ name: string }>('SELECT name FROM households WHERE id = $1', [id]);
    const h = r.rows[0];
    if (!h) throw new HttpError(404, 'No such household');
    if (confirmName !== h.name) throw new HttpError(409, 'Type the household’s exact name to delete it');
    if (req.householdId === id) throw new HttpError(409, 'You can’t delete your own household from the admin page');
    await pool.query('DELETE FROM households WHERE id = $1', [id]);
  });
  await asSystem(() => logEvent('household_deleted', { id }, null, null));
  res.json(await dashboard());
});

/* ---------- merge a duplicate household (staff) ---------- */

adminRouter.get('/api/admin/households/:id/merge-preview', async (req, res) => {
  requireAdmin(req);
  res.json((await mergePlan(idParam(req.params.id), idParam(req.query.into))).preview);
});

/** Move a duplicate household (and everyone + everything in it) into another, then delete it. */
adminRouter.post('/api/admin/households/:id/merge', async (req, res) => {
  requireAdmin(req);
  const from = idParam(req.params.id);
  const b = req.body as { into?: unknown; confirm?: unknown };
  const into = idParam(b.into);
  const { preview, map } = await mergePlan(from, into);
  if (b.confirm !== preview.from.name) throw new HttpError(409, 'Confirm with the duplicate household’s exact name');
  const report = await mergeHouseholds(from, into, map);
  await asSystem(() =>
    logEvent('household_merged', { from, into, by: req.user?.email ?? '', moved: report.membersMoved.length, folded: report.membersMerged.length, dropped: Object.values(report.dropped).reduce((s, n) => s + n, 0) }, null, into),
  );
  res.json({ report, dashboard: await dashboard() });
});
