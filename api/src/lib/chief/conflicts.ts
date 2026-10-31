/**
 * C2: the conflict engine, on the real timeline (MyDay's calendar + everyone's connected calendars).
 *
 *  - overlap: two things at once that share someone (or one is for everyone);
 *  - pickup: the person on a pickup is somewhere else when it happens;
 *  - travel: back-to-back in two different places with less than the household's travel time
 *    between them (a 4:00 pickup across town from a 3:45 meeting is a conflict even though the
 *    blocks don't touch) — until live traffic is connected, the gap is the parents' setting;
 *  - full day: a child's day with more timed things than the parents' limit.
 *
 * Each finding has words for a parent and (where it's theirs to know) for the child. Someone's
 * busy-only calendar is named as "something on Ty's calendar", never by its title or place.
 */
import type { DateStr } from '@myday/shared';
import type { ScheduleItem } from './tools.js';

export type ConflictKind = 'overlap' | 'pickup' | 'travel' | 'full_day';

export interface Conflict {
  key: string;
  kind: ConflictKind;
  date: DateStr;
  /** For a parent. */
  text: string;
  /** For a child it's about (null: a grown-up matter). */
  kidText: string | null;
  /** The people it's about, by name. */
  who: string[];
}

export interface ConflictOptions {
  /** Minutes to get between two different places. */
  travelMinutes: number;
  /** A child's day is over-full past this many timed things. */
  kidDayLimit: number;
  /** Names of the household's children. */
  kids: string[];
  /** "today", "tomorrow", "Tuesday". */
  dayLabel: (d: DateStr) => string;
}

const mins = (t: string): number => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
const clock = (t: string): string => {
  const m = mins(t);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const endOf = (e: ScheduleItem): number => (e.endTime ? mins(e.endTime) : mins(e.time as string) + 60);
const span = (e: ScheduleItem): string => `${clock(e.time as string)}${e.endTime ? `–${clock(e.endTime)}` : ''}`;
/** How a thing is named: its title, or — on someone's busy-only calendar — just whose it is. */
export const named = (e: ScheduleItem): string => (e.busy ? `something on ${e.people[0] ?? 'someone'}’s calendar` : e.title);
const place = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Two timed things that overlap and share someone (an event for everyone shares with all). */
function overlaps(events: ScheduleItem[]): Array<{ a: ScheduleItem; b: ScheduleItem; who: string[] }> {
  const timed = events.filter((e) => e.time);
  const out: Array<{ a: ScheduleItem; b: ScheduleItem; who: string[] }> = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i] as ScheduleItem;
      const b = timed[j] as ScheduleItem;
      if (a.date !== b.date) continue;
      if (!(mins(a.time as string) < endOf(b) && mins(b.time as string) < endOf(a))) continue;
      // The same thing on two calendars (typed into MyDay and on Google) isn't a conflict.
      if (a.title === b.title && a.time === b.time && !a.busy && !b.busy) continue;
      // The person on a pickup is needed when it happens, not the whole time (the pickup check below).
      const pa = new Set(a.people);
      const pb = new Set(b.people);
      // A family thing (for everyone) against someone's own connected calendar: that person can't be at both.
      const whoAll = !a.people.length && b.from !== a.from ? [...pb] : !b.people.length && a.from !== b.from ? [...pa] : null;
      const everyone = (!a.people.length || !b.people.length) && a.from === b.from;
      const who = whoAll ?? [...pa].filter((p) => pb.has(p));
      if (who.length || (everyone && a.title !== b.title)) out.push({ a, b, who });
    }
  return out;
}

