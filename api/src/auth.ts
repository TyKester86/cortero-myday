/**
 * Sign-in: Google OAuth (authorization code + PKCE) with server-side
 * sessions in Postgres, plus kid PIN sign-in. Identity lives on the server.
 *
 * Multi-household: sign-in lookups run cross-household (asSystem); once the
 * person is known, every request is pinned to their household (db.ts).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  AuthKind,
  DeviceKidsResponse,
  HouseholdInfo,
  HouseholdMember,
  HouseholdType,
  InvitePreview,
  KidAccess,
  KidAccessResponse,
  KidSignin,
  Me,
  ModuleKey,
  SetKidPinResponse,
  XpTrack,
} from '@myday/shared';
import { MODULE_KEYS } from '@myday/shared';
import { config } from './config.js';
import { asSystem, inHousehold, pool, setHousehold } from './db.js';
import { logEvent } from './lib/events.js';
import { HttpError, idParam } from './lib/http.js';
import { verifyAgeToken } from './lib/age.js';
import { verifyProviderPass } from './lib/providers.js';
import { claimProviderApplication } from './routes/providers.js';
import { notify } from './lib/feednotify.js';
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
    /** Invite token carried through Google sign-in (joins that household). */
    inviteToken: string;
    /** An invite to ANOTHER household, held until the person says "leave mine and join". */
    pendingInvite: string;
    /** Kroger account connect (OAuth state). */
    krogerState: string;
    /** Google sign-in started on the Feed app's domain: hand the person back there afterwards. */
    authTo: 'feed';
    /** The Feed sign-up's age proof (lib/age.ts), carried through Google sign-in. */
    feedAge: string;
    /** Who invited them (an invite link's username), carried through Google sign-in. */
    feedRef: string;
  }
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

const redirectUri = (): string => `${config.publicUrl}/api/auth/google/callback`;
const b64url = (b: Buffer): string => b.toString('base64url');
export const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

