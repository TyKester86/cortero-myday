/**
 * Provider Knowledge Base v1 — signup, verification, the badge, the review queue.
 *
 * Signed out, the check runs BEFORE any account exists: rejected → the reason, nothing kept; verified or needs
 * review → a short-lived pass the sign-in carries (instead of a date of birth — an NPI-verified provider is an
 * adult), and the account is made then. Signed in, an existing member applies the same way.
 * Nothing here books, lists or schedules: providers are community members with a badge.
 */
import express, { Router } from 'express';
import { MH_TAXONOMIES, isMentalHealth, monthlyOig, noticeProvider, providerPass, recheckProviders, refreshOig, runGates, setBadge, taxonomyLabel } from '../lib/providers.js';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, str } from '../lib/http.js';
import { rateLimiter } from '../lib/pin.js';
import { screenText } from '../lib/screen.js';
import { currentKeyId, sealText } from '../lib/seal.js';
import { profileRow, staff } from './community.js';

export const providersPublicRouter = Router();
export const providersRouter = Router();

const json = express.json({ limit: '20kb', type: 'application/json' });
const checkLimit = rateLimiter(config.production ? 10 : 500, 15 * 60_000);
const FIRST_NAME = /^\p{L}[\p{L}'’-]{0,23}$/u;
const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));

export const PROVIDER_DISCLAIMER = 'Not your therapist. Posts are educational, not medical advice.';
export const PROVIDER_RULES = [
  'You post and answer as a member with a credentialed background — not as anyone’s clinician.',
  'No diagnosing, assessing or treating anyone in posts, comments or messages.',
  'No offering your services or steering people to bookings, your practice, or off the Feed. First time: a warning and your badge is paused. Second time: the badge is removed.',
  'Crisis words bring up 988 for everyone, providers included.',
  'Your profile always says: “Not your therapist. Posts are educational, not medical advice.”',
];

providersPublicRouter.get('/api/providers/taxonomies', (_req, res) => {
  res.json({ taxonomies: MH_TAXONOMIES, rules: PROVIDER_RULES, disclaimer: PROVIDER_DISCLAIMER });
});

interface Form {
  legalName: string;
  displayName: string;
  npi: string;
  taxonomy: string;
  licenseStates: string[];
  credentials: string | null;
  bio: string | null;
}

async function readForm(b: Record<string, unknown>): Promise<Form> {
  const legalName = str(b.legalName, 'legalName', 120, true).replace(/\s+/g, ' ');
  if (legalName.split(' ').length < 2) throw new HttpError(400, 'Your full legal name, as on your NPI record', 'legal_name');
  const displayName = str(b.displayName, 'displayName', 24, true);
  if (!FIRST_NAME.test(displayName)) throw new HttpError(400, 'The name people see: your first name only — one word.', 'first_name_only');
  const npi = str(b.npi, 'npi', 20, true).replace(/\D/g, '');
  if (!/^\d{10}$/.test(npi)) throw new HttpError(400, 'An NPI is 10 digits', 'npi_format');
  const taxonomy = str(b.taxonomy, 'taxonomy', 12, true);
  if (!isMentalHealth(taxonomy)) throw new HttpError(400, 'Pick a mental-health specialty', 'taxonomy');
  const licenseStates = (Array.isArray(b.licenseStates) ? b.licenseStates : []).map((s) => String(s).toUpperCase()).filter((s) => STATES.has(s)).slice(0, 10);
  const credentials = str(b.credentials, 'credentials', 60) || null;
  const bio = str(b.bio, 'bio', 280) || null;
  if (b.agree !== true) throw new HttpError(400, 'Read and accept the provider rules first', 'rules');
  for (const t of [bio, credentials]) {
    if (t && (await screenText(t)).hold) throw new HttpError(422, 'Keep the bio about you and your work — no contact details or offers.', 'bio_held');
  }
  return { legalName, displayName, npi, taxonomy, licenseStates, credentials, bio };
}

const taken = async (npi: string, userId: number | null): Promise<boolean> =>
  !!(await asSystem(() => pool.query("SELECT 1 FROM provider_verifications WHERE npi = $1 AND status <> 'rejected' AND user_id IS DISTINCT FROM $2", [npi, userId]))).rowCount;

