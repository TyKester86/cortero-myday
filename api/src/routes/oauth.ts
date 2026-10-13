/**
 * The Feed Publishing API -- OAuth 2.0 authorization-code flow (item 2).
 *
 *   GET  /oauth/authorize                  the consent page (web app), opened by the third-party app
 *   GET  /api/oauth/authorize/info         what the consent page shows; validates the request first
 *   POST /api/oauth/authorize/decision     Allow (with the scopes the person ticked) or Deny -> {redirect}
 *   POST /api/oauth/token                  code -> tokens; refresh_token -> rotated tokens
 *   POST /api/oauth/revoke                 RFC 7009 token revocation (by the app)
 *   GET/DELETE /api/feed/connected-apps    Settings -> Connected apps (by the person)
 *
 * Rules: redirect URIs match a registered one exactly, and an unknown app or unregistered redirect URI is
 * shown on our page -- never redirected to. Codes are single-use (10 minutes) and a replayed code revokes
 * what it produced. Refresh tokens rotate: each one works once; presenting a rotated-out one revokes the
 * whole grant. Tokens are bound to one (app, person) authorization; revoking it, suspending the app or
 * deleting it kills every token at once. Kids and teens never get here: every step needs a grown-up Feed
 * member (adult() -> 403 adults_only), and every API call re-checks that.
 */
import { randomUUID, createHash } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { FEED_API_SCOPE_LABELS, type FeedApiScope, type FeedConnectedApp } from '@myday/shared';
import { attachUser } from '../auth.js';
import { pool, setHousehold, tx } from '../db.js';
import { logEvent } from '../lib/events.js';
import { LIFETIMES, newAccessToken, newCode, newRefreshToken, parseScopes, secretMatches, sha256 } from '../lib/feedapi.js';
import { HttpError, idParam } from '../lib/http.js';
import { rateLimiter } from '../lib/pin.js';
import { adult, member } from './community.js';

/** Consent + Connected apps (signed-in session, JSON). */
export const oauthRouter = Router();
/** Token + revoke: called server-to-server with form-encoded bodies, so mounted before the JSON/CSRF rule. */
export const oauthTokenRouter = Router();

interface AppRow {
  id: number;
  name: string;
  description: string;
  website: string;
  redirect_uris: string[];
  scopes: FeedApiScope[];
  client_id: string;
  client_secret_hash: string;
  status: 'active' | 'suspended';
  owner_user_id: number;
}

async function appByClientId(clientId: string): Promise<AppRow | null> {
  if (!clientId || clientId.length > 100) return null;
  const { rows } = await pool.query<AppRow>('SELECT * FROM feed_api_apps WHERE client_id = $1', [clientId]);
  return rows[0] ?? null;
}

/* ======================= authorize (consent) ======================= */

interface AuthorizeRequest {
  app: AppRow;
  redirectUri: string;
  scopes: FeedApiScope[];
  state: string | null;
  codeChallenge: string | null;
}

