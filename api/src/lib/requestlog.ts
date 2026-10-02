/**
 * Request-level middleware: idempotent replays for offline writes, and the
 * once-a-day "module_used" event per member per module.
 */
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db.js';
import { today } from './dates.js';
import { logEvent } from './events.js';

/**
 * Offline writes are queued on the device and replayed on reconnect with an
 * Idempotency-Key header. The first response for a key is stored and any
 * replay gets that same response back instead of applying the write twice.
 */
export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['idempotency-key'];
  if (req.method === 'GET' || typeof key !== 'string' || !key || key.length > 100 || !req.user || !req.member) {
    next();
    return;
  }
  const userId = req.user.id;
  const { rows } = await pool.query<{ status: number; body: unknown }>(
    'SELECT status, body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  const hit = rows[0];
  if (hit) {
    res.setHeader('Idempotent-Replay', 'true');
    res.status(hit.status).json(hit.body);
    return;
  }
  // A write that waited in the device's offline queue and is now syncing.
  if (req.headers['x-myday-replay'] === '1') void logEvent('offline_synced', { path: req.path.slice(0, 60) }, req.member.id);
  const json = res.json.bind(res);
  res.json = (body: unknown): Response => {
    if (res.statusCode < 500) {
      pool
        .query(
          `INSERT INTO idempotency_keys (key, user_id, status, body) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [key, userId, res.statusCode, JSON.stringify(body ?? null)],
        )
        .catch((e: unknown) => console.error('idempotency store failed', e));
    }
    return json(body);
  };
  next();
}

const MODULE_OF: Record<string, string> = {
  chores: 'chores',
  homework: 'homework',
  rewards: 'rewards',
  redemptions: 'rewards',
  score: 'score',
  workouts: 'health',
  habits: 'health',
  program: 'health',
  meals: 'meals',
  'meal-plan': 'meals',
  grocery: 'grocery',
  'weekly-plan': 'weekly',
  day: 'my_day',
  dump: 'brain_dump',
  battles: 'battles',
  'red-alert': 'red_alert',
  family: 'family',
  household: 'household',
  chat: 'hana',
  money: 'money',
  bills: 'money',
  classes: 'study',
  lectures: 'study',
  study: 'study',
  school: 'school',
  identity: 'identity',
  'kid-money': 'kid_money',
  quests: 'engagement',
  feed: 'engagement',
  sunday: 'engagement',
  records: 'records',
};

const seen = new Set<string>();

/** Logs module_used at most once per member per module per day (per process). */
export function moduleUsed(req: Request, _res: Response, next: NextFunction): void {
  const seg = req.path.split('/')[2] ?? '';
  const mod = MODULE_OF[seg];
  const member = req.member;
  if (mod && member) {
    const k = `${member.id}:${mod}:${today()}`;
    if (!seen.has(k)) {
      seen.add(k);
      if (seen.size > 50_000) seen.clear();
      void logEvent('module_used', { module: mod }, member.id);
    }
  }
  next();
}
