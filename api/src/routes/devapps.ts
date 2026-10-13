/**
 * The Feed Publishing API -- the developer app registry (item 1).
 *
 * A signed-in Feed member (18+, with a Feed profile, not banned) registers an application: name,
 * description, website, an exact-match list of redirect URIs and the scopes it may ask for. They get a
 * client_id and a client_secret; the secret is shown exactly once and only its SHA-256 hash is stored.
 * The owner may rotate the secret or delete the app. A MyDay admin may suspend or reactivate any app:
 * suspending revokes every token the app holds at once (and the bearer check refuses a suspended app's
 * tokens on every call anyway, so a reactivated app's users must authorize it again).
 */
import { Router } from 'express';
import type { FeedApiApp, FeedApiAppCreated, FeedApiScope } from '@myday/shared';
import { pool, tx } from '../db.js';
import { logEvent } from '../lib/events.js';
import { checkRedirectUri, newClientId, newClientSecret, parseScopes, sha256 } from '../lib/feedapi.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { member, staff } from './community.js';

/** Owner routes (Feed members). */
export const devAppsRouter = Router();
/** Admin routes (MyDay admins, with or without a household). */
export const devAppsStaffRouter = Router();

const MAX_APPS_PER_OWNER = 10;

interface AppRow {
  id: number;
  owner_user_id: number;
  name: string;
  description: string;
  website: string;
  redirect_uris: string[];
  scopes: FeedApiScope[];
  client_id: string;
  status: 'active' | 'suspended';
  suspended_at: Date | null;
  suspended_reason: string | null;
  created_at: Date;
  users: string | number;
  owner_email?: string;
}

const APP_COLS = `a.*, (SELECT COUNT(*) FROM feed_api_authorizations z WHERE z.app_id = a.id AND z.revoked_at IS NULL) AS users`;

function toApp(r: AppRow, withOwner = false): FeedApiApp {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    website: r.website,
    redirectUris: r.redirect_uris,
    scopes: r.scopes,
    clientId: r.client_id,
    status: r.status,
    suspendedAt: r.suspended_at?.toISOString() ?? null,
    suspendedReason: r.suspended_reason,
    createdAt: r.created_at.toISOString(),
    users: Number(r.users),
    ...(withOwner ? { owner: { userId: r.owner_user_id, email: r.owner_email ?? '' } } : {}),
  };
}

/** Validated registration fields (shared by create and edit). */
function appFields(b: Record<string, unknown>): { name: string; description: string; website: string; redirectUris: string[]; scopes: FeedApiScope[] } {
  const name = str(b.name, 'name', 60).trim();
  if (name.length < 2) throw new HttpError(400, 'Give your app a name (2–60 characters)');
  const description = (str(b.description ?? '', 'description', 500) || '').trim();
  const website = (str(b.website ?? '', 'website', 300) || '').trim();
  if (website) {
    try {
      const u = new URL(website);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    } catch {
      throw new HttpError(400, 'Website must be a full http(s) URL');
    }
  }
  const raw = Array.isArray(b.redirectUris) ? b.redirectUris : typeof b.redirectUris === 'string' ? b.redirectUris.split(/\s+/) : [];
  const redirectUris = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  if (redirectUris.length < 1 || redirectUris.length > 10) throw new HttpError(400, 'Add between 1 and 10 redirect URIs', 'invalid_redirect_uri');
  redirectUris.forEach(checkRedirectUri);
  const scopes = parseScopes(b.scopes, 'scopes');
  if (!scopes.length) throw new HttpError(400, 'Pick at least one scope', 'invalid_scope');
  return { name, description, website, redirectUris, scopes };
}

async function ownApp(userId: number, id: number): Promise<AppRow> {
  const { rows } = await pool.query<AppRow>(`SELECT ${APP_COLS} FROM feed_api_apps a WHERE a.id = $1 AND a.owner_user_id = $2`, [id, userId]);
  if (!rows[0]) throw new HttpError(404, 'App not found');
  return rows[0];
}

