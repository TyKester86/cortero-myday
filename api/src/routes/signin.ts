/**
 * Sign in without Google:
 *
 *   - Email link: type your email, tap the link we send (15 minutes, one
 *     use). The answer never says whether an account exists.
 *   - Sign in with Apple: Apple posts back a signed id_token (form_post); we
 *     verify its signature against Apple's keys, the audience, expiry and our
 *     nonce. APPLE_CLIENT_ID (the Services ID) turns it on.
 *
 * Both end in the same place as Google sign-in (upsertUser): roster members
 * by email, invites, and new households.
 */
import { createHash, createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual, type webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;
import express, { Router, type Request, type Response } from 'express';
import { asSystem, pool } from '../db.js';
import { config } from '../config.js';
import { onFeedApp, originFor } from '../lib/hosts.js';
import { ageFrom, ageToken, verifyAgeToken } from '../lib/age.js';
import { verifyProviderPass } from '../lib/providers.js';
import { logEvent } from '../lib/events.js';
import { hashToken, startSession, upsertUser } from '../auth.js';
import { HttpError, str } from '../lib/http.js';
import { mailOn, sendMail, stubOutbox } from '../lib/mail.js';
import { rateLimiter } from '../lib/pin.js';

export const signinRouter = Router();
/** Apple posts its answer as a cross-site form: mounted before the JSON parser and the JSON-only CSRF rule. */
export const appleCallbackRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ipLimit = rateLimiter(10, 15 * 60_000);
const emailLimit = rateLimiter(3, 15 * 60_000);

/** Which ways in are on (the landing page shows only those). */
signinRouter.get('/api/auth/methods', (_req, res) => {
  res.json({ google: !!(config.googleClientId && config.googleClientSecret), email: mailOn(), apple: !!process.env.APPLE_CLIENT_ID });
});

/* ---------- the Feed's sign-up: age first (no account until it's checked) ---------- */

const ageLimit = rateLimiter(20, 15 * 60_000);

/** Date of birth → a short-lived proof the sign-in carries (18+); under 18 → kindly turned away, nothing kept. */
signinRouter.post('/api/feed/age', async (req, res) => {
  if (!ageLimit(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const dob = String((req.body as { dob?: unknown }).dob ?? '');
  const age = ageFrom(dob);
  if (age === null || age > 120) throw new HttpError(400, 'Check your date of birth', 'dob_invalid');
  if (age < 18) {
    await asSystem(() => logEvent('community_underage', { at: 'signup' }, null, null));
    throw new HttpError(403, 'The Feed is for grown-ups 18 and older.', 'under_18');
  }
  res.json({ token: ageToken(dob) });
});

/* ---------- email link ---------- */

signinRouter.post('/api/auth/email', async (req, res) => {
  if (!mailOn()) throw new HttpError(503, 'Email sign-in isn’t set up yet — use Google for now');
  const email = str((req.body as { email?: unknown }).email, 'email', 200, true).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'That doesn’t look like an email address');
  if (!ipLimit(req.ip ?? 'unknown') || !emailLimit(email)) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const invite = typeof (req.body as { invite?: unknown }).invite === 'string' ? String((req.body as { invite: string }).invite).slice(0, 200) : null;
  // From the Feed's sign-up: the checked date of birth rides along with the link (a new Feed account needs it).
  const birth = verifyAgeToken((req.body as { age?: unknown }).age);
  // From the provider sign-up: the checked provider application (instead of a date of birth).
  const providerApp = verifyProviderPass((req.body as { age?: unknown }).age);
  // From someone's invite link: who invited them (a username).
  const refRaw = (req.body as { ref?: unknown }).ref;
  const ref = typeof refRaw === 'string' && /^[a-z0-9_.]{3,20}$/.test(refRaw) ? refRaw : null;
  const token = randomBytes(32).toString('base64url');
  await asSystem(() =>
    pool.query("INSERT INTO email_logins (email, token_hash, invite, expires_at, birth_date, ref, provider_app) VALUES ($1, $2, $3, now() + interval '15 minutes', $4, $5, $6)", [email, hashToken(token), invite, birth, ref, providerApp]),
  );
  // Back to the domain that asked: the Feed app (its own domain) or MyDay.
  const link = `${originFor(req)}/api/auth/email/callback?token=${token}`;
  const name = onFeedApp(req) ? 'The Feed' : 'MyDay';
  await sendMail({
    to: email,
    subject: `Your ${name} sign-in link`,
    text: `Tap to sign in to ${name}:\n\n${link}\n\nThe link works once, for 15 minutes. If you didn’t ask for it, you can ignore this email.`,
  });
  // Same answer whether or not the address has an account.
  res.json({ sent: true });
});

signinRouter.get('/api/auth/email/callback', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const row = await asSystem(async () => {
    const { rows } = await pool.query<{ id: number; email: string; invite: string | null; birth_date: string | null; ref: string | null; provider_app: string | null }>(
      'UPDATE email_logins SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING id, email, invite, birth_date::text AS birth_date, ref, provider_app',
      [hashToken(token)],
    );
    return rows[0] ?? null;
  });
  if (!row) {
    res.redirect('/?error=link');
    return;
  }
  try {
    const { userId, pendingInvite } = await upsertUser({ sub: `email:${row.email}`, email: row.email, email_verified: true, name: '' }, row.invite ?? undefined, 'email', onFeedApp(req) ? 'feed' : 'myday', row.birth_date, row.ref, row.provider_app);
    await startSession(req, userId);
    if (pendingInvite) req.session.pendingInvite = pendingInvite;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'age_required') {
      res.redirect('/?error=age');
      return;
    }
    if (e instanceof HttpError && e.status === 403) {
      res.redirect('/?error=roster');
      return;
    }
    throw e;
  }
  req.session.save(() => res.redirect('/'));
});