export interface GoogleProfile {
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

export async function startSession(req: Request, userId: number): Promise<void> {
  const invite = req.session.inviteToken;
  await regenerate(req); // new session id on login (no fixation)
  req.session.userId = userId;
  if (invite) req.session.inviteToken = invite;
  await asSystem(() => logEvent('signin', {}, null, null));
}

/**
 * Find-or-create the user for a Google identity. Someone on a roster signs
 * in as that member. Anyone else may sign up (they'll create a household)
 * unless SIGNUP_OPEN=false, in which case only roster emails get in.
 */
/** A still-valid invite's member + household, without claiming it. */
export async function peekInvite(token: string): Promise<{ memberId: number; householdId: number; household: string; name: string } | null> {
  const { rows } = await asSystem(() =>
    pool.query<{ member_id: number; household_id: number; household: string; name: string }>(
      `SELECT i.member_id, i.household_id, h.name AS household, m.name FROM invites i
         JOIN household_members m ON m.id = i.member_id JOIN households h ON h.id = i.household_id
        WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now() AND m.archived_at IS NULL`,
      [hashToken(token)],
    ),
  );
  const r = rows[0];
  return r ? { memberId: r.member_id, householdId: r.household_id, household: r.household, name: r.name } : null;
}

/**
 * The account a sign-in method belongs to: its own, one it was linked to, or — same verified email — the
 * person's existing account (then this method is linked to it: one person, one account, MyDay and Feed).
 */
async function accountFor(sub: string, email: string): Promise<number | null> {
  const own = await pool.query<{ id: number }>('SELECT id FROM users WHERE google_sub = $1', [sub]);
  if (own.rows[0]) return own.rows[0].id;
  const linked = await pool.query<{ user_id: number }>('SELECT user_id FROM user_identities WHERE sub = $1', [sub]);
  if (linked.rows[0]) return linked.rows[0].user_id;
  // Real sign-ins only (Google, email link, Apple — all verify the address); never a kid PIN or a dev sign-in.
  const same = await pool.query<{ id: number }>("SELECT id FROM users WHERE lower(email) = $1 AND auth = 'google' ORDER BY id LIMIT 1", [email]);
  const id = same.rows[0]?.id;
  if (id === undefined) return null;
  await pool.query('INSERT INTO user_identities (sub, user_id) VALUES ($1, $2) ON CONFLICT (sub) DO NOTHING', [sub, id]);
  await logEvent('account_linked', {}, null, null);
  return id;
}

export async function upsertUser(
  p: GoogleProfile,
  inviteToken: string | undefined,
  via: 'google' | 'email' | 'apple' = 'google',
  app: 'myday' | 'feed' = 'myday',
  /** The Feed sign-up's checked date of birth (18+). A NEW Feed account can't exist without it. */
  birthDate: string | null = null,
  /** Who invited them (username from an invite link). */
  ref: string | null = null,
  /** A checked provider application (Provider Knowledge Base): an NPI-verified provider is an adult, no date of birth asked. */
  providerApp: string | null = null,
): Promise<{ userId: number; pendingInvite: string | null }> {
  const email = p.email.toLowerCase();
  return asSystem(async () => {
    const existing = await accountFor(p.sub, email);
    let memberId: number | null = null;
    let pendingInvite: string | null = null;
    // Accepting an invite link links this Google account to the invited member,
    // even if they signed in with a different address than the one invited —
    // unless they already belong to ANOTHER household: then nothing moves until
    // they confirm "leave mine and join" in the app.
    if (inviteToken) {
      const inv = await peekInvite(inviteToken);
      const { rows: cur } = await pool.query<{ household_id: number | null }>(
        'SELECT m.household_id FROM users u JOIN household_members m ON m.id = u.member_id WHERE u.id = $1 AND m.archived_at IS NULL',
        [existing ?? -1],
      );
      const mine = cur[0]?.household_id ?? null;
      if (inv && mine !== null && mine !== inv.householdId) pendingInvite = inviteToken;
      else memberId = await claimInvite(inviteToken, email);
    }
    if (memberId === null) {
      const { rows: mem } = await pool.query<{ id: number }>(
        'SELECT id FROM household_members WHERE lower(email) = $1 AND archived_at IS NULL ORDER BY id LIMIT 1',
        [email],
      );
      memberId = mem[0]?.id ?? null;
    }
    if (memberId !== null) await markInviteAccepted(memberId);
    if (memberId === null && existing === null && !config.signupOpen && !config.allowedEmails.includes(email)) {
      throw new HttpError(403, `${email} is not on a household roster`);
    }
    // The Feed is 18+: no Feed account is created until age is checked (an invited household member is MyDay's).
    if (existing === null && app === 'feed' && memberId === null && !birthDate && !providerApp) {
      throw new HttpError(403, 'Start with your date of birth — the Feed is for grown-ups 18 and older.', 'age_required');
    }
    if (existing !== null) {
      // An email-link sign-in has no name: keep the one the account has.
      await pool.query(
        "UPDATE users SET name = COALESCE(NULLIF($2, ''), name), member_id = COALESCE($3, member_id), last_login_at = now() WHERE id = $1",
        [existing, p.name ?? '', memberId],
      );
      if (providerApp) await claimProviderApplication(providerApp, existing);
      return { userId: existing, pendingInvite };
    }
    const { rows: inv } = ref ? await pool.query<{ user_id: number }>('SELECT user_id FROM social_profiles WHERE username = $1 AND banned_at IS NULL', [ref]) : { rows: [] };
    const inviter = inv[0]?.user_id ?? null;
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO users (google_sub, email, name, member_id, signup_app, birth_date, referred_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [p.sub, email, p.name ?? '', memberId, app, birthDate, inviter],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('user upsert returned nothing');
    // Joined from a friend's invite: they're connected (the new person follows their friend), and the friend hears.
    if (inviter !== null) {
      await pool.query('INSERT INTO social_follows (follower_user_id, followed_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, inviter]);
      await notify({ to: inviter, kind: 'joined', actor: id, group: `joined:${id}`, url: `/people/${id}` });
    }
    await logEvent('signup', { via, invited: memberId !== null, app }, memberId, null);
    if (providerApp) await claimProviderApplication(providerApp, id);
    return { userId: id, pendingInvite };
  });
}

/** Turn a valid invite token into its member, pointing the member at this email. */
async function claimInvite(token: string, email: string): Promise<number | null> {
  const { rows } = await pool.query<{ member_id: number }>(
    `SELECT i.member_id FROM invites i JOIN household_members m ON m.id = i.member_id
      WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
        AND m.archived_at IS NULL`,
    [hashToken(token)],
  );
  const memberId = rows[0]?.member_id;
  if (memberId === undefined) return null;
  const taken = await pool.query('SELECT 1 FROM household_members WHERE lower(email) = $1 AND id <> $2', [email, memberId]);
  if (!taken.rowCount) await pool.query('UPDATE household_members SET email = $2 WHERE id = $1', [memberId, email]);
  return memberId;
}

/** Claim an invite for a signed-in user: link the account to the invited member. */
export async function claimAndLink(token: string, userId: number, email: string): Promise<number> {
  return asSystem(async () => {
    const memberId = await claimInvite(token, email.toLowerCase());
    if (memberId === null) throw new HttpError(404, 'That invite is no longer valid');
    await pool.query('UPDATE users SET member_id = $2 WHERE id = $1', [userId, memberId]);
    await markInviteAccepted(memberId);
    return memberId;
  });
}

export async function markInviteAccepted(memberId: number): Promise<void> {
  const r = await pool.query<{ household_id: number }>(
    'UPDATE invites SET accepted_at = now() WHERE member_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING household_id',
    [memberId],
  );
  const hh = r.rows[0]?.household_id;
  if (hh !== undefined) await logEvent('invite_accepted', {}, memberId, hh);
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
  if (typeof req.query.invite === 'string' && req.query.invite.length < 200) req.session.inviteToken = req.query.invite;
  // The Feed app (its own domain) signs in through this registered callback, then gets the person handed back.
  if (req.query.to === 'feed' && config.feedAppUrl) req.session.authTo = 'feed';
  else delete req.session.authTo;
  if (typeof req.query.age === 'string') req.session.feedAge = req.query.age;
  else delete req.session.feedAge;
  if (typeof req.query.ref === 'string' && /^[a-z0-9_.]{3,20}$/.test(req.query.ref)) req.session.feedRef = req.query.ref;
  else delete req.session.feedRef;
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
  // Started on the Feed app: errors and the signed-in person go back there.
  const back = req.session.authTo === 'feed' ? config.feedAppUrl : '';
  if (typeof code !== 'string' || typeof state !== 'string' || !expected || !verifier || state !== expected) {
    res.redirect(`${back}/login?error=state`);
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
    res.redirect(`${back}/login?error=google`);
    return;
  }
  const infoRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  const info: unknown = await infoRes.json();
  if (!infoRes.ok || !isGoogleProfile(info) || info.email_verified !== true) {
    res.redirect(`${back}/login?error=google`);
    return;
  }
  let userId: number;
  try {
    const up = await upsertUser(info, req.session.inviteToken, 'google', back ? 'feed' : 'myday', verifyAgeToken(req.session.feedAge), req.session.feedRef ?? null, verifyProviderPass(req.session.feedAge));
    userId = up.userId;
    await startSession(req, userId);
    delete req.session.inviteToken;
    if (up.pendingInvite) req.session.pendingInvite = up.pendingInvite;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'age_required') {
      res.redirect(`${back}/?error=age`);
      return;
    }
    if (e instanceof HttpError && e.status === 403) {
      res.redirect(`${back}/login?error=roster`);
      return;
    }
    throw e;
  }
  const to = back ? `${back}/api/auth/handoff?token=${await createHandoff(userId, '/feed')}` : '/';
  req.session.save(() => res.redirect(to));
});

/* ---------- handing a signed-in person to the other app (MyDay ⇄ the Feed) ---------- */

/** A one-time token (2 minutes) that signs this person in on the other domain, then opens `next` there. */
export async function createHandoff(userId: number, next: string): Promise<string> {
  const token = b64url(randomBytes(32));
  await asSystem(() =>
    pool.query("INSERT INTO auth_handoffs (token_hash, user_id, next_path, expires_at) VALUES ($1, $2, $3, now() + interval '2 minutes')", [
      hashToken(token),
      userId,
      safeNext(next),
    ]),
  );
  return token;
}

/** Only a path on this same site (never another site: no open redirect). */
export function safeNext(v: unknown): string {
  return typeof v === 'string' && /^\/(?![/\\])[\w\-/.?=&%]*$/.test(v) && v.length <= 200 ? v : '/';
}

/**
 * A plain link to the other app, signed in: /api/auth/go?to=feed|myday[&next=/path]. MyDay's horn tab and the
 * Feed app's door to MyDay are ordinary links (a tap the phone can hand to the installed app); this makes the
 * one-time hand-off and sends the browser on. Signed out → the other app's front page. Kids never go to the Feed.
 */
authRouter.get('/api/auth/go', async (req, res) => {
  const feed = req.query.to === 'feed';
  const target = feed ? config.feedAppUrl : req.query.to === 'myday' ? config.publicUrl : '';
  if (!target) throw new HttpError(400, 'No such app');
  const next = safeNext(req.query.next ?? (feed ? '/feed' : '/'));
  if (!req.user) {
    res.redirect(`${target}${feed ? '/' : next}`);
    return;
  }
  if (feed && req.member && req.member.kind !== 'adult') {
    res.redirect('/');
    return;
  }
  res.redirect(`${target}/api/auth/handoff?token=${await createHandoff(req.user.id, next)}`);
});

/** Signed in here → a one-time link that signs you in on the other app (MyDay's horn → the Feed app, and back). */
authRouter.post('/api/auth/handoff', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) throw new HttpError(401, 'Sign in first');
  const body = req.body as { to?: unknown; next?: unknown };
  const to = body.to === 'myday' ? config.publicUrl : body.to === 'feed' ? config.feedAppUrl : '';
  if (!to) throw new HttpError(400, 'No such app');
  // The Feed is 18+: kids are never handed to it.
  if (body.to === 'feed' && req.member && req.member.kind !== 'adult') throw new HttpError(403, 'The Feed is for grown-ups');
  const next = safeNext(body.next ?? (body.to === 'feed' ? '/feed' : '/'));
  res.json({ url: `${to}/api/auth/handoff?token=${await createHandoff(userId, next)}` });
});