const q = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `redirect_uri` plus OAuth error/response params (the app's own query string is kept). */
function back(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Validate an authorization request. Problems with the app or the redirect URI are errors on our page
 * (never a redirect: we can't trust where it would go). Anything else is an error the app should hear
 * about, so it carries `details.redirect` -- the app's redirect URI with `error=`.
 */
async function authorizeRequest(p: Record<string, unknown>): Promise<AuthorizeRequest> {
  const app = await appByClientId(q(p.client_id));
  if (!app) throw new HttpError(400, 'This link is for an app The Feed doesn’t know (unknown client_id).', 'invalid_client');
  const redirectUri = q(p.redirect_uri);
  if (!redirectUri || !app.redirect_uris.includes(redirectUri)) {
    throw new HttpError(400, `“${app.name}” sent a redirect address it hasn’t registered, so we stopped here.`, 'invalid_redirect_uri');
  }
  if (app.status !== 'active') throw new HttpError(403, `“${app.name}” is suspended and can’t be connected right now.`, 'app_suspended');
  const state = q(p.state) || null;
  if (state && state.length > 500) throw new HttpError(400, 'state is too long', 'invalid_request');
  const fail = (code: string, message: string): never => {
    throw new HttpError(400, message, code, { redirect: back(redirectUri, { error: code, error_description: message, state }) });
  };
  if (q(p.response_type) !== 'code') fail('unsupported_response_type', 'response_type must be “code”');
  let scopes: FeedApiScope[] = [];
  try {
    scopes = parseScopes(q(p.scope));
  } catch {
    fail('invalid_scope', 'Unknown scope requested');
  }
  if (!scopes.length) scopes = app.scopes;
  if (scopes.some((s) => !app.scopes.includes(s))) fail('invalid_scope', 'The app asked for a scope it isn’t registered for');
  const codeChallenge = q(p.code_challenge) || null;
  if (codeChallenge) {
    if (q(p.code_challenge_method) !== 'S256') fail('invalid_request', 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) fail('invalid_request', 'code_challenge must be base64url, 43–128 characters');
  } else if (p.code_challenge_method) fail('invalid_request', 'code_challenge_method without code_challenge');
  return { app, redirectUri, scopes, state, codeChallenge };
}

oauthRouter.get('/api/oauth/authorize/info', async (req, res) => {
  const m = await member(req);
  const a = await authorizeRequest(req.query as Record<string, unknown>);
  const { rows: owner } = await pool.query<{ display_name: string | null; username: string | null }>(
    'SELECT display_name, username FROM social_profiles WHERE user_id = $1',
    [a.app.owner_user_id],
  );
  const { rows: live } = await pool.query<{ scopes: string[] }>('SELECT scopes FROM feed_api_authorizations WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL', [a.app.id, m.userId]);
  res.json({
    app: { name: a.app.name, description: a.app.description, website: a.app.website, developer: owner[0]?.username ? `@${owner[0].username}` : (owner[0]?.display_name ?? null) },
    scopes: a.scopes.map((s) => ({ scope: s, label: FEED_API_SCOPE_LABELS[s] })),
    account: { displayName: m.profile.display_name, username: m.profile.username, email: req.user!.email },
    alreadyConnected: live.length > 0,
    redirectHost: new URL(a.redirectUri).host,
  });
});

oauthRouter.post('/api/oauth/authorize/decision', async (req, res) => {
  const m = await member(req);
  const b = req.body as Record<string, unknown>;
  const a = await authorizeRequest(b);
  if (b.approve !== true) {
    res.json({ redirect: back(a.redirectUri, { error: 'access_denied', error_description: 'The person declined', state: a.state }) });
    return;
  }
  // Nothing is pre-ticked on the consent page: the person grants exactly the scopes they ticked.
  const granted = parseScopes(b.grant, 'grant');
  if (!granted.length) throw new HttpError(400, 'Tick at least one permission, or choose Cancel', 'invalid_scope');
  if (granted.some((s) => !a.scopes.includes(s))) throw new HttpError(400, 'You can only grant what the app asked for', 'invalid_scope');
  const code = newCode();
  await tx(async () => {
    const { rows } = await pool.query<{ id: number; scopes: string[] }>(
      'SELECT id, scopes FROM feed_api_authorizations WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL FOR UPDATE',
      [a.app.id, m.userId],
    );
    let authId = rows[0]?.id;
    if (authId) {
      await pool.query('UPDATE feed_api_authorizations SET scopes = $2, updated_at = now() WHERE id = $1', [authId, [...new Set([...rows[0]!.scopes, ...granted])]]);
    } else {
      const ins = await pool.query<{ id: number }>('INSERT INTO feed_api_authorizations (app_id, user_id, scopes) VALUES ($1, $2, $3) RETURNING id', [a.app.id, m.userId, granted]);
      authId = ins.rows[0]!.id;
    }
    await pool.query(
      `INSERT INTO feed_api_codes (code_hash, authorization_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, grant_id)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), $8)`,
      [sha256(code), authId, a.redirectUri, granted, a.codeChallenge, a.codeChallenge ? 'S256' : null, LIFETIMES.code, randomUUID()],
    );
  });
  await logEvent('feed_api_authorized', { userId: m.userId, appId: a.app.id, scopes: granted.join(' ') });
  res.json({ redirect: back(a.redirectUri, { code, state: a.state }) });
});

/* ======================= Connected apps (Settings) ======================= */

// adult(), not member(): even someone whose Feed access was removed can still disconnect apps.
oauthRouter.get('/api/feed/connected-apps', async (req, res) => {
  const a = await adult(req);
  const { rows } = await pool.query<{ app_id: number; name: string; website: string; scopes: FeedApiScope[]; created_at: Date; status: 'active' | 'suspended' }>(
    `SELECT z.app_id, p.name, p.website, z.scopes, z.created_at, p.status
       FROM feed_api_authorizations z JOIN feed_api_apps p ON p.id = z.app_id
      WHERE z.user_id = $1 AND z.revoked_at IS NULL ORDER BY z.created_at DESC`,
    [a.userId],
  );
  const apps: FeedConnectedApp[] = rows.map((r) => ({ appId: r.app_id, name: r.name, website: r.website, scopes: r.scopes, connectedAt: r.created_at.toISOString(), status: r.status }));
  res.json({ apps });
});

/** Disconnect an app: its authorization ends and every token and unused code it holds for you dies now. */
oauthRouter.delete('/api/feed/connected-apps/:appId', async (req, res) => {
  const a = await adult(req);
  const appId = idParam(req.params.appId);
  const revoked = await tx(async () => {
    const { rows } = await pool.query<{ id: number }>(
      'UPDATE feed_api_authorizations SET revoked_at = now() WHERE app_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
      [appId, a.userId],
    );
    if (!rows.length) throw new HttpError(404, 'That app isn’t connected');
    const ids = rows.map((r) => r.id);
    const t = await pool.query('UPDATE feed_api_tokens SET revoked_at = now() WHERE authorization_id = ANY($1) AND revoked_at IS NULL', [ids]);
    await pool.query('UPDATE feed_api_codes SET used_at = now() WHERE authorization_id = ANY($1) AND used_at IS NULL', [ids]);
    return t.rowCount ?? 0;
  });
  await logEvent('feed_api_revoked', { userId: a.userId, appId, tokens: revoked, by: 'user' });
  res.json({ ok: true });
});

/* ======================= token + revoke (RFC 6749 / 7009) ======================= */

/** OAuth's own error shape: {error, error_description} (RFC 6749 §5.2). */
class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

const tokenLimit = rateLimiter(120, 60_000);

/** Client authentication: HTTP Basic (preferred) or client_id + client_secret in the body. */
async function clientAuth(req: Request): Promise<AppRow> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  let id = '';
  let secret = '';
  const h = req.headers.authorization ?? '';
  if (/^Basic\s+/i.test(h)) {
    const dec = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    try {
      id = decodeURIComponent(dec.slice(0, i));
      secret = decodeURIComponent(dec.slice(i + 1));
    } catch {
      id = '';
    }
  } else {
    id = q(b.client_id);
    secret = q(b.client_secret);
  }
  if (!tokenLimit(`${req.ip}|${id}`)) throw new OAuthError(429, 'slow_down', 'Too many token requests; wait a minute');
  const app = id && secret ? await appByClientId(id) : null;
  if (!app || !secretMatches(secret, app.client_secret_hash)) throw new OAuthError(401, 'invalid_client', 'Client authentication failed');
  if (app.status !== 'active') throw new OAuthError(401, 'invalid_client', 'This app is suspended');
  return app;
}

interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
}

async function issueTokens(authorizationId: number, grantId: string, scopes: string[]): Promise<TokenResponse> {
  const access = newAccessToken();
  const refresh = newRefreshToken();
  await pool.query(
    `INSERT INTO feed_api_tokens (token_hash, kind, authorization_id, grant_id, scopes, expires_at) VALUES
       ($1, 'access', $3, $4, $5, now() + make_interval(secs => $6)),
       ($2, 'refresh', $3, $4, $5, now() + make_interval(secs => $7))`,
    [sha256(access), sha256(refresh), authorizationId, grantId, scopes, LIFETIMES.access, LIFETIMES.refresh],
  );
  return { access_token: access, token_type: 'Bearer', expires_in: LIFETIMES.access, refresh_token: refresh, refresh_token_expires_in: LIFETIMES.refresh, scope: scopes.join(' ') };
}

const revokeGrant = (grantId: string): Promise<unknown> => pool.query('UPDATE feed_api_tokens SET revoked_at = now() WHERE grant_id = $1 AND revoked_at IS NULL', [grantId]);

const b64url = (buf: Buffer): string => buf.toString('base64url');

async function codeGrant(app: AppRow, b: Record<string, unknown>): Promise<TokenResponse> {
  const code = q(b.code);
  if (!code) throw new OAuthError(400, 'invalid_request', 'code is required');
  // Result first, then (outside the transaction, so a replay's revocation commits) the error if any.
  const out = await tx(async (): Promise<TokenResponse | OAuthError> => {
    const { rows } = await pool.query<{
      authorization_id: number;
      redirect_uri: string;
      scopes: string[];
      code_challenge: string | null;
      expired: boolean;
      used_at: Date | null;
      grant_id: string | null;
      app_id: number;
      auth_revoked: Date | null;
    }>(
      `SELECT c.authorization_id, c.redirect_uri, c.scopes, c.code_challenge, c.expires_at <= now() AS expired, c.used_at, c.grant_id,
              z.app_id, z.revoked_at AS auth_revoked
         FROM feed_api_codes c JOIN feed_api_authorizations z ON z.id = c.authorization_id
        WHERE c.code_hash = $1 FOR UPDATE OF c`,
      [sha256(code)],
    );
    const c = rows[0];
    if (!c || c.app_id !== app.id) return new OAuthError(400, 'invalid_grant', 'Unknown authorization code');
    if (c.used_at) {
      if (c.grant_id) await revokeGrant(c.grant_id);
      return new OAuthError(400, 'invalid_grant', 'This authorization code was already used; tokens issued from it are now revoked');
    }
    if (c.expired) return new OAuthError(400, 'invalid_grant', 'The authorization code expired (they last 10 minutes)');
    if (c.auth_revoked) return new OAuthError(400, 'invalid_grant', 'The person disconnected this app');
    if (q(b.redirect_uri) !== c.redirect_uri) return new OAuthError(400, 'invalid_grant', 'redirect_uri doesn’t match the one used to authorize');
    if (c.code_challenge) {
      const v = q(b.code_verifier);
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(v) || b64url(createHash('sha256').update(v).digest()) !== c.code_challenge) {
        return new OAuthError(400, 'invalid_grant', 'code_verifier doesn’t match the code_challenge');
      }
    }
    await pool.query('UPDATE feed_api_codes SET used_at = now() WHERE code_hash = $1', [sha256(code)]);
    return issueTokens(c.authorization_id, c.grant_id ?? randomUUID(), c.scopes);
  });
  if (out instanceof OAuthError) throw out;
  return out;
}

