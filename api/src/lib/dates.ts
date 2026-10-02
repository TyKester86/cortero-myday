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
