/**
 * Billing (flat household pricing) + the MyDay admin dashboard.
 *
 * The price is NOT in code: plans live in billing_plans and staff set the
 * price (or leave it "not decided"). Every household gets a 30-day trial at
 * signup. BILLING_PROVIDER=none (default) means payments aren't live; =stub
 * records a test card and never charges; =stripe takes real payments through
 * Stripe Checkout (cards never touch MyDay) and keeps the household's status
 * in sync from Stripe's signed webhooks.
 *
 * Admin = a signed-in user whose email is in ADMIN_EMAILS. Admin routes read
 * across households (system scope) and work without a household of your own.
 */
import express, { Router, type Request } from 'express';
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
import { mailOn, sendMail } from '../lib/mail.js';
import { registerJob } from '../lib/schedulers.js';
import { statusFrom, stripe, verifyWebhook } from '../lib/stripe.js';

export const billingRouter = Router();
export const adminRouter = Router();
/** Stripe's webhook needs the raw body (signature), so it mounts before the JSON parser. */
export const billingWebhookRouter = Router();

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
  name: string;
  plan_id: number | null;
  billing_status: BillingStatus;
  trial_ends_at: Date | null;
  payment_method: { brand: string; last4: string; test: boolean } | null;
  stripe_customer_id: string | null;
  paid_through: Date | null;
}

