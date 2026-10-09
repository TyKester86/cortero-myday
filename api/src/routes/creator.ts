/**
 * Creators earn in the Feed: one-time tips and monthly support, paid through Stripe Connect (Express) straight
 * to the creator's own Stripe account — MyDay never holds their money. Optional for everyone: the Feed is free.
 * Grown-ups with a Feed profile only (member()); never across a block; never to yourself.
 *
 * BILLING_PROVIDER=stub (local/tests): a creator is "connected" at once and payments complete immediately.
 * CREATOR_FEE_PCT (default 0): the platform's share of each payment, kept by Stripe as an application fee.
 */
import { Router } from 'express';
import type { CreatorInfo, CreatorPublic } from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { notify } from '../lib/feednotify.js';
import { originFor } from '../lib/hosts.js';
import { HttpError, idParam } from '../lib/http.js';
import { stripe, stripeGet } from '../lib/stripe.js';
import { block, member } from './community.js';

export const creatorRouter = Router();

const payments = (): 'stripe' | 'stub' | 'none' => config.billingProvider;
const feePct = (): number => Math.min(30, Math.max(0, Number(process.env.CREATOR_FEE_PCT ?? '0') || 0));
const money = (c: number): string => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

interface AccountRow {
  user_id: number;
  stripe_account_id: string;
  status: 'pending' | 'active' | 'restricted';
  tips_enabled: boolean;
  sub_cents: number | null;
}

async function accountOf(userId: number): Promise<AccountRow | null> {
  const { rows } = await asSystem(() => pool.query<AccountRow>('SELECT * FROM creator_accounts WHERE user_id = $1', [userId]));
  return rows[0] ?? null;
}

/** Ask Stripe whether the creator's account can take payments yet (after onboarding). */
async function refreshStatus(a: AccountRow): Promise<AccountRow> {
  if (payments() !== 'stripe' || a.status === 'active') return a;
  const acct = await stripeGet<{ charges_enabled?: boolean; payouts_enabled?: boolean; requirements?: { disabled_reason?: string | null } }>(`accounts/${a.stripe_account_id}`);
  const status = acct.charges_enabled ? 'active' : acct.requirements?.disabled_reason ? 'restricted' : 'pending';
  if (status !== a.status) await asSystem(() => pool.query('UPDATE creator_accounts SET status = $2 WHERE user_id = $1', [a.user_id, status]));
  return { ...a, status };
}

async function info(userId: number): Promise<CreatorInfo> {
  let a = await accountOf(userId);
  if (a) a = await refreshStatus(a);
  const { rows } = await asSystem(() =>
    pool.query<{ total: number; last30: number; tips: number; supporters: number; monthly: number }>(
      `SELECT (SELECT COALESCE(SUM(cents - fee_cents), 0)::int FROM creator_tips WHERE creator_user_id = $1 AND status = 'paid') AS total,
              (SELECT COALESCE(SUM(cents - fee_cents), 0)::int FROM creator_tips WHERE creator_user_id = $1 AND status = 'paid' AND paid_at > now() - interval '30 days') AS last30,
              (SELECT COUNT(*)::int FROM creator_tips WHERE creator_user_id = $1 AND status = 'paid') AS tips,
              (SELECT COUNT(*)::int FROM creator_subscriptions WHERE creator_user_id = $1 AND status = 'active') AS supporters,
              (SELECT COALESCE(SUM(cents), 0)::int FROM creator_subscriptions WHERE creator_user_id = $1 AND status = 'active') AS monthly`,
      [userId],
    ),
  );
  const r = rows[0];
  return {
    payments: payments(),
    status: a?.status ?? 'none',
    tipsEnabled: !!a?.tips_enabled,
    subCents: a?.sub_cents ?? null,
    feePct: feePct(),
    earnings: { tipsCents: r?.total ?? 0, last30Cents: r?.last30 ?? 0, tips: r?.tips ?? 0, supporters: r?.supporters ?? 0, monthlyCents: r?.monthly ?? 0 },
  };
}

creatorRouter.get('/api/creator', async (req, res) => {
  const m = await member(req);
  res.json(await info(m.userId));
});

