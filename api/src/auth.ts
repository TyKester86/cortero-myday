/**
 * Sign-in: Google OAuth (authorization code + PKCE) with server-side
 * sessions in Postgres. Identity lives on the server, so the app never asks
 * "who are you / what's your role" again.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  AuthKind,
  DeviceKidsResponse,
  HouseholdMember,
  InvitePreview,
  KidAccess,
  KidAccessResponse,
  KidSignin,
  Me,
  SetKidPinResponse,
  XpTrack,
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
  const { rows: mem } = await pool.query<{ id: number }>(
    'SELECT id FROM household_members WHERE lower(email) = $1 AND archived_at IS NULL',
    [email],
  );
  const memberId = mem[0]?.id ?? null;
  if (memberId !== null) await markInviteAccepted(memberId);
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
      ? 'SELECT id, name FROM household_members WHERE key = $1 AND archived_at IS NULL'
      : "SELECT id, name FROM household_members WHERE kind = 'adult' AND archived_at IS NULL ORDER BY sort_order, id LIMIT 1",
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
  await markInviteAccepted(m.id);
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
      WHERE kind = 'kid' AND archived_at IS NULL AND (key = $1 OR lower(name) = $1)
      ORDER BY id LIMIT 1`,
    [name],
  );
  const kid = rows[0];
  if (!kid || !kid.pin_hash) throw new HttpError(401, BAD_PIN);
  const device = deviceLabel(req.headers['user-agent']);
  if (kid.locked) {
    await logKidSignin(kid.id, false, device);
    throw new HttpError(429, `Too many wrong PINs. Ask a grown-up, or wait ${PIN_LOCK_MINUTES} minutes.`);
  }

  if (!(await verifyPin(pin, kid.pin_hash))) {
    await logKidSignin(kid.id, false, device);
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
  await logKidSignin(kid.id, true, device);
  if (b.remember === true) await rememberKidOnDevice(req, res, kid.id, device);
  await startSession(req, userId);
  req.session.pinVersion = kid.pin_version;
  req.session.save(() => res.json({ ok: true }));
});

/* ---------- "remember this device": the kid picker on a family device ---------- */

const DEVICE_COOKIE = 'myday.kiddev';
const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** A short, non-identifying label for the sign-in log ("iPhone", "Windows"...). */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? '';
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Android/i.test(s)) return 'Android';
  if (/Windows/i.test(s)) return 'Windows';
  if (/Macintosh|Mac OS/i.test(s)) return 'Mac';
  if (/CrOS/i.test(s)) return 'Chromebook';
  return 'Other';
}

async function logKidSignin(memberId: number, ok: boolean, device: string): Promise<void> {
  await pool.query('INSERT INTO kid_signins (member_id, ok, device) VALUES ($1, $2, $3)', [memberId, ok, device]);
}

/** The device row for this browser's cookie, if valid. */
export async function currentDevice(req: Request): Promise<number | null> {
  const token = readCookie(req, DEVICE_COOKIE);
  if (!token) return null;
  const { rows } = await pool.query<{ id: number }>(
    'UPDATE kid_devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id',
    [hashToken(token)],
  );
  return rows[0]?.id ?? null;
}

/** Add kids to this browser's picker, creating the device (and its cookie) if needed. */
export async function rememberKidOnDevice(
  req: Request,
  res: Response,
  memberId: number,
  label: string,
  knownDeviceId: number | null = null,
): Promise<number> {
  // knownDeviceId: a device created earlier in this same request (its cookie isn't on req yet).
  let deviceId = knownDeviceId ?? (await currentDevice(req));
  if (deviceId === null) {
    const token = randomBytes(32).toString('base64url');
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO kid_devices (token_hash, label) VALUES ($1, $2) RETURNING id',
      [hashToken(token), label],
    );
    deviceId = rows[0]?.id ?? null;
    if (deviceId === null) throw new Error('device insert returned nothing');
    res.cookie(DEVICE_COOKIE, token, {
      httpOnly: true,
      secure: config.production,
      sameSite: 'lax',
      maxAge: 400 * 24 * 60 * 60 * 1000,
    });
  }
  await pool.query('INSERT INTO kid_device_members (device_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    deviceId,
    memberId,
  ]);
  return deviceId;
}

