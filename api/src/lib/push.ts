/**
 * Web push, gentle by design:
 *  - batched: at most ONE nudge per person per day, at the time they chose,
 *    never during their quiet hours, and only on the days they chose;
 *  - opt-in per topic (bills, chores, homework);
 *  - no guilt: every notification passes the copy policy below, which
 *    refuses shaming / pressure language outright (it throws).
 *
 * Real delivery uses VAPID (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
 * VAPID_SUBJECT). PUSH_STUB=1 (never in production) records what would have
 * been sent without contacting a push service.
 */
import webpush from 'web-push';
import type { DateStr } from '@myday/shared';
import { config } from '../config.js';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, isoWeekday, today } from './dates.js';
import { logEvent } from './events.js';

/** Whole words MyDay never sends (case-insensitive). */
export const BANNED_WORDS = [
  'overdue', 'behind', 'failed', 'fail', 'failure', 'failing', 'missed', 'forgot', 'forgotten', 'lazy', 'shame', 'ashamed',
  'hurry', 'urgent', 'late', 'slacking', 'guilty', 'neglected',
];
/** Phrases MyDay never sends (case-insensitive, matched anywhere). */
export const BANNED_PHRASES = [
  "don't forget", 'do not forget', 'should have', "should've", 'still haven', 'why haven', 'you never', 'you always',
  'disappoint', 'last chance', 'or else', 'falling behind', 'streak is at risk', 'you will lose',
];

export class CopyPolicyError extends Error {}

/** The copy policy. Every push goes through this; violations are refused, not softened. */
export function assertGentle(text: string): void {
  const t = text.toLowerCase().replace(/’/g, "'");
  const words = new Set(t.split(/[^a-z']+/));
  const hit = BANNED_WORDS.find((w) => words.has(w)) ?? BANNED_PHRASES.find((p) => t.includes(p));
  if (hit) throw new CopyPolicyError(`Notification copy refused by policy (“${hit}”)`);
  if ((text.match(/!/g) ?? []).length > 1) throw new CopyPolicyError('Notification copy refused by policy (shouting)');
  if (/[A-Z]{5,}/.test(text)) throw new CopyPolicyError('Notification copy refused by policy (all caps)');
}

export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function stubbed(): boolean {
  return process.env.PUSH_STUB === '1' && !config.production;
}

let vapidSet = false;
function realPush(): boolean {
  const pub = process.env.VAPID_PUBLIC_KEY ?? '';
  const priv = process.env.VAPID_PRIVATE_KEY ?? '';
  if (!pub || !priv) return false;
  if (!vapidSet) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || `mailto:support@${new URL(config.publicUrl).hostname}`, pub, priv);
    vapidSet = true;
  }
  return true;
}

export function pushConfigured(): boolean {
  return realPush() || stubbed();
}

/** HH:MM in the household time zone. */
export function localTime(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
}

export function inQuietHours(hhmm: string, start: string, end: string): boolean {
  return start <= end ? hhmm >= start && hhmm < end : hhmm >= start || hhmm < end;
}

export interface Prefs {
  enabled: boolean;
  bills: boolean;
  chores: boolean;
  homework: boolean;
  send_at: string;
  frequency: 'daily' | 'weekdays' | 'weekly';
  quiet_start: string;
  quiet_end: string;
}

/** The one batched, gentle message for today — or null if there's nothing worth a ping. */
export async function digestFor(memberId: number, kind: 'kid' | 'adult', p: Pick<Prefs, 'bills' | 'chores' | 'homework'>): Promise<{ title: string; body: string } | null> {
  const t = today();
  const bits: string[] = [];
  if (p.chores) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM chores c WHERE c.active AND c.member_id = $1 AND $2 = ANY(c.days)
         AND NOT EXISTS (SELECT 1 FROM chore_completions cc WHERE cc.chore_id = c.id AND cc.completed_on = $3)`,
      [memberId, isoWeekday(t), t],
    );
    const n = rows[0]?.n ?? 0;
    if (n) bits.push(`${n} chore${n === 1 ? '' : 's'}`);
  }
  if (p.homework) {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM homework WHERE member_id = $1 AND NOT done AND due IS NOT NULL AND due <= $2',
      [memberId, addDays(t, 1)],
    );
    const n = rows[0]?.n ?? 0;
    if (n) bits.push(`${n} homework for tomorrow`);
  }
  if (p.bills && kind === 'adult') {
    const { rows } = await pool.query<{ due_day: number }>('SELECT due_day FROM bills WHERE member_id = $1 AND due_day IS NOT NULL AND NOT autopay', [memberId]);
    const soon = new Set([0, 1, 2, 3].map((i) => Number(addDays(t, i).slice(8))));
    const n = rows.filter((r) => soon.has(r.due_day)).length;
    if (n) bits.push(`${n} bill${n === 1 ? '' : 's'} coming up this week`);
  }
  if (!bits.length) return null;
  const msg = { title: 'MyDay', body: `A quick heads-up when you have a minute: ${bits.join(', ')}. You've got this.` };
  assertGentle(`${msg.title} ${msg.body}`);
  return msg;
}

/** Send to all of a member's devices. Returns how many accepted it. */
export async function sendTo(memberId: number, msg: { title: string; body: string; url?: string }): Promise<{ delivered: number; stub: boolean }> {
  assertGentle(`${msg.title} ${msg.body}`);
  const { rows } = await pool.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_id = $1',
    [memberId],
  );
  if (!realPush()) return { delivered: stubbed() ? rows.length : 0, stub: true };
  let delivered = 0;
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...msg, url: msg.url ?? '/' }), { TTL: 6 * 3600 });
      delivered++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
      else console.error('push failed', code ?? (e instanceof Error ? e.message : e));
    }
  }
  return { delivered, stub: false };
}