/** Start (or continue) Stripe onboarding: a link to Stripe's own pages, back to the Feed after. */
creatorRouter.post('/api/creator/connect', async (req, res) => {
  const m = await member(req);
  if (payments() === 'none') throw new HttpError(503, 'Payments aren’t live yet');
  let a = await accountOf(m.userId);
  if (payments() === 'stub') {
    if (!a) await asSystem(() => pool.query("INSERT INTO creator_accounts (user_id, stripe_account_id, status) VALUES ($1, $2, 'active')", [m.userId, `acct_stub_${m.userId}`]));
    res.json({ url: null, info: await info(m.userId) });
    return;
  }
  if (!a) {
    let acct: { id: string };
    try {
      acct = await stripe<{ id: string }>('accounts', {
        type: 'express',
        email: req.user?.email,
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { product_description: 'Creator on The Feed (tips and monthly support from members)' },
        metadata: { myday_user_id: m.userId },
      });
    } catch (e) {
      // The platform's Stripe account must have Connect turned on first.
      console.error('creator connect failed', e instanceof Error ? e.message : e);
      throw new HttpError(503, 'Creator earnings aren’t switched on yet — check back soon.', 'connect_unavailable');
    }
    await asSystem(() => pool.query('INSERT INTO creator_accounts (user_id, stripe_account_id) VALUES ($1, $2)', [m.userId, acct.id]));
    a = await accountOf(m.userId);
  }
  const origin = originFor(req);
  const link = await stripe<{ url: string }>('account_links', {
    account: a?.stripe_account_id,
    refresh_url: `${origin}/earnings?connect=retry`,
    return_url: `${origin}/earnings?connect=done`,
    type: 'account_onboarding',
  });
  res.json({ url: link.url, info: await info(m.userId) });
});

/** Turn tips on/off and set (or remove) a monthly support price — once Stripe says the account can take payments. */
creatorRouter.put('/api/creator', async (req, res) => {
  const m = await member(req);
  const a = await accountOf(m.userId);
  const b = req.body as { tipsEnabled?: unknown; subCents?: unknown };
  if (!a || (await refreshStatus(a)).status !== 'active') throw new HttpError(409, 'Connect your Stripe account first', 'not_connected');
  const tips = typeof b.tipsEnabled === 'boolean' ? b.tipsEnabled : a.tips_enabled;
  let sub = a.sub_cents;
  if (b.subCents === null) sub = null;
  else if (b.subCents !== undefined) {
    const c = Number(b.subCents);
    if (!Number.isInteger(c) || c < 100 || c > 10000) throw new HttpError(400, 'Monthly support is $1 to $100');
    sub = c;
  }
  await asSystem(() => pool.query('UPDATE creator_accounts SET tips_enabled = $2, sub_cents = $3 WHERE user_id = $1', [m.userId, tips, sub]));
  res.json(await info(m.userId));
});

/** What a profile shows: can you tip them, can you support them monthly (and are you already). */
creatorRouter.get('/api/creator/:userId/public', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.userId);
  const a = await accountOf(id);
  const { rows } = await asSystem(() =>
    pool.query<{ status: string }>("SELECT status FROM creator_subscriptions WHERE creator_user_id = $1 AND subscriber_user_id = $2 AND status = 'active'", [id, m.userId]),
  );
  const on = !!a && a.status === 'active' && id !== m.userId && !(await block(m.userId, id));
  const out: CreatorPublic = { tips: on && a.tips_enabled, subCents: on ? a.sub_cents : null, supporting: !!rows[0] };
  res.json(out);
});

async function payable(viewer: number, creator: number): Promise<AccountRow> {
  if (viewer === creator) throw new HttpError(400, 'That’s you');
  if (await block(viewer, creator)) throw new HttpError(403, 'You can’t support this person');
  const a = await accountOf(creator);
  if (!a || a.status !== 'active') throw new HttpError(409, 'They aren’t set up to receive support yet');
  if (payments() === 'none') throw new HttpError(503, 'Payments aren’t live yet');
  return a;
}

