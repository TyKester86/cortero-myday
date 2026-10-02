/**
 * Sign-in: Google OAuth (authorization code + PKCE) with server-side
 * sessions in Postgres. Identity lives on the server, so the app never asks
 * "who are you / what's your role" again.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Me } from '@myday/shared';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './lib/http.js';
import { memberById } from './lib/members.js';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    oauthState: string;
    oauthVerifier: string;
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
    `INSERT INTO users (google_sub, email, name, member_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (google_sub) DO UPDATE SET member_id = EXCLUDED.member_id, last_login_at = now()
     RETURNING id`,
    [`dev:${m.id}`, `dev-login+${m.id}@invalid`, m.name, m.id],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('dev user upsert returned nothing');
  await startSession(req, id);
  req.session.save(() => res.redirect('/'));
});

interface UserRow {
  id: number;
  email: string;
  name: string;
  member_id: number | null;
}

/** Loads req.user / req.member for every /api request that has a session. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.session.userId;
  if (id) {
    const { rows } = await pool.query<UserRow>('SELECT id, email, name, member_id FROM users WHERE id = $1', [id]);
    const u = rows[0];
    if (u) {
      req.user = { id: u.id, email: u.email, name: u.name };
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
  res.json({ userId: req.user.id, email: req.user.email, name: req.user.name, member: req.member ?? null });
}
