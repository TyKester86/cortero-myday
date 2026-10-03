/**
 * The household calendar (migrations/022_calendar.sql).
 *
 *   - Everyone in the household sees it; kids don't see "grown-ups only" events.
 *   - Grown-ups add, edit and delete events (who it's for, repeats, reminders).
 *   - A private subscription link (.ics) puts it in Google, Apple or Outlook
 *     calendar, read-only there. Only a hash of the link's secret is stored;
 *     a new link replaces the old one.
 *   - Timed events can send a push reminder N minutes before.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request } from 'express';
import {
  CAL_REPEATS,
  type CalRepeat,
  type CalendarEvent,
  type CalendarEventFields,
  type CalendarFeedLink,
  type CalendarOccurrence,
  type CalendarResponse,
  type DateStr,
  type HouseholdMember,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { datesOf } from '../lib/recur.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { listMembers, requireAdult, self } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { CopyPolicyError, localTime, pushConfigured, sendTo } from '../lib/push.js';
import { registerJob } from '../lib/schedulers.js';

export const calendarRouter = Router();
/** The .ics subscription feed: public (the secret is in the URL), outside /api. */
export const calendarFeedRouter = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_RANGE_DAYS = 400;

interface EventRow {
  id: number;
  title: string;
  notes: string;
  location: string;
  starts_on: string;
  start_time: string | null;
  end_time: string | null;
  repeat: CalRepeat;
  repeat_until: string | null;
  adults_only: boolean;
  remind_minutes: number | null;
  people: number[] | null;
  updated_at: Date;
}

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

async function eventRows(id: number | null = null): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>(
    `SELECT e.id, e.title, e.notes, e.location, e.starts_on::text AS starts_on, e.start_time::text AS start_time, e.end_time::text AS end_time,
            e.repeat, e.repeat_until::text AS repeat_until, e.adults_only, e.remind_minutes, e.updated_at,
            (SELECT array_agg(p.member_id ORDER BY p.member_id) FROM calendar_event_people p WHERE p.event_id = e.id) AS people
       FROM calendar_events e WHERE ($1::int IS NULL OR e.id = $1) ORDER BY e.starts_on, e.start_time NULLS FIRST, e.id`,
    [id],
  );
  return rows;
}

const toEvent = (r: EventRow): CalendarEvent => ({
  id: r.id,
  title: r.title,
  notes: r.notes,
  location: r.location,
  startsOn: r.starts_on,
  startTime: hhmm(r.start_time),
  endTime: hhmm(r.end_time),
  repeat: r.repeat,
  repeatUntil: r.repeat_until,
  adultsOnly: r.adults_only,
  remindMinutes: r.remind_minutes,
  people: r.people ?? [],
});

/* ---------- repeats: lib/recur.ts ---------- */