async function refreshGrant(app: AppRow, b: Record<string, unknown>): Promise<TokenResponse> {
  const token = q(b.refresh_token);
  if (!token) throw new OAuthError(400, 'invalid_request', 'refresh_token is required');
  const out = await tx(async (): Promise<TokenResponse | OAuthError> => {
    const { rows } = await pool.query<{
      id: number;
      authorization_id: number;
      grant_id: string;
      scopes: string[];
      expired: boolean;
      revoked_at: Date | null;
      rotated_at: Date | null;
      app_id: number;
      user_id: number;
      auth_revoked: Date | null;
    }>(
      `SELECT t.id, t.authorization_id, t.grant_id, t.scopes, t.expires_at <= now() AS expired, t.revoked_at, t.rotated_at,
              z.app_id, z.user_id, z.revoked_at AS auth_revoked
         FROM feed_api_tokens t JOIN feed_api_authorizations z ON z.id = t.authorization_id
        WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`,
      [sha256(token)],
    );
    const t = rows[0];
    if (!t || t.app_id !== app.id) return new OAuthError(400, 'invalid_grant', 'Unknown refresh token');
    if (t.rotated_at) {
      // Someone presented a refresh token that was already exchanged: it may have leaked. Kill the grant.
      await revokeGrant(t.grant_id);
      await logEvent('feed_api_refresh_reuse', { appId: app.id, userId: t.user_id });
      return new OAuthError(400, 'invalid_grant', 'This refresh token was already used; every token from this grant is now revoked. Ask the person to connect again.');
    }
    if (t.revoked_at) return new OAuthError(400, 'invalid_grant', 'This refresh token was revoked');
    if (t.expired) return new OAuthError(400, 'invalid_grant', 'This refresh token expired; ask the person to connect again');
    if (t.auth_revoked) return new OAuthError(400, 'invalid_grant', 'The person disconnected this app');
    let scopes = t.scopes;
    if (q(b.scope)) {
      const asked = parseScopes(q(b.scope));
      if (asked.some((s) => !t.scopes.includes(s))) return new OAuthError(400, 'invalid_scope', 'A refresh can only keep or narrow the granted scopes');
      scopes = asked;
    }
    await pool.query('UPDATE feed_api_tokens SET rotated_at = now(), revoked_at = now() WHERE id = $1', [t.id]);
    return issueTokens(t.authorization_id, t.grant_id, scopes);
  });
  if (out instanceof OAuthError) throw out;
  return out;
}

