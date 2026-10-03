import { WEEKDAYS, type DateStr, type Weekday } from '@myday/shared';
import { config } from '../config.js';

const DAY_MS = 86_400_000;

/** Today in the household time zone (the old script's todayInfo()). */
export function today(now: Date = new Date()): DateStr {
  // en-CA formats as yyyy-MM-dd.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function utc(d: DateStr): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function fmt(ms: number): DateStr {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(d: DateStr, n: number): DateStr {
  return fmt(utc(d) + n * DAY_MS);
}

/** ISO weekday: 1 = Mon .. 7 = Sun. */
export function isoWeekday(d: DateStr): number {
  const js = new Date(utc(d)).getUTCDay();
  return js === 0 ? 7 : js;
}

export function weekdayName(d: DateStr): Weekday {
  return isoToWeekday(isoWeekday(d));
}

export function isoToWeekday(n: number): Weekday {
  const w = WEEKDAYS[n - 1];
  if (!w) throw new Error(`bad ISO weekday ${n}`);
  return w;
}

export function weekdayToIso(w: Weekday): number {
  return WEEKDAYS.indexOf(w) + 1;
}

/** Monday of the week containing d (the old weekStart_()). */
export function weekStart(d: DateStr): DateStr {
  return addDays(d, -(isoWeekday(d) - 1));
}

export function daysBetween(a: DateStr, b: DateStr): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/** Minutes the household time zone is ahead of UTC at an instant (e.g. -300 for CDT). */
function tzOffsetMinutes(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** A household-local day + "HH:MM" as a real instant (handles daylight saving). */
export function localToInstant(d: DateStr, hhmm: string): Date {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, dd, h, mi);
  let guess = naive - tzOffsetMinutes(new Date(naive)) * 60_000;
  guess = naive - tzOffsetMinutes(new Date(guess)) * 60_000;
  return new Date(guess);
}