/** A tip ($1–$500): Stripe Checkout, paid to the creator's own account. Stub: paid at once. */
creatorRouter.post('/api/creator/:userId/tip', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.userId);
  const a = await payable(m.userId, id);
  if (!a.tips_enabled) throw new HttpError(409, 'They aren’t taking tips');
  const cents = Number((req.body as { cents?: unknown }).cents);
  if (!Number.isInteger(cents) || cents < 100 || cents > 50000) throw new HttpError(400, 'Tips are $1 to $500');
  const fee = Math.round((cents * feePct()) / 100);
  const { rows } = await asSystem(() =>
    pool.query<{ id: number }>('INSERT INTO creator_tips (creator_user_id, from_user_id, cents, fee_cents) VALUES ($1, $2, $3, $4) RETURNING id', [id, m.userId, cents, fee]),
  );
  const tipId = rows[0]?.id ?? 0;
  const back = `${originFor(req)}/people/${id}`;
  if (payments() === 'stub') {
    await tipPaid(tipId, `stub_tip_${tipId}`);
    res.json({ url: `${back}?tip=thanks` });
    return;
  }
  const session = await stripe<{ id: string; url: string }>('checkout/sessions', {
    mode: 'payment',
    customer_email: req.user?.email,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name: 'A tip on The Feed' } } }],
    payment_intent_data: { transfer_data: { destination: a.stripe_account_id }, ...(fee ? { application_fee_amount: fee } : {}), metadata: { myday_kind: 'tip', myday_id: tipId } },
    metadata: { myday_kind: 'tip', myday_id: tipId },
    success_url: `${back}?tip=thanks`,
    cancel_url: back,
  });
  await asSystem(() => pool.query('UPDATE creator_tips SET stripe_session_id = $2 WHERE id = $1', [tipId, session.id]));
  res.json({ url: session.url });
});

/** Monthly support at the creator's price: a Stripe subscription paid to their account. Stub: active at once. */
creatorRouter.post('/api/creator/:userId/subscribe', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.userId);
  const a = await payable(m.userId, id);
  if (!a.sub_cents) throw new HttpError(409, 'They don’t offer monthly support');
  const cents = a.sub_cents;
  const subId = await asSystem(async () => {
    const live = await pool.query("SELECT 1 FROM creator_subscriptions WHERE creator_user_id = $1 AND subscriber_user_id = $2 AND status = 'active'", [id, m.userId]);
    if (live.rowCount) throw new HttpError(409, 'You already support them');
    await pool.query("DELETE FROM creator_subscriptions WHERE creator_user_id = $1 AND subscriber_user_id = $2 AND status = 'pending'", [id, m.userId]);
    const { rows } = await pool.query<{ id: number }>('INSERT INTO creator_subscriptions (creator_user_id, subscriber_user_id, cents) VALUES ($1, $2, $3) RETURNING id', [id, m.userId, cents]);
    return rows[0]?.id ?? 0;
  });
  const back = `${originFor(req)}/people/${id}`;
  if (payments() === 'stub') {
    await supportStarted(subId, `stub_sub_${subId}`, null);
    res.json({ url: `${back}?support=thanks` });
    return;
  }
  const session = await stripe<{ id: string; url: string }>('checkout/sessions', {
    mode: 'subscription',
    customer_email: req.user?.email,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, recurring: { interval: 'month' }, product_data: { name: 'Monthly support on The Feed' } } }],
    subscription_data: { transfer_data: { destination: a.stripe_account_id }, ...(feePct() ? { application_fee_percent: feePct() } : {}), metadata: { myday_kind: 'creator_sub', myday_id: subId } },
    metadata: { myday_kind: 'creator_sub', myday_id: subId },
    success_url: `${back}?support=thanks`,
    cancel_url: back,
  });
  await asSystem(() => pool.query('UPDATE creator_subscriptions SET stripe_session_id = $2 WHERE id = $1', [subId, session.id]));
  res.json({ url: session.url });
});

/** Stop supporting (Stripe ends the subscription; it stays until the paid month runs out). */
creatorRouter.post('/api/creator/:userId/unsubscribe', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.userId);
  const { rows } = await asSystem(() =>
    pool.query<{ id: number; stripe_subscription_id: string | null }>(
      "SELECT id, stripe_subscription_id FROM creator_subscriptions WHERE creator_user_id = $1 AND subscriber_user_id = $2 AND status = 'active'",
      [id, m.userId],
    ),
  );
  const s = rows[0];
  if (!s) throw new HttpError(404, 'You aren’t supporting them');
  if (payments() === 'stripe' && s.stripe_subscription_id) await stripe(`subscriptions/${s.stripe_subscription_id}`, { cancel_at_period_end: true });
  else await asSystem(() => pool.query("UPDATE creator_subscriptions SET status = 'canceled', canceled_at = now() WHERE id = $1", [s.id]));
  res.json({ ok: true });
});

/* ---------- payment arrived (webhook / stub): idempotent ---------- */

