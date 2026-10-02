/**
 * Sign-in: Google OAuth (authorization code + PKCE) with server-side
 * sessions in Postgres. Identity lives on the server, so the app never asks
 * "who are you / what's your role" again.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  AuthKind,
  HouseholdMember,
  KidAccess,
  KidAccessResponse,
  Me,
  SetKidPinResponse,
} from '@myday/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError, idParam } from './lib/http.js';
import { memberById, requireAdult } from './lib/members.js';
import {
  assertStrongPin,
  generatePin,
  hashPin,
  PIN_LOCK_MINUTES,
  PIN_MAX_FAILS,
  rateLimiter,
  verifyPin,
} from './lib/pin.js';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    oauthState: string;
    oauthVerifier: string;
    /** Kid PIN sessions: the PIN version they signed in with. */
    pinVersion: number;
  }
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const redirectUri = (): string => `${config.publicUrl}/api/auth/google/callback`;
const b64url = (b: Buffer): string => b.toString('base64url');

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

function isGoogleProfile(v: unknown): v is GoogleProfile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.sub === 'string' && typeof o.email === 'string';
}

function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((e: unknown) => (e ? reject(e) : resolve())));
}

async function startSession(req: Request, userId: number): Promise<void> {
  await regenerate(req); // new session id on login (no fixation)
  req.session.userId = userId;
}

/**
 * Find-or-create the user for a Google identity. Only roster emails (or
 * ALLOWED_EMAILS) may sign in — this is a family app, not a public one.
 */