const tokenBody = [express.urlencoded({ extended: false, limit: '16kb' }), express.json({ limit: '16kb' })];

function oauthErrors(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof OAuthError) {
        if (e.status === 401) res.set('WWW-Authenticate', 'Basic realm="The Feed"');
        res.status(e.status).json({ error: e.error, error_description: e.message });
        return;
      }
      if (e instanceof HttpError && e.code === 'invalid_scope') {
        res.status(400).json({ error: 'invalid_scope', error_description: e.message });
        return;
      }
      next(e);
    }
  };
}

oauthTokenRouter.post(
  '/api/oauth/token',
  ...tokenBody,
  oauthErrors(async (req, res) => {
    const app = await clientAuth(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const grant = q(b.grant_type);
    if (grant === 'authorization_code') res.json(await codeGrant(app, b));
    else if (grant === 'refresh_token') res.json(await refreshGrant(app, b));
    else throw new OAuthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  }),
);

/** RFC 7009: always 200 for a well-formed request (an unknown token is already "revoked"). */
oauthTokenRouter.post(
  '/api/oauth/revoke',
  ...tokenBody,
  oauthErrors(async (req, res) => {
    const app = await clientAuth(req);
    const token = q((req.body as Record<string, unknown>)?.token);
    if (!token) throw new OAuthError(400, 'invalid_request', 'token is required');
    const { rows } = await pool.query<{ id: number; kind: 'access' | 'refresh'; grant_id: string }>(
      `SELECT t.id, t.kind, t.grant_id FROM feed_api_tokens t JOIN feed_api_authorizations z ON z.id = t.authorization_id
        WHERE t.token_hash = $1 AND z.app_id = $2`,
      [sha256(token), app.id],
    );
    const t = rows[0];
    // A refresh token takes its whole grant with it; an access token just itself.
    if (t?.kind === 'refresh') await revokeGrant(t.grant_id);
    else if (t) await pool.query('UPDATE feed_api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [t.id]);
    res.json({});
  }),
);

/* ======================= the bearer check (every /api/v1 call) ======================= */

/** v1 errors: the API's usual {error, code}; 401s also say how to authenticate. */
function unauthorized(res: Response, message: string, code = 'invalid_token'): never {
  res.set('WWW-Authenticate', `Bearer realm="The Feed", error="invalid_token"`);
  throw new HttpError(401, message, code);
}

/**
 * Authenticates a Publishing API call by its access token, and only by it (a browser session cookie is
 * ignored here). Live token + unrevoked authorization + active app, then the person is loaded exactly as a
 * session would load them, so every Feed rule (18+, profile, ban, mute, limits) applies unchanged.
 */
export async function bearer(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.user = undefined;
  req.member = undefined;
  req.householdId = undefined;
  await setHousehold(null);
  const m = /^Bearer\s+([A-Za-z0-9_.~+/=-]+)$/i.exec(req.headers.authorization ?? '');
  if (!m) unauthorized(res, 'Send an access token: Authorization: Bearer <token>', 'missing_token');
  const { rows } = await pool.query<{ id: number; scopes: string[]; authorization_id: number; user_id: number; app_id: number; name: string; status: string }>(
    `SELECT t.id, t.scopes, t.authorization_id, z.user_id, z.app_id, a.name, a.status
       FROM feed_api_tokens t
       JOIN feed_api_authorizations z ON z.id = t.authorization_id
       JOIN feed_api_apps a ON a.id = z.app_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND z.revoked_at IS NULL`,
    [sha256(m![1]!)],
  );
  const t = rows[0];
  if (!t) unauthorized(res, 'The access token is invalid, expired or revoked');
  if (t!.status !== 'active') unauthorized(res, 'This app is suspended', 'app_suspended');
  if (!(await attachUser(req, t!.user_id, 'none'))) unauthorized(res, 'The account behind this token is gone');
  req.apiAuth = { appId: t!.app_id, appName: t!.name, userId: t!.user_id, authorizationId: t!.authorization_id, tokenId: t!.id, scopes: t!.scopes };
  next();
}

/** The token must carry `scope`, else 403 insufficient_scope. */
export function needScope(req: Request, res: Response, scope: FeedApiScope): void {
  if (!req.apiAuth?.scopes.includes(scope)) {
    res.set('WWW-Authenticate', `Bearer realm="The Feed", error="insufficient_scope", scope="${scope}"`);
    throw new HttpError(403, `This token wasn’t granted ${scope}`, 'insufficient_scope');
  }
}
