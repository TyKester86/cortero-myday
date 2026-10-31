/**
 * C2: connected calendars, read-only. A person's outside calendar (Google, Outlook, Apple, a school's
 * published calendar) is subscribed by its private iCal address and read into calendar_source_events
 * for the family timeline — sources stay separate and labeled, nothing is ever written back.
 *
 * The reader handles what real feeds send: folded lines, all-day and timed events, TZID times
 * (IANA, and the Windows zone names Outlook uses), UTC times, RRULE repeats (daily / weekly /
 * monthly / yearly with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE, moved or cancelled
 * single occurrences (RECURRENCE-ID), and cancelled events. Times land in the household's zone.
 */
import type { DateStr } from '@myday/shared';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { addDays, today } from './dates.js';
import { HttpError } from './http.js';
import { publicUrl } from './robot.js';
import { openText } from './seal.js';

export const SYNC_PAST_DAYS = 7;
export const SYNC_AHEAD_DAYS = 60;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EVENTS = 3000;

export interface FeedEvent {
  uid: string;
  date: DateStr;
  start: string | null; // HH:MM, household time; null = all day
  end: string | null;
  title: string;
  location: string;
}

/* ---------- time zones ---------- */

// The Windows names Outlook and Exchange put in TZID, for the zones a US family is likely to hit.
const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  UTC: 'UTC',
};

function zoneOf(tzid: string | undefined): string {
  if (!tzid) return config.tz;
  const t = tzid.replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, ''); // "/mozilla.org/20050126_1/America/New_York"
  const z = WINDOWS_TZ[t] ?? t;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return config.tz;
  }
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetAt(zone: string, ms: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ms) / 60_000;
}

/** A wall-clock time in a zone → the instant. */
function instant(y: number, mo: number, d: number, h: number, mi: number, zone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(zone, guess) * 60_000;
  return guess - offsetAt(zone, first) * 60_000;
}

const LOCAL = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function household(ms: number): { date: DateStr; time: string } {
  const p = LOCAL.formatToParts(new Date(ms));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '00';
  return { date: `${g('year')}-${g('month')}-${g('day')}` as DateStr, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}

/* ---------- parsing ---------- */

interface Prop {
  params: Record<string, string>;
  value: string;
}
type VEvent = Map<string, Prop[]>;

const unescape = (v: string): string => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').replace(/\s+/g, ' ').trim();

function components(text: string): VEvent[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: VEvent[] = [];
  let cur: VEvent | null = null;
  let depth = 0; // VALARM inside a VEVENT
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = new Map();
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('BEGIN:')) depth++;
    else if (line.startsWith('END:') && depth > 0) depth--;
    else if (line === 'END:VEVENT') {
      out.push(cur);
      cur = null;
      if (out.length > MAX_EVENTS) break;
    } else if (depth === 0) {
      const colon = line.indexOf(':');
      if (colon < 1) continue;
      const [name, ...ps] = line.slice(0, colon).split(';');
      const params: Record<string, string> = {};
      for (const p of ps) {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
      }
      const key = (name ?? '').toUpperCase();
      cur.set(key, [...(cur.get(key) ?? []), { params, value: line.slice(colon + 1) }]);
    }
  }
  return out;
}

/** A DTSTART-style value: all day (a date), or a wall time in a zone. */
interface Stamp {
  allDay: boolean;
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  zone: string;
}
function stamp(p: Prop | undefined): Stamp | null {
  if (!p) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) return null;
  const allDay = p.params.VALUE === 'DATE' || !m[4];
  return { allDay, y: +m[1]!, mo: +m[2]!, d: +m[3]!, h: allDay ? 0 : +m[4]!, mi: allDay ? 0 : +m[5]!, zone: m[7] ? 'UTC' : zoneOf(p.params.TZID) };
}
const stampMs = (s: Stamp): number => (s.allDay ? Date.UTC(s.y, s.mo - 1, s.d) : instant(s.y, s.mo, s.d, s.h, s.mi, s.zone));
const dayOf = (s: Stamp): DateStr => `${s.y}-${String(s.mo).padStart(2, '0')}-${String(s.d).padStart(2, '0')}` as DateStr;

function durationMs(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const n = (i: number): number => Number(m[i] ?? 0);
  return (m[1] === '-' ? -1 : 1) * ((n(2) * 7 + n(3)) * 86_400_000 + n(4) * 3_600_000 + n(5) * 60_000 + n(6) * 1000);
}