async function upsertUser(p: GoogleProfile): Promise<number> {
  const email = p.email.toLowerCase();
  const { rows: mem } = await pool.query<{ id: number }>('SELECT id FROM household_members WHERE lower(email) = $1', [
    email,
  ]);
  const memberId = mem[0]?.id ?? null;
  if (memberId === null && !config.allowedEmails.includes(email)) {
    throw new HttpError(403, `${email} is not on this household's roster`);
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (google_sub, email, name, member_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE
       SET email = EXCLUDED.email, name = EXCLUDED.name,
           member_id = COALESCE(EXCLUDED.member_id, users.member_id), last_login_at = now()
     RETURNING id`,
    [p.sub, email, p.name ?? '', memberId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user upsert returned nothing');
  return id;
}

export const authRouter = Router();

authRouter.get('/api/auth/google', (req, res) => {
  if (!config.googleClientId || !config.googleClientSecret) {
    throw new HttpError(503, 'Google sign-in is not configured yet');
  }
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  req.session.oauthState = state;
  req.session.oauthVerifier = verifier;
  const q = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  req.session.save(() => res.redirect(`${GOOGLE_AUTH}?${q.toString()}`));
});

authRouter.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.session.oauthState;
  const verifier = req.session.oauthVerifier;
  if (typeof code !== 'string' || typeof state !== 'string' || !expected || !verifier || state !== expected) {
    res.redirect('/login?error=state');
    return;
  }
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const token: unknown = await tokenRes.json();
  const accessToken =
    typeof token === 'object' && token !== null && typeof (token as Record<string, unknown>).access_token === 'string'
      ? ((token as Record<string, unknown>).access_token as string)
      : null;
  if (!tokenRes.ok || !accessToken) {
    console.error('google token exchange failed', tokenRes.status);
    res.redirect('/login?error=google');
    return;
  }
  const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  const info: unknown = await infoRes.json();
  if (!infoRes.ok || !isGoogleProfile(info) || info.email_verified !== true) {
    res.redirect('/login?error=google');
    return;
  }
  try {
    await startSession(req, await upsertUser(info));
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      res.redirect('/login?error=roster');
      return;
    }
    throw e;
  }
  req.session.save(() => res.redirect('/'));
});

authRouter.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('myday.sid');
    res.json({ ok: true });
  });
});

/*
 * TEMPORARY — verification only. Enabled solely when DEV_LOGIN_TOKEN is set
 * in the droplet .env (default: unset = this route 404s). Remove once Google
 * OAuth is live. /dev-login?token=...&member=<household key>
 */
authRouter.get('/dev-login', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const want = config.devLoginToken;
  const ok =
    want.length > 0 &&
    token.length === want.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(want));
  if (!ok) {
    res.status(404).send('Not found');
    return;
  }
  const key = typeof req.query.member === 'string' ? req.query.member.trim().toLowerCase() : '';
  const { rows: mem } = await pool.query<{ id: number; name: string }>(
    key
      ? 'SELECT id, name FROM household_members WHERE key = $1'
      : "SELECT id, name FROM household_members WHERE kind = 'adult' ORDER BY sort_order, id LIMIT 1",
    key ? [key] : [],
  );
  const m = mem[0];
  if (!m) {
    res.status(404).send('No such household member');
    return;
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (google_sub, email, name, member_id, auth) VALUES ($1, $2, $3, $4, 'dev')
     ON CONFLICT (google_sub) DO UPDATE SET member_id = EXCLUDED.member_id, last_login_at = now()
     RETURNING id`,
    [`dev:${m.id}`, `dev-login+${m.id}@invalid`, m.name, m.id],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('dev user upsert returned nothing');
  await startSession(req, id);
  req.session.save(() => res.redirect('/'));
});

/* ---------- kid sign-in: name + parent-managed PIN ---------- */

const kidLoginLimit = rateLimiter(20, 15 * 60_000); // per IP
const BAD_PIN = "That name and PIN didn't match";

authRouter.post('/api/auth/kid-login', async (req, res) => {
  if (!kidLoginLimit(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const b = req.body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '';
  const pin = typeof b.pin === 'string' ? b.pin.trim() : '';
  if (!name || !pin) throw new HttpError(400, 'Enter your name and PIN');

  const { rows } = await pool.query<{
    id: number;
    name: string;
    pin_hash: string | null;
    pin_version: number;
    pin_failed: number;
    locked: boolean;
  }>(
    `SELECT id, name, pin_hash, pin_version, pin_failed, (pin_locked_until > now()) AS locked
       FROM household_members
      WHERE kind = 'kid' AND (key = $1 OR lower(name) = $1)
      ORDER BY id LIMIT 1`,
    [name],
  );
  const kid = rows[0];
  if (!kid || !kid.pin_hash) throw new HttpError(401, BAD_PIN);
  if (kid.locked) throw new HttpError(429, `Too many wrong PINs. Ask a grown-up, or wait ${PIN_LOCK_MINUTES} minutes.`);

  if (!(await verifyPin(pin, kid.pin_hash))) {
    const fails = kid.pin_failed + 1;
    await pool.query(
      `UPDATE household_members
          SET pin_failed = CASE WHEN $2::int >= $3::int THEN 0 ELSE $2::int END,
              pin_locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int)
                                      ELSE pin_locked_until END
        WHERE id = $1`,
      [kid.id, fails, PIN_MAX_FAILS, PIN_LOCK_MINUTES],
    );
    throw new HttpError(401, BAD_PIN);
  }

  await pool.query('UPDATE household_members SET pin_failed = 0, pin_locked_until = NULL WHERE id = $1', [kid.id]);
  const { rows: u } = await pool.query<{ id: number }>(
    `INSERT INTO users (google_sub, email, name, member_id, auth) VALUES ($1, '', $2, $3, 'pin')
     ON CONFLICT (google_sub) DO UPDATE SET name = EXCLUDED.name, member_id = EXCLUDED.member_id, last_login_at = now()
     RETURNING id`,
    [`pin:${kid.id}`, kid.name, kid.id],
  );
  const userId = u[0]?.id;
  if (userId === undefined) throw new Error('kid user upsert returned nothing');
  await startSession(req, userId);
  req.session.pinVersion = kid.pin_version;
  req.session.save(() => res.json({ ok: true }));
});

interface UserRow {
  id: number;
  email: string;
  name: string;
  auth: AuthKind;
  member_id: number | null;
  pin_version: number | null;
}

/** Loads req.user / req.member for every /api request that has a session. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.session.userId;
  if (id) {
    const { rows } = await pool.query<UserRow>(
      `SELECT u.id, u.email, u.name, u.auth, u.member_id, m.pin_version
         FROM users u LEFT JOIN household_members m ON m.id = u.member_id WHERE u.id = $1`,
      [id],
    );
    const u = rows[0];
    // A parent resetting or removing a kid's PIN ends that kid's existing sessions.
    const stalePin = u?.auth === 'pin' && (u.pin_version === null || u.pin_version !== req.session.pinVersion);
    if (u && !stalePin) {
      req.user = { id: u.id, email: u.email, name: u.name, auth: u.auth };
      req.member = u.member_id === null ? null : await memberById(u.member_id);
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  next();
}

export function meHandler(req: Request, res: Response<Me>): void {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  res.json({
    userId: req.user.id,
    email: req.user.email,
    name: req.user.name,
    auth: req.user.auth,
    member: req.member ?? null,
  });
}

/* ---------- grown-ups manage kid PINs ---------- */

export const kidAccessRouter = Router();

async function kidAccessList(): Promise<KidAccessResponse> {
  const { rows } = await pool.query<{ id: number; key: string; name: string; has_pin: boolean; locked_until: Date | null }>(
    `SELECT id, key, name, (pin_hash IS NOT NULL) AS has_pin,
            CASE WHEN pin_locked_until > now() THEN pin_locked_until END AS locked_until
       FROM household_members WHERE kind = 'kid' ORDER BY sort_order, id`,
  );
  return {
    kids: rows.map(
      (r): KidAccess => ({
        memberId: r.id,
        key: r.key,
        name: r.name,
        hasPin: r.has_pin,
        lockedUntil: r.locked_until ? r.locked_until.toISOString() : null,
      }),
    ),
  };
}

async function kidById(id: number): Promise<HouseholdMember> {
  const m = await memberById(id);
  if (!m || m.kind !== 'kid') throw new HttpError(404, 'No such kid in the household');
  return m;
}

kidAccessRouter.get('/api/kid-access', async (req, res) => {
  requireAdult(req);
  res.json(await kidAccessList());
});

/** Create or rotate a kid's PIN. Omit `pin` to have one generated. Ends the kid's old sessions. */
kidAccessRouter.put('/api/kid-access/:memberId/pin', async (req, res) => {
  requireAdult(req);
  const kid = await kidById(idParam(req.params.memberId));
  const raw = (req.body as { pin?: unknown }).pin;
  const pin = typeof raw === 'string' && raw.trim() ? raw.trim() : generatePin();
  assertStrongPin(pin);
  await pool.query(
    `UPDATE household_members
        SET pin_hash = $2, pin_version = pin_version + 1, pin_failed = 0, pin_locked_until = NULL
      WHERE id = $1`,
    [kid.id, await hashPin(pin)],
  );
  const out: SetKidPinResponse = { pin };
  res.json(out);
});

/** Turn off a kid's PIN sign-in (and sign them out everywhere). */
kidAccessRouter.delete('/api/kid-access/:memberId/pin', async (req, res) => {
  requireAdult(req);
  const kid = await kidById(idParam(req.params.memberId));
  await pool.query(
    `UPDATE household_members SET pin_hash = NULL, pin_version = pin_version + 1, pin_failed = 0, pin_locked_until = NULL
      WHERE id = $1`,
    [kid.id],
  );
  res.json(await kidAccessList());
});