authRouter.get('/api/auth/handoff', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const row = await asSystem(async () => {
    const { rows } = await pool.query<{ user_id: number; next_path: string }>(
      'UPDATE auth_handoffs SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, next_path',
      [hashToken(token)],
    );
    return rows[0] ?? null;
  });
  if (!row) {
    res.redirect('/login?error=handoff');
    return;
  }
  await startSession(req, row.user_id);
  req.session.save(() => res.redirect(safeNext(row.next_path)));
});

authRouter.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('myday.sid');
    res.json({ ok: true });
  });
});

/*
 * TEMPORARY — verification only. Enabled solely when DEV_LOGIN_TOKEN is set
 * in the droplet .env (default: unset = this route 404s).
 *   /dev-login?token=...&member=<household key>[&household=<id>]
 *   /dev-login?token=...&email=<address>   (a new, household-less user: signup flow)
 */
authRouter.get('/dev-login', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const want = config.devLoginToken;
  const ok =
    want.length > 0 && token.length === want.length && timingSafeEqual(Buffer.from(token), Buffer.from(want));
  if (!ok) {
    res.status(404).send('Not found');
    return;
  }
  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (email) {
    const id = await asSystem(async () => {
      const { rows } = await pool.query<{ id: number; existed: boolean }>(
        `INSERT INTO users (google_sub, email, name, auth) VALUES ($1, $2, $3, 'dev')
         ON CONFLICT (google_sub) DO UPDATE SET last_login_at = now() RETURNING id, (xmax <> 0) AS existed`,
        [`dev-email:${email}`, email, email.split('@')[0] ?? email],
      );
      const r = rows[0];
      if (r && !r.existed) await logEvent('signup', { via: 'dev' }, null, null);
      return r?.id;
    });
    if (id === undefined) throw new Error('dev user upsert returned nothing');
    await startSession(req, id);
    // &invite=<token>: the same handling as Google sign-in through an invite link.
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    if (invite) {
      const inv = await peekInvite(invite);
      const { rows: cur } = await asSystem(() =>
        pool.query<{ household_id: number }>('SELECT m.household_id FROM users u JOIN household_members m ON m.id = u.member_id WHERE u.id = $1 AND m.archived_at IS NULL', [id]),
      );
      const mine = cur[0]?.household_id ?? null;
      if (inv && mine !== null && mine !== inv.householdId) req.session.pendingInvite = invite;
      else if (inv) await claimAndLink(invite, id, email);
    }
    req.session.save(() => res.redirect('/'));
    return;
  }
  const key = typeof req.query.member === 'string' ? req.query.member.trim().toLowerCase() : '';
  const hh = typeof req.query.household === 'string' && /^\d+$/.test(req.query.household) ? Number(req.query.household) : null;
  const m = await asSystem(async () => {
    const { rows } = await pool.query<{ id: number; name: string }>(
      `SELECT id, name FROM household_members
        WHERE archived_at IS NULL AND ($1 = '' OR key = $1) AND ($1 <> '' OR kind = 'adult')
          AND ($2::int IS NULL OR household_id = $2)
        ORDER BY household_id, sort_order, id LIMIT 1`,
      [key, hh],
    );
    const found = rows[0];
    if (found) await markInviteAccepted(found.id);
    return found;
  });
  if (!m) {
    res.status(404).send('No such household member');
    return;
  }
  const id = await asSystem(async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO users (google_sub, email, name, member_id, auth) VALUES ($1, $2, $3, $4, 'dev')
       ON CONFLICT (google_sub) DO UPDATE SET member_id = EXCLUDED.member_id, last_login_at = now()
       RETURNING id`,
      [`dev:${m.id}`, `dev-login+${m.id}@invalid`, m.name, m.id],
    );
    return rows[0]?.id;
  });
  if (id === undefined) throw new Error('dev user upsert returned nothing');
  await startSession(req, id);
  req.session.save(() => res.redirect('/'));
});

/* ---------- kid sign-in: (family code or remembered device) + name + PIN ---------- */

const kidLoginLimit = rateLimiter(20, 15 * 60_000); // per IP
const BAD_PIN = "That name and PIN didn't match";

/**
 * Which household a kid is signing into: the family code they typed, else
 * the household of this remembered device, else the only household there is.
 */
async function kidHousehold(req: Request, code: string): Promise<number | null> {
  return asSystem(async () => {
    if (code) {
      const { rows } = await pool.query<{ id: number }>('SELECT id FROM households WHERE code = $1', [code.toUpperCase()]);
      return rows[0]?.id ?? null;
    }
    const dev = await deviceByCookie(req);
    if (dev) return dev.householdId;
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM households ORDER BY id LIMIT 2');
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
  });
}

authRouter.post('/api/auth/kid-login', async (req, res) => {
  if (!kidLoginLimit(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  const b = req.body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim().toLowerCase() : '';
  const pin = typeof b.pin === 'string' ? b.pin.trim() : '';
  const code = typeof b.household === 'string' ? b.household.trim() : '';
  if (!name || !pin) throw new HttpError(400, 'Enter your name and PIN');
  const householdId = await kidHousehold(req, code);
  if (householdId === null) {
    throw new HttpError(code ? 401 : 400, code ? BAD_PIN : 'Enter your family code (a grown-up can find it under Household)');
  }

  const device = deviceLabel(req.headers['user-agent']);
  const result = await inHousehold(householdId, async () => {
    // Every kid this name could mean. Two kids can share a first name (or a kid
    // was added twice): the PIN decides which one is signing in, so a PIN set on
    // the newer one is never checked against the older one by mistake.
    const { rows: candidates } = await pool.query<{
      id: number;
      name: string;
      pin_hash: string | null;
      pin_version: number;
      pin_failed: number;
      locked: boolean;
    }>(
      `SELECT id, name, pin_hash, pin_version, pin_failed, (pin_locked_until > now()) AS locked
         FROM household_members
        WHERE kind = 'kid' AND archived_at IS NULL AND pin_hash IS NOT NULL AND (key = $1 OR lower(name) = $1)
        ORDER BY (key = $1) DESC, id DESC`,
      [name],
    );
    if (!candidates.length) throw new HttpError(401, BAD_PIN);
    const open = candidates.filter((c) => !c.locked);
    if (!open.length) {
      await logKidSignin(candidates[0]!.id, false, device);
      throw new HttpError(429, `Too many wrong PINs. Ask a grown-up, or wait ${PIN_LOCK_MINUTES} minutes.`);
    }
    let kid: (typeof candidates)[number] | null = null;
    for (const c of open) {
      if (c.pin_hash && (await verifyPin(pin, c.pin_hash))) {
        kid = c;
        break;
      }
    }
    if (!kid) {
      for (const c of open) {
        await logKidSignin(c.id, false, device);
        const fails = c.pin_failed + 1;
        await pool.query(
          `UPDATE household_members
              SET pin_failed = CASE WHEN $2::int >= $3::int THEN 0 ELSE $2::int END,
                  pin_locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int)
                                          ELSE pin_locked_until END
            WHERE id = $1`,
          [c.id, fails, PIN_MAX_FAILS, PIN_LOCK_MINUTES],
        );
      }
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
    await logEvent('kid_signin', { device }, kid.id);
    if (b.remember === true) await rememberKidOnDevice(req, res, kid.id, device);
    return { userId, pinVersion: kid.pin_version };
  });
  await startSession(req, result.userId);
  req.session.pinVersion = result.pinVersion;
  req.session.save(() => res.json({ ok: true }));
});

/* ---------- "remember this device": the kid picker on a family device ---------- */

const DEVICE_COOKIE = 'myday.kiddev';

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

/** This browser's device (any household), from its cookie. */
async function deviceByCookie(req: Request): Promise<{ id: number; householdId: number } | null> {
  const token = readCookie(req, DEVICE_COOKIE);
  if (!token) return null;
  return asSystem(async () => {
    const { rows } = await pool.query<{ id: number; household_id: number }>(
      'UPDATE kid_devices SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, household_id',
      [hashToken(token)],
    );
    const r = rows[0];
    return r ? { id: r.id, householdId: r.household_id } : null;
  });
}

/** The device row for this browser's cookie, if it belongs to the current household. */
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
    const { rows } = await pool.query<{ id: number }>('INSERT INTO kid_devices (token_hash, label) VALUES ($1, $2) RETURNING id', [
      hashToken(token),
      label,
    ]);
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
  const out: DeviceKidsResponse = { kids: [] };
  const dev = await deviceByCookie(req);
  if (dev) {
    out.kids = await inHousehold(dev.householdId, async () => {
      const { rows } = await pool.query<{ key: string; name: string }>(
        `SELECT m.key, m.name FROM kid_device_members dm JOIN household_members m ON m.id = dm.member_id
          WHERE dm.device_id = $1 AND m.archived_at IS NULL AND m.pin_hash IS NOT NULL ORDER BY m.sort_order, m.id`,
        [dev.id],
      );
      return rows;
    });
  }
  res.json(out);
});

/** Public: "not me" — drop a kid from this device's picker. */
authRouter.post('/api/auth/kid-device/forget', async (req, res) => {
  const key = typeof (req.body as { key?: unknown }).key === 'string' ? (req.body as { key: string }).key : '';
  const dev = await deviceByCookie(req);
  if (dev && key) {
    await inHousehold(dev.householdId, () =>
      pool.query(
        'DELETE FROM kid_device_members WHERE device_id = $1 AND member_id = (SELECT id FROM household_members WHERE key = $2)',
        [dev.id, key.toLowerCase()],
      ),
    );
  }
  res.json({ ok: true });
});

/* ---------- invites ---------- */

/** Public: what an invite link is for (masked email), so the page can greet them. */
authRouter.get('/api/invites/:token', async (req, res) => {
  const r = await asSystem(async () => {
    const { rows } = await pool.query<{ name: string; email: string; household: string }>(
      `SELECT m.name, i.email, h.name AS household FROM invites i
         JOIN household_members m ON m.id = i.member_id JOIN households h ON h.id = i.household_id
        WHERE i.token_hash = $1 AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
          AND m.archived_at IS NULL`,
      [hashToken(String(req.params.token))],
    );
    return rows[0];
  });
  if (!r) throw new HttpError(404, 'This invite link is no longer valid');
  const [user = '', domain = ''] = r.email.split('@');
  const out: InvitePreview = { name: r.name, email: `${user.slice(0, 1)}***@${domain}`, household: r.household };
  res.json(out);
});

/* ---------- the signed-in user, for every request ---------- */

interface UserRow {
  id: number;
  email: string;
  name: string;
  auth: AuthKind;
  member_id: number | null;
  pin_version: number | null;
  archived: boolean;
  household_id: number | null;
}

/** Loads req.user / req.member and pins the request to the member's household. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const id = req.session.userId;
  if (id) {
    const u = await asSystem(async () => {
      const { rows } = await pool.query<UserRow>(
        `SELECT u.id, u.email, u.name, u.auth, u.member_id, m.pin_version, (m.archived_at IS NOT NULL) AS archived, m.household_id
           FROM users u LEFT JOIN household_members m ON m.id = u.member_id WHERE u.id = $1`,
        [id],
      );
      return rows[0];
    });
    // A parent resetting or removing a kid's PIN ends that kid's existing sessions.
    const stalePin = u?.auth === 'pin' && (u.pin_version === null || u.pin_version !== req.session.pinVersion);
    // Removing someone from the household signs them out everywhere.
    if (u && !stalePin && !u.archived) {
      req.user = { id: u.id, email: u.email, name: u.name, auth: u.auth };
      if (u.household_id !== null && u.member_id !== null) {
        await setHousehold(u.household_id);
        req.householdId = u.household_id;
        req.member = await memberById(u.member_id);
      } else {
        req.member = null;
      }
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  next();
}

/** Everything except onboarding needs a household. */
export function requireHousehold(req: Request, _res: Response, next: NextFunction): void {
  if (!req.member) throw new HttpError(409, 'Create or join a household first');
  next();
}

export async function householdInfo(householdId: number): Promise<HouseholdInfo> {
  const { rows } = await pool.query<{
    id: number;
    name: string;
    type: HouseholdType;
    code: string;
    trial_ends_at: Date | null;
    allow_teen_bank_link: boolean;
    onboarding: Record<string, boolean>;
    modules_off: string[];
    has_kids: boolean;
    signed_in_adults: number;
  }>(
    `SELECT id, name, type, code, trial_ends_at, allow_teen_bank_link, onboarding, modules_off,
            EXISTS (SELECT 1 FROM household_members m WHERE m.household_id = households.id AND m.kind = 'kid' AND m.archived_at IS NULL) AS has_kids,
            (SELECT COUNT(*)::int FROM household_members m
              WHERE m.household_id = households.id AND m.kind = 'adult' AND m.archived_at IS NULL
                AND EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id)) AS signed_in_adults
       FROM households WHERE id = $1`,
    [householdId],
  );
  const h = rows[0];
  if (!h) throw new HttpError(404, 'Household not found');
  return {
    id: h.id,
    name: h.name,
    type: h.type,
    code: h.code,
    trialEndsAt: h.trial_ends_at ? h.trial_ends_at.toISOString() : null,
    allowTeenBankLink: h.allow_teen_bank_link,
    onboarding: h.onboarding,
    modulesOff: h.modules_off.filter((k): k is ModuleKey => (MODULE_KEYS as readonly string[]).includes(k)),
    hasKids: h.has_kids,
    signedInAdults: h.signed_in_adults,
  };
}

export async function meHandler(req: Request, res: Response<Me>): Promise<void> {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  const member = req.member ?? null;
  const { rows } = member
    ? await pool.query<{ xp_track: XpTrack; theme: 'system' | 'light' | 'dark'; accent: string; first_run_done: boolean; ai_consent: boolean }>(
        'SELECT xp_track, theme, accent, first_run_done, ai_consent_at IS NOT NULL AS ai_consent FROM household_members WHERE id = $1',
        [member.id],
      )
    : { rows: [] };
  const r = rows[0];
  res.json({
    userId: req.user.id,
    email: req.user.email,
    name: req.user.name,
    auth: req.user.auth,
    member,
    xpTrack: r?.xp_track ?? null,
    household: req.householdId ? await householdInfo(req.householdId) : null,
    prefs: r ? { theme: r.theme, accent: r.accent, firstRunDone: r.first_run_done } : null,
    aiAllowed: !member || member.kind !== 'kid' || (member.age !== null && member.age >= 13) || !!r?.ai_consent,
    isAdmin: config.adminEmails.includes(req.user.email.toLowerCase()),
    pendingInvite: req.session.pendingInvite ? await peekInvite(req.session.pendingInvite).then((i) => (i ? { household: i.household } : null)) : null,
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
  await logEvent('kid_onboarded', { step: 'pin_set' }, kid.id);
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