/* ---------- repeats ---------- */

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Start stamps of every occurrence (in the event's own zone) up to a horizon. */
function starts(first: Stamp, rrule: string | undefined, horizonMs: number): Stamp[] {
  if (!rrule) return [first];
  const r = Object.fromEntries(rrule.split(';').map((kv) => kv.split('=') as [string, string]).map(([k, v]) => [k.toUpperCase(), v ?? '']));
  const freq = r.FREQ;
  const interval = Math.max(1, Number(r.INTERVAL) || 1);
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? stamp({ params: {}, value: r.UNTIL }) : null;
  const untilMs = until ? (until.allDay ? Date.UTC(until.y, until.mo - 1, until.d, 23, 59) : stampMs(until)) : Infinity;
  const byDay = r.BYDAY ? r.BYDAY.split(',').map((x) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x)).filter((x): x is RegExpExecArray => !!x) : [];
  const byMonthDay = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number).filter(Boolean) : [];
  const out: Stamp[] = [];
  const at = (y: number, mo: number, d: number): Stamp => ({ ...first, y, mo, d });
  const push = (s: Stamp): boolean => {
    const ms = stampMs(s);
    if (ms < stampMs(first)) return true;
    if (ms > untilMs || ms > horizonMs || out.length >= count) return false;
    out.push(s);
    return true;
  };
  const date = (y: number, mo: number, d: number): Date => new Date(Date.UTC(y, mo - 1, d));
  if (freq === 'DAILY' || freq === 'WEEKLY') {
    const days = freq === 'WEEKLY' && byDay.length ? byDay.map((b) => WD.indexOf(b[2]!)) : null;
    // Walk week by week (or day by day) from the first occurrence's week.
    const step = freq === 'DAILY' ? interval : 7 * interval;
    const base = date(first.y, first.mo, first.d);
    const weekStart = days ? new Date(base.getTime() - base.getUTCDay() * 86_400_000) : base;
    for (let i = 0; i < 2000; i++) {
      const block = new Date(weekStart.getTime() + i * step * 86_400_000);
      const list = days ? [...days].sort((a, b) => a - b).map((wd) => new Date(block.getTime() + wd * 86_400_000)) : [block];
      for (const dt of list) if (!push(at(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()))) return out;
    }
    return out;
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    for (let i = 0; i < 400; i++) {
      const months = freq === 'MONTHLY' ? i * interval : i * 12 * interval;
      const y = first.y + Math.floor((first.mo - 1 + months) / 12);
      const mo = ((first.mo - 1 + months) % 12) + 1;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      let ds: number[];
      if (byDay.length) {
        ds = [];
        for (const b of byDay) {
          const wd = WD.indexOf(b[2]!);
          const all = Array.from({ length: last }, (_, k) => k + 1).filter((d) => date(y, mo, d).getUTCDay() === wd);
          const n = b[1] ? Number(b[1]) : 0;
          if (!n) ds.push(...all);
          else {
            const pick = n > 0 ? all[n - 1] : all[all.length + n];
            if (pick) ds.push(pick);
          }
        }
      } else if (byMonthDay.length) ds = byMonthDay.map((d) => (d < 0 ? last + d + 1 : d)).filter((d) => d >= 1 && d <= last);
      else ds = first.d <= last ? [first.d] : [];
      for (const d of ds.sort((a, b) => a - b)) if (!push(at(y, mo, d))) return out;
    }
    return out;
  }
  return [first];
}

/** Read an ICS document into occurrences between two days, in household time. */
export function readIcs(text: string, from: DateStr, to: DateStr): FeedEvent[] {
  const fromMs = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10)) - 86_400_000;
  const horizon = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) + 2 * 86_400_000;
  const all = components(text);
  // Moved or cancelled single occurrences, by UID + the original start.
  const overrides = new Map<string, VEvent>();
  for (const e of all) {
    const rid = stamp(e.get('RECURRENCE-ID')?.[0]);
    const uid = e.get('UID')?.[0]?.value;
    if (rid && uid) overrides.set(`${uid}|${stampMs(rid)}`, e);
  }
  const out: FeedEvent[] = [];
  const emit = (e: VEvent, s: Stamp, uid: string): void => {
    if ((e.get('STATUS')?.[0]?.value ?? '').toUpperCase() === 'CANCELLED') return;
    const title = unescape(e.get('SUMMARY')?.[0]?.value ?? '') || 'Busy';
    const location = unescape(e.get('LOCATION')?.[0]?.value ?? '');
    const own = stamp(e.get('DTSTART')?.[0]);
    const end = stamp(e.get('DTEND')?.[0]);
    const dur = e.get('DURATION')?.[0]?.value;
    const lenMs = own && end ? stampMs(end) - stampMs(own) : dur ? durationMs(dur) : s.allDay ? 86_400_000 : 0;
    if (s.allDay) {
      const days = Math.max(1, Math.round(lenMs / 86_400_000));
      for (let k = 0; k < Math.min(days, 31); k++) {
        const date = addDays(dayOf(s), k) as DateStr;
        if (date >= from && date <= to) out.push({ uid, date, start: null, end: null, title, location });
      }
      return;
    }
    const startMs = stampMs(s);
    const a = household(startMs);
    if (a.date < from || a.date > to) return;
    const b = lenMs > 0 ? household(startMs + lenMs) : null;
    // Past midnight: it ends with the day, for the timeline's purposes.
    out.push({ uid, date: a.date, start: a.time, end: b ? (b.date === a.date ? b.time : '23:59') : null, title, location });
  };
  for (const e of all) {
    if (e.get('RECURRENCE-ID')) continue;
    const first = stamp(e.get('DTSTART')?.[0]);
    const uid = e.get('UID')?.[0]?.value ?? `${dayOf(first ?? { y: 0, mo: 0, d: 0 } as Stamp)}-${out.length}`;
    if (!first) continue;
    const ex = new Set((e.get('EXDATE') ?? []).flatMap((p) => p.value.split(',').map((v) => stamp({ params: p.params, value: v }))).filter((x): x is Stamp => !!x).map(stampMs));
    for (const s of starts(first, e.get('RRULE')?.[0]?.value, horizon)) {
      const ms = stampMs(s);
      if (ms < fromMs - 31 * 86_400_000 || ex.has(ms)) continue;
      const moved = overrides.get(`${uid}|${ms}`);
      if (moved) {
        const ms2 = stamp(moved.get('DTSTART')?.[0]);
        if (ms2) emit(moved, ms2, uid);
      } else emit(e, s, uid);
      if (out.length > MAX_EVENTS) return out;
    }
  }
  // Overrides whose series started before the window still land on their own.
  return out.sort((x, y) => x.date.localeCompare(y.date) || (x.start ?? '').localeCompare(y.start ?? ''));
}