async function billingFor(householdId: number, canManage: boolean): Promise<BillingResponse> {
  return asSystem(async () => {
    const { rows } = await pool.query<HhRow>(
      'SELECT id, name, plan_id, billing_status, trial_ends_at, payment_method, stripe_customer_id, paid_through FROM households WHERE id = $1',
      [householdId],
    );
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
      paidThrough: h.paid_through?.toISOString() ?? null,
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

/* ---------- Stripe (real payments) ---------- */

async function hhRow(householdId: number): Promise<HhRow> {
  const { rows } = await asSystem(() =>
    pool.query<HhRow>('SELECT id, name, plan_id, billing_status, trial_ends_at, payment_method, stripe_customer_id, paid_through FROM households WHERE id = $1', [householdId]),
  );
  const h = rows[0];
  if (!h) throw new HttpError(404, 'No household');
  return h;
}

/** Start (or restart) the subscription: Stripe's hosted checkout. The trial's days are honored. */
billingRouter.post('/api/billing/checkout', async (req, res) => {
  const me = requireAdult(req);
  const hh = householdOf(req);
  if (config.billingProvider !== 'stripe') throw new HttpError(503, 'Payments aren’t live yet');
  const b = await billingFor(hh, true);
  if (b.status === 'comped') throw new HttpError(409, 'This household is complimentary — nothing to pay');
  if (b.status === 'active') throw new HttpError(409, 'You’re already subscribed — use “Manage billing”');
  const plan = b.plan;
  if (!plan || plan.priceCents == null) throw new HttpError(409, 'The plan price hasn’t been set yet');
  const h = await hhRow(hh);
  let customer = h.stripe_customer_id;
  if (!customer) {
    const c = await stripe<{ id: string }>('customers', { email: req.user?.email, name: h.name, metadata: { household_id: hh } });
    customer = c.id;
    await setBilling(hh, 'stripe_customer_id = $2', [customer]);
  }
  // Charging starts when the free trial ends (Stripe needs at least 2 days of trial left).
  const trialEnd = h.trial_ends_at && h.billing_status === 'trialing' && h.trial_ends_at.getTime() - Date.now() > 2 * 86_400_000 ? Math.floor(h.trial_ends_at.getTime() / 1000) : undefined;
  const session = await stripe<{ id: string; url: string }>('checkout/sessions', {
    mode: 'subscription',
    customer,
    client_reference_id: hh,
    line_items: [{ quantity: 1, price_data: { currency: plan.currency, unit_amount: plan.priceCents, recurring: { interval: plan.interval }, product_data: { name: `MyDay ${plan.name}` } } }],
    subscription_data: { metadata: { household_id: hh }, trial_end: trialEnd },
    success_url: `${config.publicUrl}/billing?paid=1`,
    cancel_url: `${config.publicUrl}/billing`,
    allow_promotion_codes: true,
  });
  await logEvent('billing_change', { action: 'checkout_started', provider: 'stripe' }, me.id);
  res.json({ url: session.url });
});

/** Stripe's billing portal: change card, see invoices, cancel. */
billingRouter.post('/api/billing/portal', async (req, res) => {
  requireAdult(req);
  const hh = householdOf(req);
  if (config.billingProvider !== 'stripe') throw new HttpError(503, 'Payments aren’t live yet');
  const h = await hhRow(hh);
  if (!h.stripe_customer_id) throw new HttpError(409, 'Nothing to manage yet — subscribe first');
  const session = await stripe<{ url: string }>('billing_portal/sessions', { customer: h.stripe_customer_id, return_url: `${config.publicUrl}/billing` });
  res.json({ url: session.url });
});

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Stripe → MyDay: keep the household's billing status in sync. Signed; replay-safe. */
billingWebhookRouter.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const raw = req.body as unknown;
  if (!Buffer.isBuffer(raw) || !verifyWebhook(raw, req.headers['stripe-signature'] as string | undefined, secret)) {
    res.status(400).json({ error: 'Bad signature' });
    return;
  }
  const ev = JSON.parse(raw.toString('utf8')) as StripeEvent;
  const o = ev.data.object;
  const byCustomer = async (customer: unknown): Promise<number | null> => {
    if (typeof customer !== 'string') return null;
    const { rows } = await asSystem(() => pool.query<{ id: number }>('SELECT id FROM households WHERE stripe_customer_id = $1', [customer]));
    return rows[0]?.id ?? null;
  };
  let hh: number | null = null;
  if (ev.type === 'checkout.session.completed') {
    hh = Number(o.client_reference_id) || (await byCustomer(o.customer));
    if (hh) {
      await setBilling(hh, "billing_status = 'active', stripe_customer_id = COALESCE(stripe_customer_id, $2), stripe_subscription_id = $3", [o.customer, o.subscription]);
    }
  } else if (ev.type === 'customer.subscription.created' || ev.type === 'customer.subscription.updated' || ev.type === 'customer.subscription.deleted') {
    hh = await byCustomer(o.customer);
    if (hh) {
      const status = ev.type === 'customer.subscription.deleted' ? 'canceled' : statusFrom(String(o.status));
      const end = typeof o.current_period_end === 'number' ? new Date(o.current_period_end * 1000) : null;
      await setBilling(hh, 'billing_status = $2, stripe_subscription_id = $3, paid_through = $4', [status, o.id, end]);
    }
  } else if (ev.type === 'invoice.payment_failed') {
    hh = await byCustomer(o.customer);
    if (hh) await setBilling(hh, "billing_status = 'past_due'", []);
  }
  if (hh) await asSystem(() => logEvent('billing_change', { action: ev.type, provider: 'stripe' }, null, hh));
  res.json({ received: true });
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

/* ---------- trial reminder (email, once, ~2 days before the trial ends) ---------- */

export async function sendTrialReminders(): Promise<number> {
  if (!mailOn()) return 0;
  return asSystem(async () => {
    const { rows } = await pool.query<{ id: number; name: string; trial_ends_at: Date }>(
      `SELECT id, name, trial_ends_at FROM households
        WHERE billing_status = 'trialing' AND trial_notice_at IS NULL
          AND trial_ends_at BETWEEN now() + interval '1 day' AND now() + interval '3 days'`,
    );
    let sent = 0;
    for (const h of rows) {
      const { rows: people } = await pool.query<{ email: string }>(
        `SELECT DISTINCT u.email FROM users u JOIN household_members m ON m.id = u.member_id
          WHERE m.household_id = $1 AND m.kind = 'adult' AND m.archived_at IS NULL`,
        [h.id],
      );
      const when = h.trial_ends_at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
      for (const p of people) {
        const ok = await sendMail({
          to: p.email,
          subject: 'Your MyDay trial ends soon',
          text: `Your household’s free trial (${h.name}) ends ${when}.\n\nTo keep going, subscribe from Settings → Billing in the app — one price for the whole household. Nothing changes until you decide.\n\n${config.publicUrl}/billing`,
        });
        if (ok) sent++;
      }
      await pool.query('UPDATE households SET trial_notice_at = now() WHERE id = $1', [h.id]);
    }
    return sent;
  });
}

registerJob({ name: 'trial-reminders', everyMs: 6 * 60 * 60 * 1000, run: async () => void (await sendTrialReminders()) });

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
