/**
 * The Provider Business Suite — for verified licensed providers only: boost a post or clip, run ad
 * campaigns, see their own analytics (never anyone else's), and offer consult slots people can book.
 *
 * Ads live only inside the 18+ Feed (kids never reach it: the API answers them 403), always say
 * "Sponsored", and their words go through the ad screen first — medical claims ("cures ADHD",
 * "clinically proven", "stop your meds") are refused before anything is charged. Payments are Stripe
 * Checkout (one-time); BILLING_PROVIDER=stub marks them paid at once (local/tests), =none turns them off.
 */
import { Router, type Request } from 'express';
import type { AdCampaign, BoostPackage, BusinessAnalytics, BusinessOverview, ClipItem, ConsultSlot, FeedPost, SponsoredItem } from '@myday/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { screenAd } from '../lib/screen.js';
import { currentKeyId, openText, sealText } from '../lib/seal.js';
import { stripe, stripeGet } from '../lib/stripe.js';
import { AUTHOR_COLS, AUTHOR_JOIN, author, block, feedPage, imageUrl, member, NOT_BLOCKED, poster, sponsorHook, type AuthorCols } from './community.js';
import { clipFor } from './social.js';

export const businessRouter = Router();

/* ---------- prices (config: BOOST_PACKAGES / AD_CPM_CENTS override the defaults) ---------- */

const DEFAULT_PACKAGES: BoostPackage[] = [
  { code: 'starter', label: 'Starter', impressions: 1000, cents: 1500 },
  { code: 'growth', label: 'Growth', impressions: 5000, cents: 5000 },
  { code: 'reach', label: 'Reach', impressions: 20000, cents: 15000 },
];
export function boostPackages(): BoostPackage[] {
  try {
    const raw = JSON.parse(process.env.BOOST_PACKAGES ?? 'null') as unknown;
    if (Array.isArray(raw) && raw.length) {
      const ok = raw.filter(
        (p): p is BoostPackage =>
          !!p && typeof p.code === 'string' && typeof p.label === 'string' && Number.isInteger(p.impressions) && p.impressions > 0 && Number.isInteger(p.cents) && p.cents >= 50,
      );
      if (ok.length) return ok;
    }
  } catch {
    /* fall back to the defaults */
  }
  return DEFAULT_PACKAGES;
}
/** Campaigns: dollars per thousand impressions. */
export const adCpmCents = (): number => {
  const n = Number(process.env.AD_CPM_CENTS ?? 1200);
  return Number.isInteger(n) && n >= 100 ? n : 1200;
};
const MIN_BUDGET = 1000;
/** "Today" in the app's time zone (the analytics' days), not the database server's (UTC on the droplet). */
const TODAY = `(now() AT TIME ZONE '${config.tz.replace(/[^A-Za-z0-9_/+-]/g, '')}')::date`;
const MAX_BUDGET = 500000;

/* ---------- who may use it ---------- */

/** A provider with the "Verified provider background" badge (the gate for everything in the suite). */
async function provider(req: Request): Promise<{ userId: number; name: string }> {
  const m = await member(req);
  const { rows } = await pool.query<{ ok: boolean }>('SELECT feed_provider_badge($1) AS ok', [m.userId]);
  if (!rows[0]?.ok) throw new HttpError(403, 'The Business Suite is for providers with a “Verified provider background” badge — verify your provider background first.', 'not_verified_provider');
  return { userId: m.userId, name: m.profile.display_name };
}

/**
 * Knowledge tier: nothing is bookable and nothing points off the Feed. Consult slots, booking and ads that go to
 * a booking or an outside link are the clinical tier's ("Licensed & verified"), dormant until it's commissioned.
 */
const clinical = (): boolean => config.clinicalTier;
function clinicalOnly(): void {
  if (!clinical()) throw new HttpError(404, 'Not found');
}
const destOf = (d: string): 'profile' | 'consult' | 'url' => (clinical() ? (d as 'profile' | 'consult' | 'url') : 'profile');

const payments = (): 'stripe' | 'stub' | 'none' => config.billingProvider;

/* ---------- campaigns ---------- */

interface CampaignRow {
  id: number;
  provider_user_id: number;
  kind: 'boost' | 'campaign';
  name: string;
  target_kind: 'post' | 'clip' | null;
  target_id: number | null;
  headline_enc: Buffer | null;
  body_enc: Buffer | null;
  key_id: string;
  image_id: number | null;
  destination: 'profile' | 'consult' | 'url';
  destination_url: string | null;
  package_code: string | null;
  budget_cents: number;
  impressions_bought: number;
  impressions: number;
  clicks: number;
  starts_on: string;
  ends_on: string | null;
  status: AdCampaign['status'];
  reject_reasons: string[];
  paid_at: Date | null;
  created_at: Date;
}
const CAMPAIGN_COLS = 'c.*, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on';
const spendOf = (r: Pick<CampaignRow, 'budget_cents' | 'impressions' | 'impressions_bought'>): number => Math.min(r.budget_cents, Math.round((r.budget_cents * r.impressions) / r.impressions_bought));