/** A verified/needs-review result becomes this person's provider record (and their Feed profile, if they have none). */
export async function attachProvider(
  userId: number,
  f: Form & { status: 'verified' | 'needs_review'; reason: string | null; nppesName: string; nameScore: number; taxonomies: unknown },
): Promise<void> {
  await asSystem(async () => {
    if (!(await profileRow(userId))) {
      const keyId = currentKeyId();
      await pool.query(
        'INSERT INTO social_profiles (user_id, display_name, bio_enc, key_id, adult_confirmed_at, guidelines_accepted_at) VALUES ($1, $2, $3, $4, now(), now()) ON CONFLICT (user_id) DO NOTHING',
        [userId, f.displayName, f.bio ? sealText(f.bio, keyId) : null, keyId],
      );
    }
    const active = f.status === 'verified';
    await pool.query(
      `INSERT INTO provider_verifications (user_id, legal_name, npi, taxonomy_code, license_states, credentials, status, reason, nppes_name, name_score, nppes_taxonomies, oig_checked_at, badge_state, badge_changed_at, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12,now(),$13)
       ON CONFLICT (user_id) DO UPDATE SET legal_name = EXCLUDED.legal_name, npi = EXCLUDED.npi, taxonomy_code = EXCLUDED.taxonomy_code, license_states = EXCLUDED.license_states,
         credentials = EXCLUDED.credentials, status = EXCLUDED.status, reason = EXCLUDED.reason, nppes_name = EXCLUDED.nppes_name, name_score = EXCLUDED.name_score,
         nppes_taxonomies = EXCLUDED.nppes_taxonomies, oig_checked_at = now(), badge_state = EXCLUDED.badge_state, badge_changed_at = now(), verified_at = EXCLUDED.verified_at, submitted_at = now()`,
      [userId, f.legalName, f.npi, f.taxonomy, f.licenseStates, f.credentials, f.status, f.reason, f.nppesName, f.nameScore, JSON.stringify(f.taxonomies), active ? 'active' : 'none', active ? new Date() : null],
    );
    if (active) await noticeProvider(userId, 'verified');
  });
}

/** After sign-in: the pass's application becomes this account's provider record (once). */
export async function claimProviderApplication(appId: string, userId: number): Promise<void> {
  const { rows } = await pool.query<{
    legal_name: string; display_name: string; npi: string; taxonomy_code: string; license_states: string[]; credentials: string | null; bio: string | null;
    status: 'verified' | 'needs_review'; reason: string | null; nppes_name: string; name_score: string; nppes_taxonomies: unknown;
  }>("UPDATE provider_applications SET claimed_by = $2, claimed_at = now() WHERE id = $1 AND claimed_by IS NULL AND created_at > now() - interval '2 hours' RETURNING *", [appId, userId]);
  const a = rows[0];
  if (!a) return;
  const { rowCount: has } = await pool.query("SELECT 1 FROM provider_verifications WHERE user_id = $1 AND status <> 'rejected'", [userId]);
  if (has) return;
  if (await taken(a.npi, userId)) return;
  await attachProvider(userId, {
    legalName: a.legal_name, displayName: a.display_name, npi: a.npi, taxonomy: a.taxonomy_code, licenseStates: a.license_states, credentials: a.credentials, bio: a.bio,
    status: a.status, reason: a.reason, nppesName: a.nppes_name, nameScore: Number(a.name_score), taxonomies: a.nppes_taxonomies,
  });
}