/** Public: which kids this device remembers (names only; PIN still required). */
authRouter.get('/api/auth/kid-device', async (req, res) => {
  const deviceId = await currentDevice(req);
  const out: DeviceKidsResponse = { kids: [] };
  if (deviceId !== null) {
    const { rows } = await pool.query<{ key: string; name: string }>(
      `SELECT m.key, m.name FROM kid_device_members dm JOIN household_members m ON m.id = dm.member_id
        WHERE dm.device_id = $1 AND m.archived_at IS NULL AND m.pin_hash IS NOT NULL ORDER BY m.sort_order, m.id`,
      [deviceId],
    );
    out.kids = rows;
  }
  res.json(out);
});

/** Public: "not me" — drop a kid from this device's picker. */
authRouter.post('/api/auth/kid-device/forget', async (req, res) => {
  const deviceId = await currentDevice(req);
  const key = typeof (req.body as { key?: unknown }).key === 'string' ? (req.body as { key: string }).key : '';
  if (deviceId !== null && key) {
    await pool.query(
      'DELETE FROM kid_device_members WHERE device_id = $1 AND member_id = (SELECT id FROM household_members WHERE key = $2)',
      [deviceId, key.toLowerCase()],
    );
  }
  res.json({ ok: true });
});

/* ---------- invites ---------- */

export async function markInviteAccepted(memberId: number): Promise<void> {
  await pool.query(
    'UPDATE invites SET accepted_at = now() WHERE member_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL',
    [memberId],
  );
}

/** Public: what an invite link is for (masked email), so the page can greet them. */
authRouter.get('/api/invites/:token', async (req, res) => {
  const { rows } = await pool.query<{ name: string; email: string }>(
    `SELECT m.name, i.email FROM invites i JOIN household_members m ON m.id = i.member_id
      WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
        AND m.archived_at IS NULL`,
    [hashToken(String(req.params.token))],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'This invite link is no longer valid');
  const [user = '', domain = ''] = r.email.split('@');
  const out: InvitePreview = { name: r.name, email: `${user.slice(0, 1)}***@${domain}` };
  res.json(out);
});

export { hashToken };

interface UserRow {
  id: number;
  email: string;
  name: string;
  auth: AuthKind;
  member_id: number | null;
  pin_version: number | null;
  archived: boolean;
}

/** Loads req.user / req.member for every /api request that has a session. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.session.userId;
  if (id) {
    const { rows } = await pool.query<UserRow>(
      `SELECT u.id, u.email, u.name, u.auth, u.member_id, m.pin_version, (m.archived_at IS NOT NULL) AS archived
         FROM users u LEFT JOIN household_members m ON m.id = u.member_id WHERE u.id = $1`,
      [id],
    );
    const u = rows[0];
    // A parent resetting or removing a kid's PIN ends that kid's existing sessions.
    const stalePin = u?.auth === 'pin' && (u.pin_version === null || u.pin_version !== req.session.pinVersion);
    // Removing someone from the household signs them out everywhere.
    if (u && !stalePin && !u.archived) {
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

export async function meHandler(req: Request, res: Response<Me>): Promise<void> {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  const member = req.member ?? null;
  const { rows } = member
    ? await pool.query<{ xp_track: XpTrack }>('SELECT xp_track FROM household_members WHERE id = $1', [member.id])
    : { rows: [] };
  res.json({
    userId: req.user.id,
    email: req.user.email,
    name: req.user.name,
    auth: req.user.auth,
    member,
    xpTrack: rows[0]?.xp_track ?? null,
  });
}

/* ---------- grown-ups manage kid PINs ---------- */

export const kidAccessRouter = Router();

export async function kidAccessList(): Promise<KidAccessResponse> {
  const { rows } = await pool.query<{ id: number; key: string; name: string; has_pin: boolean; locked_until: Date | null }>(
    `SELECT id, key, name, (pin_hash IS NOT NULL) AS has_pin,
            CASE WHEN pin_locked_until > now() THEN pin_locked_until END AS locked_until
       FROM household_members WHERE kind = 'kid' AND archived_at IS NULL ORDER BY sort_order, id`,
  );
  const kids: KidAccess[] = [];
  for (const r of rows) {
    const { rows: log } = await pool.query<{ at: Date; ok: boolean; device: string }>(
      'SELECT at, ok, device FROM kid_signins WHERE member_id = $1 ORDER BY at DESC, id DESC LIMIT 10',
      [r.id],
    );
    kids.push({
      memberId: r.id,
      key: r.key,
      name: r.name,
      hasPin: r.has_pin,
      lockedUntil: r.locked_until ? r.locked_until.toISOString() : null,
      recentSignins: log.map((l): KidSignin => ({ at: l.at.toISOString(), ok: l.ok, device: l.device })),
    });
  }
  return { kids };
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
