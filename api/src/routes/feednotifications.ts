/**
 * The Feed's notifications: the inbox (grouped), the badge count, read state, push devices and preferences.
 * Grown-ups with a Feed profile only (member()). See lib/feednotify.ts for who hears about what, and when.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { deliverDue, inbox, stubLog, unreadCount } from '../lib/feednotify.js';
import { HttpError } from '../lib/http.js';
import { pushConfigured, vapidPublicKey } from '../lib/push.js';
import { member } from './community.js';
import { logEvent } from '../lib/events.js';

export const feedNotificationsRouter = Router();

const PREF_KEYS = ['push', 'likes', 'comments', 'replies', 'follows', 'mentions', 'dms', 'villages', 'milestones', 'digests'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

feedNotificationsRouter.get('/api/feed/notifications', async (req, res) => {
  const m = await member(req);
  res.set('Cache-Control', 'no-store').json(await inbox(m.userId));
});

/** The badge: how many you haven't seen. */
feedNotificationsRouter.get('/api/feed/notifications/count', async (req, res) => {
  const m = await member(req);
  res.set('Cache-Control', 'no-store').json({ unread: await unreadCount(m.userId) });
});

/** Seen: some groups ({ keys }) or everything. */
feedNotificationsRouter.post('/api/feed/notifications/read', async (req, res) => {
  const m = await member(req);
  const keys = (req.body as { keys?: unknown }).keys;
  await asSystem(() =>
    Array.isArray(keys)
      ? pool.query('UPDATE feed_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND group_key = ANY($2)', [m.userId, keys.filter((k) => typeof k === 'string').slice(0, 200)])
      : pool.query('UPDATE feed_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [m.userId]),
  );
  res.json({ unread: await unreadCount(m.userId) });
});

async function prefsOf(userId: number): Promise<Record<string, boolean | string>> {
  const { rows } = await asSystem(() => pool.query<Record<string, boolean | string>>('SELECT * FROM feed_notification_prefs WHERE user_id = $1', [userId]));
  const r = rows[0];
  const out: Record<string, boolean | string> = {};
  for (const k of PREF_KEYS) out[k] = r ? (r[k] as boolean) : true;
  out.digestEmail = r ? (r.digest_email as boolean) : true;
  out.quietStart = (r?.quiet_start as string) ?? '22:00';
  out.quietEnd = (r?.quiet_end as string) ?? '08:00';
  return out;
}

feedNotificationsRouter.get('/api/feed/notifications/prefs', async (req, res) => {
  const m = await member(req);
  const { rows } = await asSystem(() => pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM feed_push_subscriptions WHERE user_id = $1', [m.userId]));
  res.json({ ...(await prefsOf(m.userId)), devices: rows[0]?.n ?? 0, pushAvailable: pushConfigured() });
});

feedNotificationsRouter.put('/api/feed/notifications/prefs', async (req, res) => {
  const m = await member(req);
  const b = req.body as Record<string, unknown>;
  const cur = await prefsOf(m.userId);
  for (const k of PREF_KEYS) if (typeof b[k] === 'boolean') cur[k] = b[k];
  if (typeof b.digestEmail === 'boolean') cur.digestEmail = b.digestEmail;
  for (const [k, col] of [['quietStart', 'quiet_start'], ['quietEnd', 'quiet_end']] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== 'string' || !HHMM.test(b[k])) throw new HttpError(400, 'Quiet hours are a time, like 22:00');
    cur[k] = b[k];
    void col;
  }
  await asSystem(() =>
    pool.query(
      `INSERT INTO feed_notification_prefs (user_id, push, likes, comments, replies, follows, mentions, dms, villages, milestones, digests, quiet_start, quiet_end, digest_email, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       ON CONFLICT (user_id) DO UPDATE SET push = $2, likes = $3, comments = $4, replies = $5, follows = $6, mentions = $7, dms = $8, villages = $9,
         milestones = $10, digests = $11, quiet_start = $12, quiet_end = $13, digest_email = $14, updated_at = now()`,
      [m.userId, ...PREF_KEYS.map((k) => cur[k]), cur.quietStart, cur.quietEnd, cur.digestEmail],
    ),
  );
  res.json(await prefsOf(m.userId));
});

/** The Feed app's push key (the same VAPID key as MyDay's). */
feedNotificationsRouter.get('/api/feed/push/key', async (req, res) => {
  await member(req);
  res.json({ vapidPublicKey: vapidPublicKey(), configured: pushConfigured() });
});

feedNotificationsRouter.post('/api/feed/push/subscribe', async (req, res) => {
  const m = await member(req);
  const b = req.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof b.endpoint !== 'string' || !/^https:\/\//.test(b.endpoint) || b.endpoint.length > 1000) throw new HttpError(400, 'Not a push subscription');
  if (typeof b.keys?.p256dh !== 'string' || typeof b.keys?.auth !== 'string') throw new HttpError(400, 'Not a push subscription');
  await asSystem(() =>
    pool.query(
      `INSERT INTO feed_push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [m.userId, b.endpoint, b.keys?.p256dh, b.keys?.auth],
    ),
  );
  await asSystem(() => logEvent('push_subscribed', { app: 'feed' }, null, null));
  res.status(201).json({ ok: true });
});

feedNotificationsRouter.post('/api/feed/push/unsubscribe', async (req, res) => {
  const m = await member(req);
  const endpoint = (req.body as { endpoint?: unknown }).endpoint;
  await asSystem(() => pool.query('DELETE FROM feed_push_subscriptions WHERE user_id = $1 AND endpoint = $2', [m.userId, String(endpoint ?? '')]));
  res.json({ ok: true });
});

/** "Send me a test": straight to this person's devices (not counted against anything). */
feedNotificationsRouter.post('/api/feed/push/test', async (req, res) => {
  const m = await member(req);
  await asSystem(() =>
    pool.query(
      `INSERT INTO feed_notifications (user_id, kind, actor_user_id, group_key, url, snippet, push_after)
       VALUES ($1, 'milestone', NULL, 'test:' || extract(epoch from now())::bigint, '/notifications', 'Notifications are on — this is what they look like.', now())`,
      [m.userId],
    ),
  );
  res.json({ sent: await deliverDue() });
});

/** Local/tests only: run delivery now (optionally "as if" at another time), and what was pushed (stubbed). */
feedNotificationsRouter.post('/api/dev/feed/deliver', async (req, res) => {
  if (config.production || !config.devLoginToken || req.query.token !== config.devLoginToken) throw new HttpError(404, 'Not found');
  const at = typeof req.query.at === 'string' ? new Date(req.query.at) : undefined;
  const before = stubLog.length;
  const sent = await deliverDue(at);
  res.json({ sent, pushed: stubLog.slice(before) });
});
