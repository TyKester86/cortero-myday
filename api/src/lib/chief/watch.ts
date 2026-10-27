/**
 * H5 — the household logistics watch: exceptions over the toolbelt's data.
 *
 *  - schedule conflicts (today and tomorrow), in plain words;
 *  - a pickup or handoff with nobody on it (today's is a same-day failure);
 *  - a bill coming due while the linked balance is low (parent-set threshold);
 *  - homework at real risk (start-by passed, no progress) — the coach's escalation;
 *  - forms and supplies/prescriptions: watched only when the family has entered that
 *    data — MyDay doesn't capture it yet, so there is nothing to watch.
 *  - crisis signals in content she processes (calendar text, homework text) escalate
 *    to both parents through the same path as everywhere else.
 *
 * Thresholds and quiet hours are parent-set (both parents are admins; either can
 * quiet her). Default quiet hours: school nights. Only a same-day logistics failure
 * may break quiet hours. Read-only toward the family's data: it writes only Hana's
 * own log (hana_items, hana_settings).
 */
import type { HanaSettings, HanaWatchCategory, HouseholdMember } from '@myday/shared';
import { config } from '../../config.js';
import { pool } from '../../db.js';
import { addDays, today } from '../dates.js';
import { logEvent } from '../events.js';
import { HttpError } from '../http.js';
import { listMembers } from '../members.js';
import { CopyPolicyError, sendTo } from '../push.js';
import { conflictsOn } from './brief.js';
import { refreshEscalations } from './coach.js';
import { asOfLabel, SOURCE } from './facts.js';
import { crisisIn, escalateCrisis } from './guard.js';
import { requireParent, viewerOf, type Viewer } from './scope.js';
import { balances, billsDue, scheduleFor, type ScheduleItem } from './tools.js';

export const WATCH_CATEGORIES: HanaWatchCategory[] = ['pickup', 'conflict', 'bills', 'homework'];

const DEFAULTS: HanaSettings = { quietStart: '21:00', quietEnd: '07:00', quietDays: [7, 1, 2, 3, 4], pausedUntil: null, muted: [], lowBalance: 200, billLeadDays: 3 };

interface SettingsRow {
  quiet_start: string;
  quiet_end: string;
  quiet_days: number[];
  paused_until: Date | null;
  muted: string[];
  low_balance: string;
  bill_lead_days: number;
}