/** Revoke every live token an app holds (suspension, deletion). Returns how many died. */
export async function revokeAppTokens(appId: number): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE feed_api_tokens t SET revoked_at = now() FROM feed_api_authorizations z
      WHERE t.authorization_id = z.id AND z.app_id = $1 AND t.revoked_at IS NULL`,
    [appId],
  );
  await pool.query('UPDATE feed_api_codes c SET used_at = now() FROM feed_api_authorizations z WHERE c.authorization_id = z.id AND z.app_id = $1 AND c.used_at IS NULL', [appId]);
  return rowCount ?? 0;
}

/* ---------- owner ---------- */

devAppsRouter.get('/api/developer/apps', async (req, res) => {
  const m = await member(req);
  const { rows } = await pool.query<AppRow>(`SELECT ${APP_COLS} FROM feed_api_apps a WHERE a.owner_user_id = $1 ORDER BY a.created_at DESC`, [m.userId]);
  res.json({ apps: rows.map((r) => toApp(r)) });
});

devAppsRouter.post('/api/developer/apps', async (req, res) => {
  const m = await member(req);
  const f = appFields(req.body as Record<string, unknown>);
  const { rows: n } = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM feed_api_apps WHERE owner_user_id = $1', [m.userId]);
  if (Number(n[0]?.n ?? 0) >= MAX_APPS_PER_OWNER) throw new HttpError(409, `You can register up to ${MAX_APPS_PER_OWNER} apps`, 'app_limit');
  const secret = newClientSecret();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO feed_api_apps (owner_user_id, name, description, website, redirect_uris, scopes, client_id, client_secret_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [m.userId, f.name, f.description, f.website, f.redirectUris, f.scopes, newClientId(), sha256(secret)],
  );
  await logEvent('feed_api_app_registered', { userId: m.userId, appId: rows[0]!.id });
  const out: FeedApiAppCreated = { app: toApp(await ownApp(m.userId, rows[0]!.id)), clientSecret: secret };
  res.status(201).json(out);
});

/** Edit the listing: name, description, website, redirect URIs, scopes. Existing grants keep the scopes they were given. */
devAppsRouter.put('/api/developer/apps/:id', async (req, res) => {
  const m = await member(req);
  const app = await ownApp(m.userId, idParam(req.params.id));
  const f = appFields(req.body as Record<string, unknown>);
  await pool.query('UPDATE feed_api_apps SET name = $2, description = $3, website = $4, redirect_uris = $5, scopes = $6 WHERE id = $1', [
    app.id, f.name, f.description, f.website, f.redirectUris, f.scopes,
  ]);
  res.json({ app: toApp(await ownApp(m.userId, app.id)) });
});

/** A fresh client secret; the old one stops working immediately. Shown once. */
devAppsRouter.post('/api/developer/apps/:id/secret', async (req, res) => {
  const m = await member(req);
  const app = await ownApp(m.userId, idParam(req.params.id));
  const secret = newClientSecret();
  await pool.query('UPDATE feed_api_apps SET client_secret_hash = $2 WHERE id = $1', [app.id, sha256(secret)]);
  await logEvent('feed_api_secret_rotated', { userId: m.userId, appId: app.id });
  const out: FeedApiAppCreated = { app: toApp(app), clientSecret: secret };
  res.json(out);
});

/** Delete the app: every authorization, code and token goes with it (ON DELETE CASCADE). Posts it made stay, still "via" its name. */
devAppsRouter.delete('/api/developer/apps/:id', async (req, res) => {
  const m = await member(req);
  const app = await ownApp(m.userId, idParam(req.params.id));
  await pool.query('DELETE FROM feed_api_apps WHERE id = $1', [app.id]);
  await logEvent('feed_api_app_deleted', { userId: m.userId, appId: app.id });
  res.json({ ok: true });
});

/* ---------- admin ---------- */

devAppsStaffRouter.get('/api/admin/feed-api/apps', async (req, res) => {
  staff(req);
  const { rows } = await pool.query<AppRow>(
    `SELECT ${APP_COLS}, u.email AS owner_email FROM feed_api_apps a JOIN users u ON u.id = a.owner_user_id ORDER BY a.created_at DESC LIMIT 500`,
  );
  res.json({ apps: rows.map((r) => toApp(r, true)) });
});

devAppsStaffRouter.post('/api/admin/feed-api/apps/:id/suspend', async (req, res) => {
  const by = staff(req);
  const id = idParam(req.params.id);
  const reason = (str((req.body as Record<string, unknown>)?.reason ?? '', 'reason', 300) || '').trim() || null;
  const revoked = await tx(async () => {
    const { rowCount } = await pool.query(
      `UPDATE feed_api_apps SET status = 'suspended', suspended_at = now(), suspended_reason = $2 WHERE id = $1`,
      [id, reason],
    );
    if (!rowCount) throw new HttpError(404, 'App not found');
    return revokeAppTokens(id);
  });
  await logEvent('feed_api_app_suspended', { appId: id, by, revoked });
  res.json({ ok: true, revokedTokens: revoked });
});

devAppsStaffRouter.post('/api/admin/feed-api/apps/:id/reactivate', async (req, res) => {
  const by = staff(req);
  const id = idParam(req.params.id);
  const { rowCount } = await pool.query(
    `UPDATE feed_api_apps SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1`,
    [id],
  );
  if (!rowCount) throw new HttpError(404, 'App not found');
  await logEvent('feed_api_app_reactivated', { appId: id, by });
  res.json({ ok: true });
});