/* ---------- fetching and syncing ---------- */

/** webcal:// is what Google, Apple and Outlook hand out; it's https underneath. */
export function normalizeFeedUrl(raw: string): string {
  const t = raw.trim().replace(/^webcals?:\/\//i, 'https://');
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new HttpError(400, 'That isn’t a calendar address — paste the private iCal (.ics) link');
  }
  if (u.username || u.password) throw new HttpError(400, 'A calendar address with a login in it can’t be used');
  return u.toString();
}

/** What the screen shows instead of the secret address. */
export const urlHint = (url: string): string => {
  const u = new URL(url);
  return `${u.hostname}/…${u.pathname.slice(-6)}`;
};

async function fetchIcs(url: string): Promise<string> {
  let at = url;
  for (let hop = 0; hop < 3; hop++) {
    if (!(await publicUrl(at))) throw new HttpError(400, 'That calendar address isn’t on the public internet');
    const res = await fetch(at, { redirect: 'manual', headers: { Accept: 'text/calendar, */*' }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      at = new URL(res.headers.get('location') as string, at).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new HttpError(400, 'The calendar said no — the link may have been reset. Copy a fresh private link.');
    if (!res.ok) throw new HttpError(502, `The calendar didn’t answer (${res.status}) — trying again later`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new HttpError(400, 'That calendar is too big to read');
    const text = buf.toString('utf8');
    if (!text.includes('BEGIN:VCALENDAR')) throw new HttpError(400, 'That link isn’t a calendar (.ics) — use the private iCal address');
    return text;
  }
  throw new HttpError(400, 'That calendar address redirects too many times');
}

interface SourceRow {
  id: number;
  url_enc: Buffer;
  key_id: string;
}

/** Read one source now (inside its household's scope). Errors are kept on the source, plainly. */
export async function syncSource(id: number): Promise<{ events: number; error: string | null }> {
  const { rows } = await pool.query<SourceRow>('SELECT id, url_enc, key_id FROM calendar_sources WHERE id = $1', [id]);
  const s = rows[0];
  if (!s) throw new HttpError(404, 'Not found');
  const from = addDays(today(), -SYNC_PAST_DAYS) as DateStr;
  const to = addDays(today(), SYNC_AHEAD_DAYS) as DateStr;
  try {
    const events = readIcs(await fetchIcs(openText(s.url_enc, s.key_id)), from, to).slice(0, MAX_EVENTS);
    await tx(async (client) => {
      await client.query('DELETE FROM calendar_source_events WHERE source_id = $1', [id]);
      for (let i = 0; i < events.length; i += 200) {
        const chunk = events.slice(i, i + 200);
        const vals: unknown[] = [];
        const ph = chunk.map((e, k) => {
          vals.push(id, e.uid.slice(0, 300), e.date, e.start, e.end, e.title.slice(0, 200), e.location.slice(0, 200));
          const b = k * 7;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
        });
        await client.query(`INSERT INTO calendar_source_events (source_id, uid, starts_on, start_time, end_time, title, location) VALUES ${ph.join(', ')}`, vals);
      }
      await client.query('UPDATE calendar_sources SET last_synced_at = $3, last_error = NULL, event_count = $2 WHERE id = $1', [id, events.length, new Date()]);
    });
    return { events: events.length, error: null };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : 'Couldn’t read that calendar — trying again later';
    await pool.query('UPDATE calendar_sources SET last_error = $2 WHERE id = $1', [id, msg]);
    return { events: 0, error: msg };
  }
}