/** Local/tests only: what the stub mailer "sent". */
signinRouter.get('/api/dev/outbox', (req, res) => {
  if (config.production || !config.devLoginToken || req.query.token !== config.devLoginToken) throw new HttpError(404, 'Not found');
  res.json({ mail: stubOutbox() });
});

/* ---------- Sign in with Apple ---------- */

const APPLE_ISS = 'https://appleid.apple.com';
const COOKIE = 'myday.apple';
const sign = (v: string): string => createHmac('sha256', config.sessionSecret).update(v).digest('base64url');

signinRouter.get('/api/auth/apple', (req, res) => {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) throw new HttpError(503, 'Sign in with Apple isn’t set up yet');
  const state = randomBytes(18).toString('base64url');
  const nonce = randomBytes(18).toString('base64url');
  const invite = typeof req.query.invite === 'string' ? req.query.invite.slice(0, 200) : '';
  const value = [state, nonce, invite].join('.');
  // Apple answers with a cross-site POST, which drops our (SameSite=Lax) session cookie: carry state in a signed, short-lived cookie.
  res.cookie(COOKIE, `${value}~${sign(value)}`, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 10 * 60_000, path: '/api/auth/apple' });
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${config.publicUrl}/api/auth/apple/callback`,
    response_type: 'code id_token',
    response_mode: 'form_post',
    scope: 'name email',
    state,
    nonce: createHash('sha256').update(nonce).digest('hex'),
  });
  res.redirect(`${APPLE_ISS}/auth/authorize?${q.toString()}`);
});

let jwksCache: { at: number; keys: Array<JsonWebKey & { kid?: string }> } | null = null;
async function appleKeys(): Promise<Array<JsonWebKey & { kid?: string }>> {
  if (process.env.APPLE_JWKS_JSON) return (JSON.parse(process.env.APPLE_JWKS_JSON) as { keys: Array<JsonWebKey & { kid?: string }> }).keys;
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`${APPLE_ISS}/auth/keys`);
  const keys = ((await r.json()) as { keys: Array<JsonWebKey & { kid?: string }> }).keys;
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/** Verify an Apple id_token (RS256) and return its claims, or null. */
export async function verifyAppleIdToken(idToken: string, nonce: string): Promise<{ sub: string; email: string } | null> {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { kid?: string; alg?: string };
  if (header.alg !== 'RS256') return null;
  const jwk = (await appleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!ok) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { iss?: string; aud?: string; exp?: number; nonce?: string; sub?: string; email?: string };
  const want = createHash('sha256').update(nonce).digest('hex');
  if (c.iss !== APPLE_ISS || c.aud !== process.env.APPLE_CLIENT_ID || !c.exp || c.exp * 1000 < Date.now() || c.nonce !== want || !c.sub || !c.email) return null;
  return { sub: c.sub, email: c.email.toLowerCase() };
}

appleCallbackRouter.post('/api/auth/apple/callback', express.urlencoded({ extended: false, limit: '20kb' }), async (req: Request, res: Response) => {
  const b = req.body as { state?: string; id_token?: string; user?: string };
  const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  const [value, mac] = decodeURIComponent(raw).split('~');
  res.clearCookie(COOKIE, { path: '/api/auth/apple' });
  if (!value || !mac || mac.length !== sign(value).length || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(value)))) {
    res.redirect('/?error=state');
    return;
  }
  const [state, nonce, invite] = value.split('.');
  if (!state || state !== b.state || !nonce || !b.id_token) {
    res.redirect('/?error=state');
    return;
  }
  const who = await verifyAppleIdToken(b.id_token, nonce);
  if (!who) {
    res.redirect('/?error=apple');
    return;
  }
  let name = '';
  try {
    const u = JSON.parse(b.user ?? '{}') as { name?: { firstName?: string; lastName?: string } };
    name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(' ');
  } catch {
    /* Apple sends the name only the first time */
  }
  try {
    const { userId, pendingInvite } = await upsertUser({ sub: `apple:${who.sub}`, email: who.email, email_verified: true, name }, invite || undefined, 'apple');
    await startSession(req, userId);
    if (pendingInvite) req.session.pendingInvite = pendingInvite;
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      res.redirect('/?error=roster');
      return;
    }
    throw e;
  }
  req.session.save(() => res.redirect('/'));
});
