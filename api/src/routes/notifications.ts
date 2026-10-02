/**
 * Notification settings + push subscriptions. Off until the person turns it
 * on; they choose the topics, the time, how often, and their quiet hours.
 */
import { Router } from 'express';
import type { NotificationPrefs, NotificationsResponse } from '@myday/shared';
import { pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { digestFor, pushConfigured, runDigests, sendTo, vapidPublicKey, type Prefs } from '../lib/push.js';
import { registerJob } from '../lib/schedulers.js';
import type { HouseholdMember } from '@myday/shared';

export const notificationsRouter = Router();

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULTS: Prefs = { enabled: false, bills: true, chores: true, homework: true, send_at: '16:00', frequency: 'daily', quiet_start: '21:00', quiet_end: '07:00' };

async function prefsOf(memberId: number): Promise<Prefs> {
  const { rows } = await pool.query<Prefs>(
    'SELECT enabled, bills, chores, homework, send_at, frequency, quiet_start, quiet_end FROM notification_prefs WHERE member_id = $1',
    [memberId],
  );
  return rows[0] ?? DEFAULTS;
}

const toPrefs = (p: Prefs): NotificationPrefs => ({
  enabled: p.enabled, bills: p.bills, chores: p.chores, homework: p.homework,
  sendAt: p.send_at, frequency: p.frequency, quietStart: p.quiet_start, quietEnd: p.quiet_end,
});

async function view(me: HouseholdMember): Promise<NotificationsResponse> {
  const p = await prefsOf(me.id);
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE member_id = $1', [me.id]);
  return {
    prefs: toPrefs(p),
    vapidPublicKey: vapidPublicKey(),
    subscriptions: rows[0]?.n ?? 0,
    preview: await digestFor(me.id, me.kind, p),
  };
}

notificationsRouter.get('/api/notifications', async (req, res) => {
  res.json(await view(self(req)));
});

notificationsRouter.put('/api/notifications', async (req, res) => {
  const me = self(req);
  const b = req.body as Record<string, unknown>;
  const cur = await prefsOf(me.id);
  const pick = (k: keyof NotificationPrefs, ok: (v: unknown) => boolean): unknown => {
    if (b[k] === undefined) return undefined;
    if (!ok(b[k])) throw new HttpError(400, `Bad value for ${k}`);
    return b[k];
  };
  const isBool = (v: unknown): boolean => typeof v === 'boolean';
  const isTime = (v: unknown): boolean => typeof v === 'string' && HHMM.test(v);
  const next: Prefs = {
    enabled: (pick('enabled', isBool) as boolean | undefined) ?? cur.enabled,
    bills: (pick('bills', isBool) as boolean | undefined) ?? cur.bills,
    chores: (pick('chores', isBool) as boolean | undefined) ?? cur.chores,
    homework: (pick('homework', isBool) as boolean | undefined) ?? cur.homework,
    send_at: (pick('sendAt', isTime) as string | undefined) ?? cur.send_at,
    frequency: (pick('frequency', (v) => v === 'daily' || v === 'weekdays' || v === 'weekly') as Prefs['frequency'] | undefined) ?? cur.frequency,
    quiet_start: (pick('quietStart', isTime) as string | undefined) ?? cur.quiet_start,
    quiet_end: (pick('quietEnd', isTime) as string | undefined) ?? cur.quiet_end,
  };
  await pool.query(
    `INSERT INTO notification_prefs (member_id, enabled, bills, chores, homework, send_at, frequency, quiet_start, quiet_end)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (member_id) DO UPDATE SET enabled = EXCLUDED.enabled, bills = EXCLUDED.bills, chores = EXCLUDED.chores,
       homework = EXCLUDED.homework, send_at = EXCLUDED.send_at, frequency = EXCLUDED.frequency,
       quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end`,
    [me.id, next.enabled, next.bills, next.chores, next.homework, next.send_at, next.frequency, next.quiet_start, next.quiet_end],
  );
  res.json(await view(me));
});

/** Save this browser's push subscription. */
notificationsRouter.post('/api/push/subscribe', async (req, res) => {
  const me = self(req);
  if (!pushConfigured()) throw new HttpError(503, 'Notifications are not set up on this server yet');
  const b = req.body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = str(b.endpoint, 'endpoint', 1000, true);
  if (!/^https:\/\//.test(endpoint)) throw new HttpError(400, 'Bad push endpoint');
  await pool.query(
    `INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET member_id = EXCLUDED.member_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [me.id, endpoint, str(b.keys?.p256dh, 'p256dh', 200, true), str(b.keys?.auth, 'auth', 100, true)],
  );
  await logEvent('push_subscribed', {}, me.id);
  res.status(201).json(await view(me));
});

notificationsRouter.post('/api/push/unsubscribe', async (req, res) => {
  const me = self(req);
  const endpoint = str((req.body as { endpoint?: unknown }).endpoint, 'endpoint', 1000);
  if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE member_id = $1 AND endpoint = $2', [me.id, endpoint]);
  else await pool.query('DELETE FROM push_subscriptions WHERE member_id = $1', [me.id]);
  res.json(await view(me));
});

/** "Send me a test" — same copy policy, ignores the schedule. */
notificationsRouter.post('/api/push/test', async (req, res) => {
  const me = self(req);
  if (!pushConfigured()) throw new HttpError(503, 'Notifications are not set up on this server yet');
  const r = await sendTo(me.id, { title: 'MyDay', body: 'Notifications are on. We will keep them few and friendly.' });
  res.json({ ...r });
});

/** Dev/test only: run the digest pass now. */
notificationsRouter.post('/api/push/run-digests', async (req, res) => {
  self(req);
  if (process.env.PUSH_STUB !== '1') throw new HttpError(404, 'Not found');
  res.json({ sent: await runDigests() });
});

registerJob({ name: 'push-digests', everyMs: 5 * 60 * 1000, run: async () => void (await runDigests()) });