export function findConflicts(events: ScheduleItem[], o: ConflictOptions): Conflict[] {
  const out: Conflict[] = [];
  const days = [...new Set(events.map((e) => e.date))].sort();
  for (const d of days) {
    const day = events.filter((e) => e.date === d && e.time);
    const label = o.dayLabel(d);
    const Label = label.charAt(0).toUpperCase() + label.slice(1);
    const flagged = new Set<string>();
    for (const { a, b, who } of overlaps(day)) {
      flagged.add(`${a.eventId}|${b.eventId}`);
      flagged.add(`${b.eventId}|${a.eventId}`);
      out.push({
        key: `conflict:${a.eventId}:${b.eventId}:${d}`,
        kind: 'overlap',
        date: d,
        text: `${Label} has ${named(a)} (${span(a)}) and ${named(b)} (${span(b)}) at the same time${who.length ? ` — ${who.join(' and ')} can’t be at both` : ''}. Someone has to pick.`,
        kidText: `${a.busy ? 'A grown-up’s plan' : a.title} and ${b.busy ? 'a grown-up’s plan' : b.title} overlap ${label} — a grown-up will help you sort it out.`,
        who,
      });
    }
    // Each person's day in order, with pickups placed where they happen: when the thing ends, at its place.
    const people = new Set(day.flatMap((e) => [...e.people, ...(e.pickupBy ? [e.pickupBy] : [])]));
    for (const p of people) {
      type Stop = { e: ScheduleItem; start: number; end: number; where: string; pickupOf: ScheduleItem | null };
      const stops: Stop[] = [];
      for (const e of day) {
        if (e.people.includes(p)) stops.push({ e, start: mins(e.time as string), end: endOf(e), where: e.location, pickupOf: null });
        if (e.pickup && e.pickupBy === p) {
          const at = e.endTime ? mins(e.endTime) : mins(e.time as string);
          stops.push({ e, start: at, end: at, where: e.location, pickupOf: e });
        }
      }
      stops.sort((x, y) => x.start - y.start || x.end - y.end);
      for (const s of stops.filter((x) => x.pickupOf)) {
        const ride = s.pickupOf as ScheduleItem;
        // Somewhere else right when the pickup happens.
        const away = stops.find((x) => !x.pickupOf && x.e.eventId !== ride.eventId && x.start < s.start && x.end > s.start && !flagged.has(`${x.e.eventId}|${ride.eventId}`));
        if (away) {
          out.push({
            key: `pickup:${ride.eventId}:${away.e.eventId}:${d}`,
            kind: 'pickup',
            date: d,
            text: `${p} is on the ${clock(ride.endTime ?? (ride.time as string))} pickup from ${ride.title} ${label}, but is at ${named(away.e)} until ${clock(away.e.endTime ?? (away.e.time as string))}. Someone else may need to drive.`,
            kidText: null,
            who: [p],
          });
        }
      }
      // Back to back in two different places, without time to get there.
      for (let i = 0; i + 1 < stops.length; i++) {
        const x = stops[i] as Stop;
        const y = stops.slice(i + 1).find((z) => z.start >= x.end);
        if (!y || !x.where.trim() || !y.where.trim() || place(x.where) === place(y.where)) continue;
        if (x.pickupOf && y.pickupOf) continue;
        const gap = y.start - x.end;
        if (gap >= o.travelMinutes) continue;
        if (flagged.has(`${x.e.eventId}|${y.e.eventId}`)) continue;
        const what = (s: Stop): string => (s.pickupOf ? `the pickup from ${s.pickupOf.title}` : named(s.e));
        const where = (s: Stop): string => (s.e.busy ? '' : ` at ${s.where}`);
        out.push({
          key: `travel:${x.e.eventId}:${y.e.eventId}:${p}:${d}`,
          kind: 'travel',
          date: d,
          text: `${p} has ${gap === 0 ? 'no time' : `${gap} minute${gap === 1 ? '' : 's'}`} to get from ${what(x)}${where(x)} to ${what(y)}${where(y)} ${label} (${clock(x.e.endTime ?? (x.e.time as string))} → ${clock(y.pickupOf ? (y.pickupOf.endTime ?? (y.pickupOf.time as string)) : (y.e.time as string))}). That’s tight across town.`,
          kidText: o.kids.includes(p) ? `There isn’t much time between ${what(x)} and ${what(y)} ${label} — a grown-up is sorting out the ride.` : null,
          who: [p],
        });
      }
    }
    // A child's day that is simply over-full.
    for (const k of o.kids) {
      const theirs = day.filter((e) => e.people.includes(k));
      if (theirs.length <= o.kidDayLimit) continue;
      out.push({
        key: `fullday:${k}:${d}`,
        kind: 'full_day',
        date: d,
        text: `${Label} is a lot for ${k}: ${theirs.length} things (${theirs.map((e) => named(e)).join(', ')}). Worth a look at what could move.`,
        kidText: null,
        who: [k],
      });
    }
  }
  return out;
}