/** The check. Signed out: a pass for sign-in (or the reason it failed — and no account). Signed in: attached now. */
providersPublicRouter.post('/api/providers/check', json, async (req, res) => {
  if (!checkLimit(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const f = await readForm((req.body ?? {}) as Record<string, unknown>);
  const userId = req.user?.id ?? null;
  if (userId !== null) {
    const { rows } = await asSystem(() => pool.query<{ status: string }>("SELECT status FROM provider_verifications WHERE user_id = $1 AND status <> 'rejected'", [userId]));
    if (rows[0]) throw new HttpError(409, 'Your provider background is already on file.', 'already');
  }
  if (await taken(f.npi, userId)) throw new HttpError(409, 'That NPI is already linked to an account.', 'npi_taken');
  const g = await runGates({ legalName: f.legalName, npi: f.npi, taxonomy: f.taxonomy });
  await asSystem(() => logEvent('provider_checked', { result: g.status }, null, null));
  if (g.status === 'rejected') {
    res.status(422).json({ status: 'rejected', reason: g.reason });
    return;
  }
  const message = g.status === 'verified' ? 'Verified — your “Verified provider background” badge goes live as soon as you’re signed in.' : 'We’re reviewing your credentials. You can join now; the badge appears once a person clears it.';
  if (userId !== null) {
    await attachProvider(userId, { ...f, ...g });
    res.json({ status: g.status, message: g.status === 'verified' ? 'Verified — your badge is live.' : 'We’re reviewing your credentials. The badge appears once a person clears it.' });
    return;
  }
  const { rows } = await asSystem(() =>
    pool.query<{ id: string }>(
      `INSERT INTO provider_applications (legal_name, display_name, npi, taxonomy_code, license_states, credentials, bio, status, reason, nppes_name, name_score, nppes_taxonomies)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [f.legalName, f.displayName, f.npi, f.taxonomy, f.licenseStates, f.credentials, f.bio, g.status, g.reason, g.nppesName, g.nameScore, JSON.stringify(g.taxonomies)],
    ),
  );
  res.json({ status: g.status, message, pass: providerPass(rows[0]!.id) });
});

/** Your provider record (Settings → Provider background). */
providersRouter.get('/api/providers/me', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  const { rows } = await asSystem(() =>
    pool.query<{ status: string; reason: string | null; badge_state: string; taxonomy_code: string; credentials: string | null; license_states: string[]; npi: string; solicitation_strikes: number; verified_at: Date | null }>(
      'SELECT status, reason, badge_state, taxonomy_code, credentials, license_states, npi, solicitation_strikes, verified_at FROM provider_verifications WHERE user_id = $1',
      [req.user!.id],
    ),
  );
  const r = rows[0];
  res.json({
    provider: r
      ? { status: r.status, reason: r.reason, badge: r.badge_state, specialty: taxonomyLabel(r.taxonomy_code), credentials: r.credentials, licenseStates: r.license_states, npiLast4: r.npi.slice(-4), strikes: r.solicitation_strikes, verifiedAt: r.verified_at?.toISOString() ?? null }
      : null,
    rules: PROVIDER_RULES,
    disclaimer: PROVIDER_DISCLAIMER,
  });
});

/* ---------- staff: the needs-review queue, decisions, reinstating a paused badge ---------- */

providersRouter.get('/api/providers/review', async (req, res) => {
  staff(req);
  const { rows } = await asSystem(() =>
    pool.query<{ user_id: number; legal_name: string; nppes_name: string | null; name_score: string | null; npi: string; taxonomy_code: string; reason: string | null; badge_state: string; submitted_at: Date; display_name: string | null }>(
      `SELECT v.user_id, v.legal_name, v.nppes_name, v.name_score, v.npi, v.taxonomy_code, v.reason, v.badge_state, v.submitted_at, sp.display_name
         FROM provider_verifications v LEFT JOIN social_profiles sp ON sp.user_id = v.user_id
        WHERE v.status = 'needs_review' OR v.badge_state = 'suspended' ORDER BY v.submitted_at`,
    ),
  );
  res.json({
    providers: rows.map((r) => ({
      userId: r.user_id, displayName: r.display_name, legalName: r.legal_name, registryName: r.nppes_name, nameScore: r.name_score === null ? null : Number(r.name_score),
      npi: r.npi, specialty: taxonomyLabel(r.taxonomy_code), reason: r.reason, badge: r.badge_state, submittedAt: r.submitted_at.toISOString(),
    })),
  });
});

providersRouter.post('/api/providers/:userId/decision', async (req, res) => {
  staff(req);
  const s = { userId: req.user!.id };
  const userId = Number(req.params.userId);
  const b = (req.body ?? {}) as { decision?: unknown; reason?: unknown };
  const reason = str(b.reason, 'reason', 200) || 'name mismatch';
  if (b.decision === 'verify') {
    const { rowCount } = await asSystem(() =>
      pool.query("UPDATE provider_verifications SET status = 'verified', reason = NULL, verified_at = now(), reviewed_by = $2, badge_state = 'active', badge_changed_at = now() WHERE user_id = $1 AND status = 'needs_review'", [userId, s.userId]),
    );
    if (!rowCount) throw new HttpError(404, 'Not in the review queue');
    await asSystem(() => noticeProvider(userId, 'verified'));
  } else if (b.decision === 'reject') {
    const { rowCount } = await asSystem(() =>
      pool.query("UPDATE provider_verifications SET status = 'rejected', reason = $3, reviewed_by = $2, badge_state = 'none', badge_changed_at = now() WHERE user_id = $1 AND status = 'needs_review'", [userId, s.userId, reason]),
    );
    if (!rowCount) throw new HttpError(404, 'Not in the review queue');
    await asSystem(() => noticeProvider(userId, 'rejected', ` Reason: ${reason}.`));
  } else if (b.decision === 'reinstate') {
    const { rowCount } = await asSystem(() => pool.query("UPDATE provider_verifications SET reviewed_by = $2 WHERE user_id = $1 AND badge_state = 'suspended' AND status = 'verified'", [userId, s.userId]));
    if (!rowCount) throw new HttpError(404, 'No paused badge to reinstate');
    await asSystem(() => setBadge(userId, 'active'));
  } else throw new HttpError(400, 'decision: verify, reject or reinstate');
  await asSystem(() => logEvent('provider_reviewed', { action: String(b.decision) }, null, null));
  res.json({ ok: true });
});

/** Local/tests only: refresh the OIG mirror from a URL now and re-check every provider (the monthly job, on demand). */
providersRouter.post('/api/dev/providers/oig', async (req, res) => {
  if (config.production || !config.devLoginToken || req.query.token !== config.devLoginToken) throw new HttpError(404, 'Not found');
  const url = typeof req.query.url === 'string' ? req.query.url : null;
  if (url) {
    const rows = await refreshOig(url);
    res.json({ rows, recheck: await recheckProviders() });
    return;
  }
  res.json(await monthlyOig(true));
});