/** Is today one of this person's nudge days, and is it time? */
export function dueNow(p: Prefs, hhmm: string, t: DateStr): boolean {
  if (!p.enabled) return false;
  const wd = isoWeekday(t);
  if (p.frequency === 'weekdays' && wd > 5) return false;
  if (p.frequency === 'weekly' && wd !== 7) return false;
  if (hhmm < p.send_at) return false;
  return !inQuietHours(hhmm, p.quiet_start, p.quiet_end);
}

/** One pass of the scheduler: everyone due gets at most one batched nudge today. */
export async function runDigests(now: Date = new Date()): Promise<number> {
  if (!pushConfigured()) return 0;
  const hhmm = localTime(now);
  const t = today(now);
  const { rows } = await asSystem(() =>
    pool.query<Prefs & { member_id: number; household_id: number; kind: 'kid' | 'adult' }>(
      `SELECT p.*, m.kind FROM notification_prefs p JOIN household_members m ON m.id = p.member_id
        WHERE p.enabled AND m.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM notification_log l WHERE l.member_id = p.member_id AND l.day = $1)
          AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.member_id = p.member_id)`,
      [t],
    ),
  );
  let sent = 0;
  for (const p of rows) {
    if (!dueNow(p, hhmm, t)) continue;
    await inHousehold(p.household_id, async () => {
      const msg = await digestFor(p.member_id, p.kind, p);
      if (!msg) return;
      // Claim the day first so two servers can't both send.
      const claim = await pool.query(
        'INSERT INTO notification_log (member_id, day, title, body) VALUES ($1, $2, $3, $4) ON CONFLICT (member_id, day) DO NOTHING',
        [p.member_id, t, msg.title, msg.body],
      );
      if (!claim.rowCount) return;
      const r = await sendTo(p.member_id, msg);
      await pool.query('UPDATE notification_log SET delivered = $3, stubbed = $4 WHERE member_id = $1 AND day = $2', [p.member_id, t, r.delivered, r.stub]);
      await logEvent('notification_sent', { delivered: r.delivered, stub: r.stub }, p.member_id);
      sent++;
    });
  }
  return sent;
}
