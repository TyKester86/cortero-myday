/** Repeating household-calendar events: which days they fall on. */
import type { CalRepeat, DateStr } from '@myday/shared';
import { addDays } from './dates.js';

export interface Recurring {
  starts_on: string;
  repeat: CalRepeat;
  repeat_until: string | null;
}

const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/** Every date in [from, to] an event falls on. Monthly on the 31st skips short months; Feb 29 only in leap years. */
export function datesOf(e: Recurring, from: DateStr, to: DateStr): DateStr[] {
  const start = e.starts_on;
  const end = e.repeat_until && e.repeat_until < to ? e.repeat_until : to;
  if (end < start || end < from) return [];
  if (e.repeat === 'none') return start >= from && start <= to ? [start] : [];
  const out: DateStr[] = [];
  if (e.repeat === 'daily' || e.repeat === 'weekly') {
    const step = e.repeat === 'daily' ? 1 : 7;
    let d = start;
    if (d < from) {
      const gap = Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
      d = addDays(start, Math.ceil(gap / step) * step);
    }
    for (; d <= end && out.length < 1000; d = addDays(d, step)) out.push(d);
    return out;
  }
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  for (let i = 0; i < 1200 && out.length < 1000; i++) {
    const y = e.repeat === 'yearly' ? sy + i : sy + Math.floor((sm - 1 + i) / 12);
    const m = e.repeat === 'yearly' ? sm : ((sm - 1 + i) % 12) + 1;
    if (sd > daysIn(y, m)) continue;
    const d = `${y}-${String(m).padStart(2, '0')}-${String(sd).padStart(2, '0')}`;
    if (d > end) break;
    if (d >= from) out.push(d);
  }
  return out;
}