export async function settingsOf(): Promise<HanaSettings> {
  const { rows } = await pool.query<SettingsRow>('SELECT quiet_start, quiet_end, quiet_days, paused_until, muted, low_balance, bill_lead_days FROM hana_settings LIMIT 1');
  const r = rows[0];
  if (!r) return { ...DEFAULTS };
  return {
    quietStart: r.quiet_start,
    quietEnd: r.quiet_end,
    quietDays: r.quiet_days,
    pausedUntil: r.paused_until?.toISOString() ?? null,
    muted: r.muted.filter((m): m is HanaWatchCategory => (WATCH_CATEGORIES as string[]).includes(m)),
    lowBalance: Number(r.low_balance),
    billLeadDays: r.bill_lead_days,
  };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Either parent changes the thresholds or quiets her. */
export async function saveSettings(v: Viewer, b: Record<string, unknown>): Promise<HanaSettings> {
  requireParent(v, 'Hana’s settings');
  const cur = await settingsOf();
  const next: HanaSettings = { ...cur };
  if (b.quietStart !== undefined) {
    if (typeof b.quietStart !== 'string' || !HHMM.test(b.quietStart)) throw new HttpError(400, 'Quiet hours start is HH:MM');
    next.quietStart = b.quietStart;
  }
  if (b.quietEnd !== undefined) {
    if (typeof b.quietEnd !== 'string' || !HHMM.test(b.quietEnd)) throw new HttpError(400, 'Quiet hours end is HH:MM');
    next.quietEnd = b.quietEnd;
  }
  if (b.quietDays !== undefined) {
    if (!Array.isArray(b.quietDays) || b.quietDays.some((d) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)) throw new HttpError(400, 'Quiet nights are weekdays 1–7');
    next.quietDays = [...new Set(b.quietDays as number[])].sort((x, y) => x - y);
  }
  if (b.muted !== undefined) {
    if (!Array.isArray(b.muted) || b.muted.some((m) => !(WATCH_CATEGORIES as unknown[]).includes(m))) throw new HttpError(400, `Categories are ${WATCH_CATEGORIES.join(', ')}`);
    next.muted = [...new Set(b.muted as HanaWatchCategory[])];
  }
  if (b.lowBalance !== undefined) {
    const n = Number(b.lowBalance);
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new HttpError(400, 'Low balance is an amount');
    next.lowBalance = Math.round(n * 100) / 100;
  }
  if (b.billLeadDays !== undefined) {
    const n = Number(b.billLeadDays);
    if (!Number.isInteger(n) || n < 0 || n > 7) throw new HttpError(400, 'Bill heads-up is 0–7 days');
    next.billLeadDays = n;
  }
  if (b.pauseHours !== undefined) {
    const h = Number(b.pauseHours);
    if (!Number.isFinite(h) || h < 0 || h > 24 * 14) throw new HttpError(400, 'Quiet her for up to 14 days');
    next.pausedUntil = h === 0 ? null : new Date(Date.now() + h * 3_600_000).toISOString();
  }
  await pool.query(
    `INSERT INTO hana_settings (quiet_start, quiet_end, quiet_days, paused_until, muted, low_balance, bill_lead_days, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (household_id) DO UPDATE SET quiet_start = EXCLUDED.quiet_start, quiet_end = EXCLUDED.quiet_end, quiet_days = EXCLUDED.quiet_days,
       paused_until = EXCLUDED.paused_until, muted = EXCLUDED.muted, low_balance = EXCLUDED.low_balance,
       bill_lead_days = EXCLUDED.bill_lead_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [next.quietStart, next.quietEnd, next.quietDays, next.pausedUntil, next.muted, next.lowBalance, next.billLeadDays, v.me.id],
  );
  return next;
}

/** Local HH:MM and ISO weekday at a moment, in the household's time zone. */
function localAt(at: Date): { hhmm: string; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(at);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { hhmm: `${hour}:${get('minute')}`, dow };
}

/** In quiet hours: the evening's weekday is a quiet night (school nights by default) and the clock is inside the window. */
export function quietAt(s: HanaSettings, at: Date): boolean {
  const { hhmm, dow } = localAt(at);
  if (s.quietStart > s.quietEnd) {
    if (hhmm >= s.quietStart) return s.quietDays.includes(dow);
    if (hhmm < s.quietEnd) return s.quietDays.includes(dow === 1 ? 7 : dow - 1);
    return false;
  }
  return hhmm >= s.quietStart && hhmm < s.quietEnd && s.quietDays.includes(dow);
}

interface Finding {
  key: string;
  category: HanaWatchCategory;
  text: string;
  /** A same-day logistics failure: may break quiet hours. */
  sameDay: boolean;
  /** Who it's for (default: every parent). */
  to?: number[];
  subjectId: number | null;
  source: string;
  asOf: string;
}

const clock = (t: string | null): string => {
  if (!t) return 'all day';
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

export interface WatchRun {
  found: number;
  pushed: number;
  held: number;
  quiet: boolean;
  paused: boolean;
}

/** One pass over the household (inside its scope). */
export async function runWatch(at: Date = new Date()): Promise<WatchRun> {
  const members = await listMembers();
  const parents = members.filter((m) => m.kind === 'adult');
  if (!parents.length) return { found: 0, pushed: 0, held: 0, quiet: false, paused: false };
  const s = await settingsOf();
  const t = today();
  const v = viewerOf(parents[0] as HouseholdMember);
  const findings: Finding[] = [];

  // Pickups and conflicts, today and tomorrow.
  const sched = await scheduleFor(v, t, addDays(t, 1));
  for (const d of [t, addDays(t, 1)]) {
    const day = sched.data.filter((e) => e.date === d);
    for (const e of day.filter((x) => x.pickup && !x.pickupBy)) {
      findings.push({
        key: `pickup:${e.eventId}:${d}`,
        category: 'pickup',
        text: d === t ? `Nobody is on the pickup for ${e.title} at ${clock(e.time)} today.` : `Nobody is on the pickup for ${e.title} tomorrow at ${clock(e.time)} yet.`,
        sameDay: d === t,
        subjectId: null,
        source: sched.source,
        asOf: sched.asOf,
      });
    }
    for (const { a, b, who } of conflictsOn(day)) {
      findings.push({
        key: `conflict:${a.eventId}:${b.eventId}:${d}`,
        category: 'conflict',
        text: `${d === t ? 'Today' : 'Tomorrow'} has ${a.title} (${clock(a.time)}) and ${b.title} (${clock(b.time)}) at the same time${who.length ? ` — ${who.join(' and ')} can’t be at both` : ''}. Someone has to pick.`,
        sameDay: false,
        subjectId: null,
        source: sched.source,
        asOf: sched.asOf,
      });
    }
  }

  // A bill coming due while the linked balance is low (each parent's own bills).
  const bal = await balances(v);
  if (bal.data.total !== null) {
    for (const p of parents) {
      const due = await billsDue(viewerOf(p), s.billLeadDays);
      const total = Math.round(due.data.reduce((sum, b) => sum + b.amount, 0) * 100) / 100;
      if (total > 0 && bal.data.total - total < s.lowBalance) {
        findings.push({
          key: `lowbal:${p.id}:${due.data.map((b) => `${b.name}@${b.date}`).join(',')}`,
          category: 'bills',
          text: `${due.data.map((b) => `${b.name} ($${b.amount.toFixed(2)}, ${b.date === t ? 'today' : b.date})`).join(' and ')} ${due.data.length === 1 ? 'is' : 'are'} coming up while the linked balance is $${bal.data.total.toFixed(2)} (as of ${asOfLabel(bal.asOf)}${bal.stale ? `; ${bal.stale}` : ''}).`,
          sameDay: false,
          to: [p.id],
          subjectId: null,
          source: SOURCE.bank,
          asOf: bal.asOf,
        });
      }
    }
  }

  // Crisis signals in the content she reads (calendar and homework text): never alone, never silently.
  await crisisScan(members, sched.data);

  // Homework at real risk: the coach's escalation (once per assignment), delivered like any watch item.
  const escalated = new Set((await refreshEscalations()).map((e) => e.key));

  const paused = !!s.pausedUntil && Date.parse(s.pausedUntil) > at.getTime();
  const quiet = paused || quietAt(s, at);
  let pushed = 0;
  let held = 0;
  const day = t;
  for (const f of findings) {
    if (s.muted.includes(f.category)) continue;
    for (const pid of f.to ?? parents.map((p) => p.id)) {
      const { rows } = await pool.query<{ id: number; pushed_at: Date | null }>(
        `INSERT INTO hana_items (member_id, surface, category, item_key, subject_member_id, text, source, as_of, shown_on)
         VALUES ($1, 'watch', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (member_id, surface, item_key, shown_on) DO UPDATE SET text = EXCLUDED.text, as_of = EXCLUDED.as_of
         RETURNING id, pushed_at`,
        [pid, f.category, f.key, f.subjectId, f.text, f.source, f.asOf, day],
      );
      const row = rows[0];
      if (!row || row.pushed_at) continue;
      if (quiet && !f.sameDay) {
        held++;
        continue;
      }
      if (await push(pid, f.text)) {
        await pool.query('UPDATE hana_items SET pushed_at = now() WHERE id = $1', [row.id]);
        pushed++;
      }
    }
  }
  // Escalations: pushed once, respecting quiet hours and the homework mute.
  if (!s.muted.includes('homework')) {
    const { rows } = await pool.query<{ id: number; member_id: number; text: string; item_key: string }>(
      "SELECT id, member_id, text, item_key FROM hana_items WHERE surface = 'escalation' AND pushed_at IS NULL AND outcome IS NULL AND shown_on >= $1",
      [addDays(t, -1)],
    );
    for (const r of rows) {
      if (quiet) {
        held++;
        continue;
      }
      if (await push(r.member_id, r.text)) {
        await pool.query('UPDATE hana_items SET pushed_at = now() WHERE id = $1', [r.id]);
        pushed++;
      }
    }
  }
  await logEvent('hana_watch_sent', { found: findings.length + escalated.size, pushed, held, quiet }, null);
  return { found: findings.length, pushed, held, quiet, paused };
}

async function push(memberId: number, text: string): Promise<boolean> {
  try {
    const r = await sendTo(memberId, { title: 'Hana: heads up', body: text, url: '/hq' });
    return r.delivered > 0 || r.stub;
  } catch (e) {
    if (e instanceof CopyPolicyError) {
      const r = await sendTo(memberId, { title: 'Hana: heads up', body: 'Something on the family board needs someone — tap to see it.', url: '/hq' });
      return r.delivered > 0 || r.stub;
    }
    throw e;
  }
}

async function crisisScan(members: HouseholdMember[], events: ScheduleItem[]): Promise<void> {
  const byName = new Map(members.map((m) => [m.name, m]));
  const fallback = members.find((m) => m.kind === 'adult');
  for (const e of events) {
    const { rows } = await pool.query<{ notes: string }>('SELECT notes FROM calendar_events WHERE id = $1', [e.eventId]);
    if (crisisIn(`${e.title} ${rows[0]?.notes ?? ''}`)) {
      const about = byName.get(e.people[0] ?? '') ?? fallback;
      if (about) await escalateCrisis(about, 'calendar', `calendar:${e.eventId}`);
    }
  }
  const { rows: hw } = await pool.query<{ id: number; member_id: number; assignment: string }>('SELECT id, member_id, assignment FROM homework WHERE NOT done');
  for (const h of hw) {
    if (!crisisIn(h.assignment)) continue;
    const about = members.find((m) => m.id === h.member_id) ?? fallback;
    if (about) await escalateCrisis(about, 'homework', `homework:${h.id}`);
  }
}