function toCampaign(r: CampaignRow): AdCampaign {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    targetKind: r.target_kind,
    targetId: r.target_id,
    headline: r.headline_enc ? openText(r.headline_enc, r.key_id) : null,
    body: r.body_enc ? openText(r.body_enc, r.key_id) : null,
    imageUrl: imageUrl(r.image_id),
    destination: r.destination,
    destinationUrl: r.destination_url,
    packageCode: r.package_code,
    budgetCents: r.budget_cents,
    impressionsBought: r.impressions_bought,
    impressions: r.impressions,
    clicks: r.clicks,
    spendCents: spendOf(r),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    status: r.status,
    rejectReasons: r.reject_reasons,
    paidAt: r.paid_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

async function campaignsOf(userId: number): Promise<AdCampaign[]> {
  const { rows } = await pool.query<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM ad_campaigns c WHERE c.provider_user_id = $1 AND c.status <> 'canceled' ORDER BY c.id DESC LIMIT 100`, [userId]);
  return rows.map(toCampaign);
}

/** The words of an ad must pass the ad screen (medical claims, personal info, crisis). Refused = nothing saved, nothing charged. */
async function mustPassAdScreen(text: string): Promise<void> {
  const s = await screenAd(text);
  if (s.reasons.length) {
    await logEvent('ad_rejected', { reasons: s.reasons.join(',') }, null, null);
    throw new HttpError(422, `This ad can’t run: ${s.explain}`, 'ad_rejected', { reasons: s.labels });
  }
}

/** Stripe Checkout for an ad or a consult (one-time). Stub: paid at once. Returns where to send the person. */
async function checkout(kind: 'ad' | 'consult', id: number, cents: number, name: string, email: string | undefined, back: string): Promise<string> {
  if (payments() === 'none') throw new HttpError(503, 'Payments aren’t live yet');
  if (payments() === 'stub') {
    await markPaid(kind, id, `stub_${kind}_${id}`, cents);
    return `${back}?paid=${kind}`;
  }
  const session = await stripe<{ id: string; url: string }>('checkout/sessions', {
    mode: 'payment',
    customer_email: email,
    client_reference_id: `${kind}:${id}`,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: cents, product_data: { name } } }],
    metadata: { myday_kind: kind, myday_id: id },
    payment_intent_data: { metadata: { myday_kind: kind, myday_id: id } },
    success_url: `${config.publicUrl}${back}?paid=${kind}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.publicUrl}${back}?canceled=${kind}`,
  });
  const table = kind === 'ad' ? 'ad_campaigns' : 'consult_slots';
  await pool.query(`UPDATE ${table} SET stripe_session_id = $2 WHERE id = $1`, [id, session.id]);
  return session.url;
}

/** Payment arrived (webhook, return-from-checkout, or stub): the ad goes live / the slot is booked. Idempotent. */
export async function markPaid(kind: 'ad' | 'consult', id: number, sessionId: string, cents: number): Promise<void> {
  if (kind === 'ad') {
    const { rowCount } = await pool.query(
      "UPDATE ad_campaigns SET status = 'active', paid_at = now(), stripe_session_id = COALESCE(stripe_session_id, $2) WHERE id = $1 AND status = 'pending_payment'",
      [id, sessionId],
    );
    if (rowCount) await logEvent('ad_paid', { cents }, null, null);
  } else {
    const { rowCount } = await pool.query(
      "UPDATE consult_slots SET status = 'booked', booked_at = now(), paid_cents = $3, held_until = NULL, stripe_session_id = COALESCE(stripe_session_id, $2) WHERE id = $1 AND status = 'held'",
      [id, sessionId, cents],
    );
    if (rowCount) await logEvent('consult_booked', { paid: cents > 0 }, null, null);
  }
}

/** From Stripe's signed webhook (routes/billing.ts): a completed one-time checkout for an ad or a consult. */
export async function checkoutCompleted(o: Record<string, unknown>): Promise<boolean> {
  const meta = (o.metadata ?? {}) as Record<string, unknown>;
  const kind = meta.myday_kind === 'ad' || meta.myday_kind === 'consult' ? meta.myday_kind : null;
  if (!kind || o.payment_status !== 'paid') return !!kind;
  await markPaid(kind, Number(meta.myday_id), String(o.id), Number(o.amount_total ?? 0));
  return true;
}

const PAID_BACK = /^cs_[A-Za-z0-9_]+$/;

/** Back from Checkout: ask Stripe whether it's paid (works even before the webhook lands). */
businessRouter.get('/api/business/checkout/confirm', async (req, res) => {
  await member(req);
  const sid = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  if (!PAID_BACK.test(sid) || payments() !== 'stripe') throw new HttpError(400, 'Nothing to confirm');
  const s = await stripeGet<Record<string, unknown>>(`checkout/sessions/${sid}`);
  const paid = await checkoutCompleted(s);
  res.json({ ok: paid && s.payment_status === 'paid' });
});

businessRouter.get('/api/business', async (req, res) => {
  const p = await provider(req);
  const out: BusinessOverview = { packages: boostPackages(), cpmCents: adCpmCents(), payments: payments(), campaigns: await campaignsOf(p.userId), slots: clinical() ? await slotsOf(p.userId) : [], bookable: clinical() };
  res.json(out);
});

/** Boost one of your own posts or clips with an impressions package. */
businessRouter.post('/api/business/boost', async (req, res) => {
  const p = await provider(req);
  const b = req.body as Record<string, unknown>;
  const pkg = boostPackages().find((x) => x.code === b.package);
  if (!pkg) throw new HttpError(400, 'Pick a package');
  const targetKind = b.targetKind === 'clip' ? 'clip' : b.targetKind === 'post' ? 'post' : null;
  if (!targetKind) throw new HttpError(400, 'Boost a post or a clip');
  const targetId = idParam(b.targetId);
  const { rows } = await pool.query<{ text_enc: Buffer | null; key_id: string }>(
    targetKind === 'post'
      ? "SELECT body_enc AS text_enc, key_id FROM social_posts WHERE id = $1 AND author_user_id = $2 AND status = 'visible'"
      : "SELECT caption_enc AS text_enc, key_id FROM social_clips WHERE id = $1 AND author_user_id = $2 AND status = 'visible'",
    [targetId, p.userId],
  );
  if (!rows[0]) throw new HttpError(404, 'Boost one of your own live posts or clips');
  const text = rows[0].text_enc ? openText(rows[0].text_enc, rows[0].key_id) : '';
  if (text) await mustPassAdScreen(text);
  const keyId = currentKeyId();
  const { rows: ins } = await pool.query<{ id: number }>(
    `INSERT INTO ad_campaigns (provider_user_id, kind, name, target_kind, target_id, key_id, destination, package_code, budget_cents, impressions_bought, starts_on)
     VALUES ($1, 'boost', $2, $3, $4, $5, 'profile', $6, $7, $8, ${TODAY}) RETURNING id`,
    [p.userId, `Boost: ${targetKind} · ${pkg.label}`, targetKind, targetId, keyId, pkg.code, pkg.cents, pkg.impressions],
  );
  const id = ins[0]?.id ?? 0;
  await logEvent('ad_created', { kind: 'boost', package: pkg.code }, null, null);
  const url = await checkout('ad', id, pkg.cents, `MyDay boost — ${pkg.label} (${pkg.impressions.toLocaleString('en-US')} impressions)`, req.user?.email, '/business');
  res.status(201).json({ campaign: (await campaignsOf(p.userId)).find((c) => c.id === id), url });
});

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

/** A campaign: its own creative, a destination, a budget and a schedule. */
businessRouter.post('/api/business/campaigns', async (req, res) => {
  const p = await provider(req);
  const b = req.body as Record<string, unknown>;
  const name = str(b.name, 'name', 80, true);
  const headline = str(b.headline, 'headline', 80, true);
  const body = str(b.body, 'body', 300, true);
  const destination = b.destination === 'consult' ? 'consult' : b.destination === 'url' ? 'url' : 'profile';
  if (destination !== 'profile' && !clinical()) throw new HttpError(400, 'Ads point to your profile on the Feed — providers don’t steer people to bookings or outside sites.', 'destination');
  let destinationUrl: string | null = null;
  if (destination === 'url') {
    destinationUrl = str(b.destinationUrl, 'destinationUrl', 300, true);
    let u: URL | null = null;
    try {
      u = new URL(destinationUrl);
    } catch {
      u = null;
    }
    if (!u || u.protocol !== 'https:') throw new HttpError(400, 'The link has to be a full https:// address');
  }
  const budget = Number(b.budgetCents);
  if (!Number.isInteger(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) throw new HttpError(400, `A budget is $${MIN_BUDGET / 100}–$${MAX_BUDGET / 100}`);
  const startsOn = isDate(b.startsOn) ? b.startsOn : null;
  const endsOn = isDate(b.endsOn) ? b.endsOn : null;
  if (startsOn && endsOn && endsOn < startsOn) throw new HttpError(400, 'The end date is before the start');
  let imageId: number | null = null;
  if (b.imageId !== undefined && b.imageId !== null) {
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM community_images WHERE id = $1 AND user_id = $2 AND status = 'visible'", [idParam(b.imageId), p.userId]);
    if (!rows[0]) throw new HttpError(400, 'Use one of your own approved photos');
    imageId = rows[0].id;
  }
  await mustPassAdScreen(`${headline}\n\n${body}`);
  const impressions = Math.max(1, Math.floor((budget * 1000) / adCpmCents()));
  const keyId = currentKeyId();
  const { rows: ins } = await pool.query<{ id: number }>(
    `INSERT INTO ad_campaigns (provider_user_id, kind, name, headline_enc, body_enc, key_id, image_id, destination, destination_url, budget_cents, impressions_bought, starts_on, ends_on)
     VALUES ($1, 'campaign', $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::date, ${TODAY}), $12) RETURNING id`,
    [p.userId, name, sealText(headline, keyId), sealText(body, keyId), keyId, imageId, destination, destinationUrl, budget, impressions, startsOn, endsOn],
  );
  const id = ins[0]?.id ?? 0;
  await logEvent('ad_created', { kind: 'campaign' }, null, null);
  const url = await checkout('ad', id, budget, `MyDay ad campaign — ${name}`, req.user?.email, '/business');
  res.status(201).json({ campaign: (await campaignsOf(p.userId)).find((c) => c.id === id), url });
});

/** Ad copy check without saving (the form's "Check my ad"). */
businessRouter.post('/api/business/ads/check', async (req, res) => {
  await provider(req);
  const b = req.body as Record<string, unknown>;
  const s = await screenAd(`${str(b.headline, 'headline', 80)}\n\n${str(b.body, 'body', 300)}`);
  res.json({ ok: !s.reasons.length, reasons: s.labels, explain: s.reasons.length ? s.explain : null });
});

for (const [action, from, to] of [
  ['pause', 'active', 'paused'],
  ['resume', 'paused', 'active'],
] as const) {
  businessRouter.post(`/api/business/campaigns/:id/${action}`, async (req, res) => {
    const p = await provider(req);
    const { rowCount } = await pool.query(`UPDATE ad_campaigns SET status = '${to}' WHERE id = $1 AND provider_user_id = $2 AND status = '${from}'`, [idParam(req.params.id), p.userId]);
    if (!rowCount) throw new HttpError(409, `Only a ${from} campaign can be ${to === 'paused' ? 'paused' : 'resumed'}`);
    res.json({ campaigns: await campaignsOf(p.userId) });
  });
}

/** An unpaid campaign can be dropped (nothing was charged). */
businessRouter.delete('/api/business/campaigns/:id', async (req, res) => {
  const p = await provider(req);
  const { rowCount } = await pool.query("UPDATE ad_campaigns SET status = 'canceled' WHERE id = $1 AND provider_user_id = $2 AND status = 'pending_payment'", [idParam(req.params.id), p.userId]);
  if (!rowCount) throw new HttpError(409, 'Only an unpaid campaign can be removed — pause a running one instead');
  res.json({ campaigns: await campaignsOf(p.userId) });
});

/* ---------- serving: one sponsored item per Feed / Clips page, labelled ---------- */

interface ServeRow extends CampaignRow, AuthorCols {}

/** Pick a live campaign for this grown-up (not their own, not someone they've blocked), count the impression. */
export async function sponsoredFor(viewer: number, where: 'feed' | 'clips'): Promise<SponsoredItem | null> {
  const render = {
    post: async (id: number): Promise<FeedPost | null> => (await feedPage(viewer, { tab: 'everyone', author: null, before: null, id })).posts[0] ?? null,
    clip: (id: number): Promise<ClipItem | null> => clipFor(viewer, id).catch(() => null),
  };
  // Done or out of date: completed.
  await pool.query(
    `UPDATE ad_campaigns SET status = 'completed' WHERE status = 'active' AND (impressions >= impressions_bought OR (ends_on IS NOT NULL AND ends_on < ${TODAY}))`,
  );
  const { rows } = await pool.query<ServeRow>(
    `SELECT ${CAMPAIGN_COLS}, ${AUTHOR_COLS}
       FROM ad_campaigns c ${AUTHOR_JOIN('c.provider_user_id')}
      WHERE c.status = 'active' AND c.starts_on <= ${TODAY} AND c.provider_user_id <> $1 AND p.banned_at IS NULL
        AND ${NOT_BLOCKED('c.provider_user_id')}
        AND ($2 = 'feed' OR c.target_kind = 'clip')
        AND feed_provider_badge(c.provider_user_id)
      ORDER BY EXISTS (SELECT 1 FROM ad_impressions i WHERE i.campaign_id = c.id AND i.viewer_user_id = $1 AND i.day = ${TODAY}), random()
      LIMIT 3`,
    [viewer, where],
  );
  for (const r of rows) {
    let post: FeedPost | null = null;
    let clip: ClipItem | null = null;
    if (r.target_kind === 'post' && r.target_id) post = await render.post(r.target_id);
    if (r.target_kind === 'clip' && r.target_id) clip = await render.clip(r.target_id);
    if (r.target_kind && !post && !clip) continue; // the boosted item is gone or held
    const { rowCount } = await pool.query(`INSERT INTO ad_impressions (campaign_id, viewer_user_id, day) VALUES ($1, $2, ${TODAY}) ON CONFLICT DO NOTHING`, [r.id, viewer]);
    if (rowCount) await pool.query('UPDATE ad_campaigns SET impressions = impressions + 1 WHERE id = $1', [r.id]);
    const a = author(r);
    const dest = destOf(r.destination);
    const href = dest === 'url' && r.destination_url ? r.destination_url : dest === 'consult' ? `/people/${a.userId}?book=1` : `/people/${a.userId}`;
    return {
      campaignId: r.id,
      kind: r.kind === 'boost' ? (r.target_kind ?? 'post') : 'campaign',
      provider: a,
      headline: r.headline_enc ? openText(r.headline_enc, r.key_id) : null,
      body: r.body_enc ? openText(r.body_enc, r.key_id) : null,
      imageUrl: imageUrl(r.image_id),
      post,
      clip,
      destination: dest,
      href,
      external: dest === 'url',
      cta: dest === 'url' ? 'Learn more' : dest === 'consult' ? 'Book a consult' : 'View profile',
    };
  }
  return null;
}

sponsorHook.feed = (viewer) => sponsoredFor(viewer, 'feed');
sponsorHook.clips = (viewer) => sponsoredFor(viewer, 'clips');

businessRouter.post('/api/ads/:id/click', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const { rows } = await pool.query<CampaignRow>(`SELECT ${CAMPAIGN_COLS} FROM ad_campaigns c WHERE c.id = $1 AND c.status IN ('active', 'completed', 'paused')`, [id]);
  const r = rows[0];
  if (!r || (await block(m.userId, r.provider_user_id))) throw new HttpError(404, 'Not found');
  if (r.provider_user_id !== m.userId) {
    const { rowCount } = await pool.query('INSERT INTO ad_clicks (campaign_id, viewer_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m.userId]);
    if (rowCount) await pool.query('UPDATE ad_campaigns SET clicks = clicks + 1 WHERE id = $1', [id]);
  }
  const dest = destOf(r.destination);
  const href = dest === 'url' && r.destination_url ? r.destination_url : dest === 'consult' ? `/people/${r.provider_user_id}?book=1` : `/people/${r.provider_user_id}`;
  res.json({ href, external: dest === 'url' });
});

/* ---------- consult slots ---------- */

interface SlotRow {
  id: number;
  provider_user_id: number;
  starts_at: Date;
  minutes: number;
  price_cents: number;
  status: ConsultSlot['status'];
  booked_by: number | null;
  booked_at: Date | null;
  paid_cents: number;
  booker_name?: string | null;
}
const toSlot = (r: SlotRow, viewer: number): ConsultSlot => ({
  id: r.id,
  providerUserId: r.provider_user_id,
  startsAt: r.starts_at.toISOString(),
  minutes: r.minutes,
  priceCents: r.price_cents,
  status: r.status,
  mine: r.booked_by === viewer,
  bookedBy: r.provider_user_id === viewer ? (r.booker_name ?? null) : null,
  paidCents: r.provider_user_id === viewer || r.booked_by === viewer ? r.paid_cents : 0,
});

/** Let a hold lapse after 20 minutes of not paying. */
const RELEASE_HOLDS = "UPDATE consult_slots SET status = 'open', booked_by = NULL, held_until = NULL, stripe_session_id = NULL WHERE status = 'held' AND held_until < now()";

async function slotsOf(userId: number): Promise<ConsultSlot[]> {
  await pool.query(RELEASE_HOLDS);
  const { rows } = await pool.query<SlotRow>(
    `SELECT s.*, sp.display_name AS booker_name FROM consult_slots s LEFT JOIN social_profiles sp ON sp.user_id = s.booked_by
      WHERE s.provider_user_id = $1 AND s.status <> 'canceled' AND s.starts_at > now() - interval '1 day' ORDER BY s.starts_at LIMIT 100`,
    [userId],
  );
  return rows.map((r) => toSlot(r, userId));
}

businessRouter.post('/api/business/slots', async (req, res) => {
  clinicalOnly();
  const p = await provider(req);
  const b = req.body as Record<string, unknown>;
  const startsAt = new Date(String(b.startsAt ?? ''));
  if (Number.isNaN(startsAt.getTime())) throw new HttpError(400, 'Pick a time in the future');
  // The database's clock, like every other slot rule here (open, held, booked).
  const { rows: future } = await pool.query<{ ok: boolean }>("SELECT $1::timestamptz > now() + interval '15 minutes' AS ok", [startsAt]);
  if (!future[0]?.ok) throw new HttpError(400, 'Pick a time in the future');
  const minutes = Number(b.minutes);
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 180) throw new HttpError(400, 'A consult is 10–180 minutes');
  const price = Number(b.priceCents ?? 0);
  if (!Number.isInteger(price) || price < 0 || price > 100000) throw new HttpError(400, 'Price is $0–$1,000');
  if (price > 0 && price < 50) throw new HttpError(400, 'A paid consult is at least $0.50');
  try {
    await pool.query('INSERT INTO consult_slots (provider_user_id, starts_at, minutes, price_cents) VALUES ($1, $2, $3, $4)', [p.userId, startsAt, minutes, price]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, 'You already have a slot at that time');
    throw e;
  }
  res.status(201).json({ slots: await slotsOf(p.userId) });
});

businessRouter.delete('/api/business/slots/:id', async (req, res) => {
  clinicalOnly();
  const p = await provider(req);
  const { rowCount } = await pool.query("UPDATE consult_slots SET status = 'canceled' WHERE id = $1 AND provider_user_id = $2 AND status = 'open'", [idParam(req.params.id), p.userId]);
  if (!rowCount) throw new HttpError(409, 'Only an open slot can be removed');
  res.json({ slots: await slotsOf(p.userId) });
});

/** A verified provider's open slots (any grown-up in the Feed). */
businessRouter.get('/api/providers/:userId/slots', async (req, res) => {
  clinicalOnly();
  const m = await member(req);
  const who = idParam(req.params.userId);
  if (await block(m.userId, who)) throw new HttpError(404, 'Not found');
  await pool.query(RELEASE_HOLDS);
  const { rows } = await pool.query<SlotRow>(
    `SELECT s.* FROM consult_slots s
      WHERE feed_provider_badge(s.provider_user_id) AND s.provider_user_id = $1 AND s.starts_at > now() AND (s.status = 'open' OR s.booked_by = $2) ORDER BY s.starts_at LIMIT 30`,
    [who, m.userId],
  );
  res.json({ slots: rows.map((r) => toSlot(r, m.userId)) });
});

/** Book a slot: free → booked now; paid → held 20 minutes while Stripe Checkout takes the payment. */
businessRouter.post('/api/consults/:slotId/book', async (req, res) => {
  clinicalOnly();
  const m = await poster(req, false);
  const id = idParam(req.params.slotId);
  await pool.query(RELEASE_HOLDS);
  const { rows } = await pool.query<SlotRow & { name: string }>(
    `UPDATE consult_slots s SET status = 'held', booked_by = $2, held_until = now() + interval '20 minutes'
       FROM social_profiles sp
      WHERE s.id = $1 AND s.status = 'open' AND s.starts_at > now() AND s.provider_user_id <> $2 AND sp.user_id = s.provider_user_id
        AND feed_provider_badge(s.provider_user_id)
        AND NOT EXISTS (SELECT 1 FROM social_blocks b WHERE (b.blocker_user_id = $2 AND b.blocked_user_id = s.provider_user_id) OR (b.blocker_user_id = s.provider_user_id AND b.blocked_user_id = $2))
      RETURNING s.*, sp.display_name AS name`,
    [id, m.userId],
  );
  const s = rows[0];
  if (!s) throw new HttpError(409, 'That time was just taken — pick another', 'slot_taken');
  if (s.price_cents === 0) {
    await markPaid('consult', s.id, `free_${s.id}`, 0);
    res.status(201).json({ booked: true, url: null });
    return;
  }
  const when = s.starts_at.toLocaleString('en-US', { timeZone: config.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const url = await checkout('consult', s.id, s.price_cents, `Consult with ${s.name} — ${when} (${s.minutes} min)`, req.user?.email, `/people/${s.provider_user_id}`);
  res.status(201).json({ booked: payments() === 'stub', url });
});

businessRouter.get('/api/consults/mine', async (req, res) => {
  clinicalOnly();
  const m = await member(req);
  const { rows } = await pool.query<SlotRow & AuthorCols>(
    `SELECT s.*, ${AUTHOR_COLS} FROM consult_slots s ${AUTHOR_JOIN('s.provider_user_id')}
      WHERE s.booked_by = $1 AND s.status = 'booked' AND s.starts_at > now() - interval '1 day' ORDER BY s.starts_at`,
    [m.userId],
  );
  res.json({ consults: rows.map((r) => ({ ...toSlot(r, m.userId), provider: author(r) })) });
});

/* ---------- analytics: your own numbers, never anyone else's ---------- */

const RANGES = [7, 30, 90] as const;

async function analytics(userId: number, days: number): Promise<BusinessAnalytics> {
  const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query<T>(sql, [userId, days, config.tz, ...params])).rows;
  // Every count is "where the provider is the author/owner" ($1) and "in the last N days" ($2), dated in the app's time zone ($3).
  const since = `((now() AT TIME ZONE $3)::date - ($2::int - 1))`;
  const local = (col: string): string => `(${col} AT TIME ZONE $3)::date`;
  const series = await q<{ day: string; profile_views: number; follows: number; post_views: number; clip_views: number; story_views: number; engagement: number; bookings: number; revenue: number }>(
    `WITH d AS (SELECT generate_series(${since}, (now() AT TIME ZONE $3)::date, interval '1 day')::date AS day)
     SELECT d.day::text AS day,
       (SELECT COUNT(*)::int FROM social_profile_views v WHERE v.profile_user_id = $1 AND v.day = d.day) AS profile_views,
       (SELECT COUNT(*)::int FROM social_follows f WHERE f.followed_user_id = $1 AND ${local('f.created_at')} = d.day) AS follows,
       (SELECT COUNT(*)::int FROM social_post_views v JOIN social_posts p ON p.id = v.post_id WHERE p.author_user_id = $1 AND v.day = d.day) AS post_views,
       (SELECT COUNT(*)::int FROM social_clip_views v JOIN social_clips c ON c.id = v.clip_id WHERE c.author_user_id = $1 AND ${local('v.viewed_at')} = d.day) AS clip_views,
       (SELECT COUNT(*)::int FROM social_story_views v JOIN social_stories s ON s.id = v.story_id WHERE s.author_user_id = $1 AND v.viewer_user_id <> $1 AND ${local('v.viewed_at')} = d.day) AS story_views,
       ((SELECT COUNT(*) FROM social_likes l JOIN social_posts p ON p.id = l.post_id WHERE p.author_user_id = $1 AND l.user_id <> $1 AND ${local('l.created_at')} = d.day)
        + (SELECT COUNT(*) FROM social_clip_likes l JOIN social_clips c ON c.id = l.clip_id WHERE c.author_user_id = $1 AND l.user_id <> $1 AND ${local('l.created_at')} = d.day)
        + (SELECT COUNT(*) FROM social_clip_comments k JOIN social_clips c ON c.id = k.clip_id WHERE c.author_user_id = $1 AND k.author_user_id <> $1 AND k.status = 'visible' AND ${local('k.created_at')} = d.day))::int AS engagement,
       (SELECT COUNT(*)::int FROM consult_slots s WHERE s.provider_user_id = $1 AND s.status = 'booked' AND ${local('s.booked_at')} = d.day) AS bookings,
       (SELECT COALESCE(SUM(s.paid_cents), 0)::int FROM consult_slots s WHERE s.provider_user_id = $1 AND s.status = 'booked' AND ${local('s.booked_at')} = d.day) AS revenue
     FROM d ORDER BY d.day`,
  );
  const [tot] = await q<{ followers: number; followers_before: number }>(
    `SELECT (SELECT COUNT(*)::int FROM social_follows WHERE followed_user_id = $1) AS followers,
            (SELECT COUNT(*)::int FROM social_follows WHERE followed_user_id = $1 AND ${local('created_at')} < ${since}) AS followers_before`,
  );
  let running = tot?.followers_before ?? 0;
  const sum = (k: keyof (typeof series)[number]): number => series.reduce((n, r) => n + Number(r[k]), 0);
  const top = await q<{ kind: 'post' | 'clip'; id: number; text_enc: Buffer | null; key_id: string; views: number; engagement: number; at: Date }>(
    `SELECT * FROM (
       SELECT 'post' AS kind, p.id, p.body_enc AS text_enc, p.key_id, p.created_at AS at,
              (SELECT COUNT(*)::int FROM social_post_views v WHERE v.post_id = p.id AND v.day >= ${since}) AS views,
              (SELECT COUNT(*)::int FROM social_likes l WHERE l.post_id = p.id AND l.user_id <> $1 AND ${local('l.created_at')} >= ${since}) AS engagement
         FROM social_posts p WHERE p.author_user_id = $1 AND p.status = 'visible'
       UNION ALL
       SELECT 'clip', c.id, c.caption_enc, c.key_id, c.created_at,
              (SELECT COUNT(*)::int FROM social_clip_views v WHERE v.clip_id = c.id AND ${local('v.viewed_at')} >= ${since}),
              ((SELECT COUNT(*) FROM social_clip_likes l WHERE l.clip_id = c.id AND l.user_id <> $1 AND ${local('l.created_at')} >= ${since})
               + (SELECT COUNT(*) FROM social_clip_comments k WHERE k.clip_id = c.id AND k.author_user_id <> $1 AND k.status = 'visible' AND ${local('k.created_at')} >= ${since}))::int
         FROM social_clips c WHERE c.author_user_id = $1 AND c.status = 'visible'
     ) x WHERE x.views > 0 OR x.engagement > 0 ORDER BY x.views + 3 * x.engagement DESC, x.at DESC LIMIT 5`,
  );
  const [ads] = await q<{ impressions: number; clicks: number }>(
    `SELECT (SELECT COUNT(*)::int FROM ad_impressions i JOIN ad_campaigns c ON c.id = i.campaign_id WHERE c.provider_user_id = $1 AND i.day >= ${since}) AS impressions,
            (SELECT COUNT(*)::int FROM ad_clicks k JOIN ad_campaigns c ON c.id = k.campaign_id WHERE c.provider_user_id = $1 AND ${local('k.clicked_at')} >= ${since}) AS clicks`,
  );
  const spend = (await campaignsOf(userId)).reduce((n, c) => n + c.spendCents, 0);
  const postViews = sum('post_views');
  const clipViews = sum('clip_views');
  const storyViews = sum('story_views');
  const engagement = sum('engagement');
  const contentViews = postViews + clipViews + storyViews;
  return {
    rangeDays: days,
    totals: {
      profileViews: sum('profile_views'),
      newFollowers: sum('follows'),
      followers: tot?.followers ?? 0,
      postViews,
      clipViews,
      storyViews,
      engagement,
      engagementRate: contentViews ? Math.round((engagement / contentViews) * 1000) / 10 : 0,
      consultBookings: sum('bookings'),
      revenueCents: sum('revenue'),
      adImpressions: ads?.impressions ?? 0,
      adClicks: ads?.clicks ?? 0,
      adSpendCents: spend,
    },
    daily: series.map((r) => {
      running += r.follows;
      return {
        day: r.day,
        profileViews: r.profile_views,
        follows: r.follows,
        followers: running,
        views: r.post_views + r.clip_views + r.story_views,
        engagement: r.engagement,
        bookings: r.bookings,
        revenueCents: r.revenue,
      };
    }),
    top: top.map((t) => ({ kind: t.kind, id: t.id, text: (t.text_enc ? openText(t.text_enc, t.key_id) : '').slice(0, 120), views: t.views, engagement: t.engagement, at: t.at.toISOString() })),
  };
}

const rangeOf = (v: unknown): number => {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? n : 30;
};

businessRouter.get('/api/business/analytics', async (req, res) => {
  const p = await provider(req);
  // Always the signed-in provider's own numbers — there is no "whose" parameter to change.
  res.json(await analytics(p.userId, rangeOf(req.query.range)));
});

const csvCell = (v: string | number): string => (typeof v === 'number' ? String(v) : /[",\n]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"` : v);

businessRouter.get('/api/business/analytics.csv', async (req, res) => {
  const p = await provider(req);
  const a = await analytics(p.userId, rangeOf(req.query.range));
  const lines = [
    ['date', 'profile_views', 'new_followers', 'followers', 'content_views', 'engagement', 'consult_bookings', 'revenue_usd'].join(','),
    ...a.daily.map((d) => [d.day, d.profileViews, d.follows, d.followers, d.views, d.engagement, d.bookings, (d.revenueCents / 100).toFixed(2)].map(csvCell).join(',')),
  ];
  res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="myday-analytics-${a.rangeDays}d.csv"`)
    .set('Cache-Control', 'no-store')
    .send(`${lines.join('\n')}\n`);
});