async function tipPaid(tipId: number, sessionId: string): Promise<void> {
  const { rows } = await asSystem(() =>
    pool.query<{ creator_user_id: number; from_user_id: number | null; cents: number }>(
      "UPDATE creator_tips SET status = 'paid', paid_at = now(), stripe_session_id = COALESCE(stripe_session_id, $2) WHERE id = $1 AND status = 'pending' RETURNING creator_user_id, from_user_id, cents",
      [tipId, sessionId],
    ),
  );
  const t = rows[0];
  if (!t) return;
  await notify({ to: t.creator_user_id, kind: 'tip', actor: t.from_user_id, group: `tip:${tipId}`, url: '/earnings', snippet: money(t.cents) });
  await asSystem(() => logEvent('creator_tip', { cents: t.cents }, null, null));
}

async function supportStarted(subId: number, sessionId: string, stripeSub: string | null): Promise<void> {
  const { rows } = await asSystem(() =>
    pool.query<{ creator_user_id: number; subscriber_user_id: number; cents: number }>(
      `UPDATE creator_subscriptions SET status = 'active', stripe_session_id = COALESCE(stripe_session_id, $2), stripe_subscription_id = COALESCE(stripe_subscription_id, $3)
        WHERE id = $1 AND status = 'pending' RETURNING creator_user_id, subscriber_user_id, cents`,
      [subId, sessionId, stripeSub],
    ),
  );
  const s = rows[0];
  if (!s) return;
  await notify({ to: s.creator_user_id, kind: 'supporter', actor: s.subscriber_user_id, group: `supporter:${subId}`, url: '/earnings', snippet: money(s.cents) });
  await asSystem(() => logEvent('creator_supporter', { cents: s.cents }, null, null));
}

/** From Stripe's signed webhook (routes/billing.ts). True when the event was a creator payment. */
export async function creatorWebhook(type: string, o: Record<string, unknown>): Promise<boolean> {
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  if (type === 'checkout.session.completed' && (meta.myday_kind === 'tip' || meta.myday_kind === 'creator_sub')) {
    if (meta.myday_kind === 'tip' && o.payment_status === 'paid') await tipPaid(Number(meta.myday_id), String(o.id));
    if (meta.myday_kind === 'creator_sub') await supportStarted(Number(meta.myday_id), String(o.id), typeof o.subscription === 'string' ? o.subscription : null);
    return true;
  }
  if ((type === 'customer.subscription.deleted' || type === 'customer.subscription.updated') && typeof o.id === 'string') {
    const ended = type === 'customer.subscription.deleted' || o.status === 'canceled';
    const { rowCount } = await asSystem(() =>
      pool.query(
        `UPDATE creator_subscriptions SET current_period_end = to_timestamp($2::double precision),
                status = CASE WHEN $3::boolean THEN 'canceled' ELSE status END, canceled_at = CASE WHEN $3::boolean THEN now() ELSE canceled_at END
          WHERE stripe_subscription_id = $1`,
        [o.id, typeof o.current_period_end === 'number' ? o.current_period_end : null, ended],
      ),
    );
    return !!rowCount;
  }
  return false;
}

/** Back from Checkout: ask Stripe directly (works even before the webhook lands). */
creatorRouter.get('/api/creator/checkout/confirm', async (req, res) => {
  await member(req);
  const sid = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  if (!/^cs_[A-Za-z0-9_]+$/.test(sid) || payments() !== 'stripe') throw new HttpError(400, 'Nothing to confirm');
  const s = await stripeGet<Record<string, unknown>>(`checkout/sessions/${sid}`);
  res.json({ ok: await creatorWebhook('checkout.session.completed', s) });
});

/** Your supporters and recent tips (the creator's own Earnings page). */
creatorRouter.get('/api/creator/supporters', async (req, res) => {
  const m = await member(req);
  const { rows } = await asSystem(() =>
    pool.query<{ kind: 'tip' | 'monthly'; name: string | null; cents: number; at: Date }>(
      `SELECT 'tip' AS kind, p.display_name AS name, t.cents, t.paid_at AS at FROM creator_tips t LEFT JOIN social_profiles p ON p.user_id = t.from_user_id
        WHERE t.creator_user_id = $1 AND t.status = 'paid'
       UNION ALL
       SELECT 'monthly', p.display_name, s.cents, s.created_at FROM creator_subscriptions s LEFT JOIN social_profiles p ON p.user_id = s.subscriber_user_id
        WHERE s.creator_user_id = $1 AND s.status = 'active'
       ORDER BY at DESC LIMIT 50`,
      [m.userId],
    ),
  );
  res.json({ items: rows.map((r) => ({ kind: r.kind, name: r.name ?? 'Someone', cents: r.cents, at: r.at.toISOString() })) });
});