async function occurrences(from: DateStr, to: DateStr, kidView: boolean, members: HouseholdMember[]): Promise<CalendarOccurrence[]> {
  const byId = new Map(members.map((m) => [m.id, m]));
  const out: CalendarOccurrence[] = [];
  for (const r of await eventRows()) {
    if (kidView && r.adults_only) continue;
    const people = (r.people ?? []).map((id) => byId.get(id)).filter((m): m is HouseholdMember => !!m).map((m) => ({ id: m.id, name: m.name }));
    for (const date of datesOf(r, from, to)) {
      out.push({
        eventId: r.id,
        date,
        title: r.title,
        startTime: hhmm(r.start_time),
        endTime: hhmm(r.end_time),
        location: r.location,
        notes: r.notes,
        repeat: r.repeat,
        adultsOnly: r.adults_only,
        people,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? '').localeCompare(b.startTime ?? '') || a.eventId - b.eventId);
}

/* ---------- read ---------- */

function range(req: Request): { from: DateStr; to: DateStr } {
  const from = typeof req.query.from === 'string' && DATE.test(req.query.from) ? req.query.from : today();
  let to = typeof req.query.to === 'string' && DATE.test(req.query.to) ? req.query.to : addDays(from, 60);
  if (to < from) throw new HttpError(400, 'to is before from');
  if (to > addDays(from, MAX_RANGE_DAYS)) to = addDays(from, MAX_RANGE_DAYS);
  return { from, to };
}

async function feedState(): Promise<CalendarResponse['feed']> {
  const { rows } = await pool.query<{ created_at: Date }>('SELECT created_at FROM calendar_feeds ORDER BY created_at DESC LIMIT 1');
  return { active: rows.length > 0, createdAt: rows[0]?.created_at.toISOString() ?? null };
}

calendarRouter.get('/api/calendar', async (req, res) => {
  const me = self(req);
  const adult = me.kind === 'adult';
  const { from, to } = range(req);
  const members = await listMembers();
  const out: CalendarResponse = {
    from,
    to,
    occurrences: await occurrences(from, to, !adult, members),
    events: adult ? (await eventRows()).map(toEvent) : [],
    canEdit: adult,
    feed: adult ? await feedState() : null,
  };
  res.json(out);
});

/* ---------- write (grown-ups) ---------- */

async function fields(req: Request): Promise<CalendarEventFields> {
  const b = req.body as Record<string, unknown>;
  const title = str(b.title, 'title', 120, true);
  const startsOn = str(b.startsOn, 'startsOn', 10, true);
  if (!DATE.test(startsOn) || Number.isNaN(Date.parse(`${startsOn}T00:00:00Z`))) throw new HttpError(400, 'Pick a date');
  const time = (v: unknown, f: string): string | null => {
    const s = str(v, f, 5);
    if (!s) return null;
    if (!TIME.test(s)) throw new HttpError(400, `${f} must be HH:MM`);
    return s;
  };
  const startTime = time(b.startTime, 'startTime');
  const endTime = startTime ? time(b.endTime, 'endTime') : null;
  if (startTime && endTime && endTime <= startTime) throw new HttpError(400, 'The end time is before the start');
  const repeat = CAL_REPEATS.find((r) => r === b.repeat) ?? 'none';
  const until = repeat === 'none' ? '' : str(b.repeatUntil, 'repeatUntil', 10);
  if (until && (!DATE.test(until) || until < startsOn)) throw new HttpError(400, 'Repeat-until must be on or after the first date');
  const remind = b.remindMinutes === null || b.remindMinutes === undefined || b.remindMinutes === '' ? null : Number(b.remindMinutes);
  if (remind !== null && (!Number.isInteger(remind) || remind < 0 || remind > 10080)) throw new HttpError(400, 'Reminder must be 0–10080 minutes');
  const ids = Array.isArray(b.people) ? b.people.map((x) => idParam(x)) : [];
  const members = await listMembers();
  const known = new Set(members.map((m) => m.id));
  if (ids.some((id) => !known.has(id))) throw new HttpError(400, 'Someone in “who” isn’t in this household');
  return {
    title,
    notes: str(b.notes, 'notes', 2000),
    location: str(b.location, 'location', 200),
    startsOn,
    startTime,
    endTime,
    repeat,
    repeatUntil: until || null,
    adultsOnly: b.adultsOnly === true,
    remindMinutes: startTime ? remind : null,
    people: [...new Set(ids)],
  };
}

async function save(f: CalendarEventFields, by: number, id: number | null): Promise<number> {
  const cols = [f.title, f.notes, f.location, f.startsOn, f.startTime, f.endTime, f.repeat, f.repeatUntil, f.adultsOnly, f.remindMinutes];
  let eventId = id;
  if (eventId === null) {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO calendar_events (title, notes, location, starts_on, start_time, end_time, repeat, repeat_until, adults_only, remind_minutes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [...cols, by],
    );
    eventId = rows[0]?.id ?? 0;
  } else {
    const { rowCount } = await pool.query(
      `UPDATE calendar_events SET title=$1, notes=$2, location=$3, starts_on=$4, start_time=$5, end_time=$6, repeat=$7, repeat_until=$8,
              adults_only=$9, remind_minutes=$10, updated_at=now() WHERE id=$11`,
      [...cols, eventId],
    );
    if (!rowCount) throw new HttpError(404, 'No such event');
    await pool.query('DELETE FROM calendar_event_people WHERE event_id = $1', [eventId]);
  }
  for (const m of f.people) await pool.query('INSERT INTO calendar_event_people (event_id, member_id) VALUES ($1, $2)', [eventId, m]);
  return eventId;
}

calendarRouter.post('/api/calendar/events', async (req, res) => {
  const me = requireAdult(req);
  const id = await save(await fields(req), me.id, null);
  res.status(201).json(toEvent((await eventRows(id))[0] as EventRow));
});

calendarRouter.put('/api/calendar/events/:id', async (req, res) => {
  const me = requireAdult(req);
  const id = await save(await fields(req), me.id, idParam(req.params.id));
  res.json(toEvent((await eventRows(id))[0] as EventRow));
});

calendarRouter.delete('/api/calendar/events/:id', async (req, res) => {
  requireAdult(req);
  const { rowCount } = await pool.query('DELETE FROM calendar_events WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'No such event');
  res.json({ ok: true });
});

/* ---------- the subscription link ---------- */

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

calendarRouter.post('/api/calendar/feed', async (req, res) => {
  const me = requireAdult(req);
  const token = randomBytes(24).toString('base64url');
  await pool.query('DELETE FROM calendar_feeds');
  await pool.query('INSERT INTO calendar_feeds (token_hash, created_by) VALUES ($1, $2)', [hashToken(token), me.id]);
  const out: CalendarFeedLink = { url: `${config.publicUrl}/cal/${token}.ics` };
  res.status(201).json(out);
});

calendarRouter.delete('/api/calendar/feed', async (req, res) => {
  requireAdult(req);
  await pool.query('DELETE FROM calendar_feeds');
  res.json({ ok: true });
});

/** iCalendar text: escape, and fold lines at 75 octets (RFC 5545). */
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur);
      cur = ` ${ch}`;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
const ymd = (d: string): string => d.replace(/-/g, '');
const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function icsFor(events: EventRow[], members: HouseholdMember[], householdName: string): string {
  const byId = new Map(members.map((m) => [m.id, m.name]));
  const tz = config.tz;
  const L: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MyDay//Household calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(`${householdName} (MyDay)`)}`, `X-WR-TIMEZONE:${tz}`];
  for (const e of events) {
    const who = (e.people ?? []).map((id) => byId.get(id)).filter(Boolean).join(', ');
    L.push('BEGIN:VEVENT', `UID:myday-event-${e.id}@conquermyday.app`, `DTSTAMP:${stamp(e.updated_at)}`, `SUMMARY:${esc(e.title)}`);
    if (e.start_time) {
      const st = e.start_time.slice(0, 5).replace(':', '');
      const en = (e.end_time ?? '').slice(0, 5).replace(':', '');
      L.push(`DTSTART;TZID=${tz}:${ymd(e.starts_on)}T${st}00`);
      if (en) L.push(`DTEND;TZID=${tz}:${ymd(e.starts_on)}T${en}00`);
      else L.push('DURATION:PT1H');
    } else {
      L.push(`DTSTART;VALUE=DATE:${ymd(e.starts_on)}`, `DTEND;VALUE=DATE:${ymd(addDays(e.starts_on, 1))}`);
    }
    if (e.repeat !== 'none') {
      const freq = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY' }[e.repeat];
      L.push(`RRULE:FREQ=${freq}${e.repeat_until ? `;UNTIL=${ymd(e.repeat_until)}${e.start_time ? 'T235959Z' : ''}` : ''}`);
    }
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    const desc = [who ? `For: ${who}` : '', e.notes].filter(Boolean).join('\n');
    if (desc) L.push(`DESCRIPTION:${esc(desc)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return `${L.map(fold).join('\r\n')}\r\n`;
}

const feedLimit = rateLimiter(120, 60 * 60_000); // per IP per hour (calendar apps poll; people don't)

calendarFeedRouter.get('/cal/:file', async (req, res) => {
  if (!feedLimit(req.ip ?? 'unknown')) throw new HttpError(429, 'Too many requests');
  const m = /^([A-Za-z0-9_-]{20,64})\.ics$/.exec(String(req.params.file));
  if (!m?.[1]) throw new HttpError(404, 'Not found');
  const hash = hashToken(m[1]);
  const hh = await asSystem(async () => {
    const { rows } = await pool.query<{ household_id: number }>('UPDATE calendar_feeds SET last_used_at = now() WHERE token_hash = $1 RETURNING household_id', [hash]);
    return rows[0]?.household_id ?? null;
  });
  if (hh === null) throw new HttpError(404, 'This calendar link was replaced or turned off');
  const body = await inHousehold(hh, async () => {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM households WHERE id = $1', [hh]);
    return icsFor(await eventRows(), await listMembers(), rows[0]?.name ?? 'Household');
  });
  res
    .set('Content-Type', 'text/calendar; charset=utf-8')
    .set('Cache-Control', 'private, max-age=300')
    .set('Content-Disposition', 'inline; filename="myday.ics"')
    .send(body);
});

/* ---------- reminders ---------- */

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const twelve = (t: string): string => {
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Push a reminder for every timed occurrence starting within its reminder window (once each). */
export async function runCalendarReminders(now: Date = new Date()): Promise<number> {
  if (!pushConfigured()) return 0;
  const t = today(now);
  const nowMin = minutesOf(localTime(now));
  const { rows: hhs } = await asSystem(() => pool.query<{ household_id: number }>('SELECT DISTINCT household_id FROM calendar_events WHERE remind_minutes IS NOT NULL AND start_time IS NOT NULL'));
  let sent = 0;
  for (const { household_id } of hhs) {
    await inHousehold(household_id, async () => {
      const members = await listMembers();
      for (const r of await eventRows()) {
        if (r.remind_minutes === null || !r.start_time) continue;
        for (const date of datesOf(r, t, addDays(t, 7))) {
          const dayOffset = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${t}T00:00:00Z`)) / 86_400_000);
          const until = dayOffset * 1440 + minutesOf(r.start_time) - nowMin;
          if (until < 0 || until > r.remind_minutes) continue;
          const claim = await pool.query('INSERT INTO calendar_reminders_sent (event_id, occurs_on) VALUES ($1, $2) ON CONFLICT DO NOTHING', [r.id, date]);
          if (!claim.rowCount) continue;
          const to = (r.people?.length ? members.filter((m) => r.people?.includes(m.id)) : members).filter((m) => !r.adults_only || m.kind === 'adult');
          const when = dayOffset === 0 ? `at ${twelve(r.start_time)}` : dayOffset === 1 ? `tomorrow at ${twelve(r.start_time)}` : `on ${date} at ${twelve(r.start_time)}`;
          for (const m of to) {
            try {
              await sendTo(m.id, { title: 'Coming up', body: `${r.title} — ${when}`, url: '/calendar' });
            } catch (e) {
              // A title the gentle-copy rules reject: send a neutral version instead.
              if (e instanceof CopyPolicyError) await sendTo(m.id, { title: 'Coming up', body: `Something on the family calendar ${when}`, url: '/calendar' });
              else throw e;
            }
          }
          sent++;
        }
      }
    });
  }
  return sent;
}

/** Dev/test only: run the reminder pass now (optionally "as if" at a given time). */
calendarRouter.post('/api/calendar/run-reminders', async (req, res) => {
  self(req);
  if (process.env.PUSH_STUB !== '1') throw new HttpError(404, 'Not found');
  const at = typeof req.query.at === 'string' && !Number.isNaN(Date.parse(req.query.at)) ? new Date(req.query.at) : new Date();
  res.json({ sent: await asSystem(() => runCalendarReminders(at)) });
});

registerJob({ name: 'calendar-reminders', everyMs: 60 * 1000, run: async () => void (await runCalendarReminders()) });
