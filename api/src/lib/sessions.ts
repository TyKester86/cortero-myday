/**
 * Where a person is in their plan. Sessions fall on the person's chosen gym days
 * (health_profiles.train_weekdays) in order, and the position moves forward only
 * when a session is marked complete: a missed gym day holds position, and nothing
 * advances by calendar. The position is health_profiles.session_week / session_day
 * (a plan week and that week's day_num); the program content itself is never touched.
 */
import type { DateStr } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, daysBetween, isoWeekday, today, weekStart } from './dates.js';

export interface PlanPos {
  week: number;
  day: number;
}

/** Week 1..52 of the year plan by calendar (the old rule; now only the starting point). */
export function weekNum(planStart: DateStr | undefined | null, t: DateStr): number {
  if (!planStart) return 1;
  return Math.max(1, Math.min(52, Math.floor(daysBetween(planStart, t) / 7) + 1));
}

/** The plan's day numbers in a given week (e.g. [1, 2, 3, 4]). */
export async function planDaysOf(memberId: number, week: number): Promise<number[]> {
  const { rows } = await pool.query<{ day_num: number }>(
    'SELECT DISTINCT day_num FROM workouts WHERE member_id = $1 AND $2 BETWEEN week_start AND week_end ORDER BY day_num',
    [memberId, week],
  );
  return rows.map((r) => r.day_num);
}

/** The first session of a week (day 1 in every generated plan). */
export async function firstPos(memberId: number, week: number): Promise<PlanPos> {
  return { week, day: (await planDaysOf(memberId, week))[0] ?? 1 };
}

/** The session after `pos`: the next day of that week, else the first day of the next week with sessions. */
export async function nextPos(memberId: number, pos: PlanPos): Promise<PlanPos> {
  const days = await planDaysOf(memberId, pos.week);
  const later = days.find((d) => d > pos.day);
  if (later !== undefined) return { week: pos.week, day: later };
  for (let w = pos.week + 1; w <= 52; w++) {
    const d = (await planDaysOf(memberId, w))[0];
    if (d !== undefined) return { week: w, day: d };
  }
  return pos; // the last session of the year stays up until a restart or a new plan
}

interface CursorRow {
  plan_start: DateStr;
  train_weekdays?: number[];
  session_week: number | null;
  session_day: number | null;
}

/**
 * The next session to do. A profile that has never had a position (a plan from
 * before sessions were completion-based) is pinned once, exactly where the old
 * calendar rule had it — this calendar week, the session of today's gym day (or the
 * next gym day's; past today's if today is already done) — so nobody's plan jumps
 * when the rule changes. From then on only completions move it.
 */
export async function currentPos(memberId: number, prof: CursorRow | null): Promise<PlanPos> {
  if (!prof) return { week: 1, day: 1 };
  if (prof.session_week !== null && prof.session_day !== null) return { week: prof.session_week, day: prof.session_day };
  const t = today();
  const week = weekNum(prof.plan_start, t);
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM workout_logs WHERE member_id = $1 AND kind = 'day_complete' AND logged_on = $2",
    [memberId, t],
  );
  const gym = prof.train_weekdays ?? [1, 2, 4, 5];
  const before = gym.filter((w) => w < isoWeekday(t)).length;
  const doneToday = (rows[0]?.n ?? 0) > 0 && gym.includes(isoWeekday(t));
  const days = await planDaysOf(memberId, week);
  const day = days[before + (doneToday ? 1 : 0)];
  const pos = day !== undefined ? { week, day } : await nextPos(memberId, { week, day: days.at(-1) ?? 1 });
  await setPos(memberId, pos, true);
  return pos;
}

/** Store the position (onlyIfUnset: the one-time pin, which must not overwrite a real position). */
export async function setPos(memberId: number, pos: PlanPos, onlyIfUnset = false): Promise<void> {
  await pool.query(
    `UPDATE health_profiles SET session_week = $2, session_day = $3
      WHERE member_id = $1 ${onlyIfUnset ? 'AND session_week IS NULL' : ''}`,
    [memberId, pos.week, pos.day],
  );
}

/** Is this date one of the person's chosen gym days? */
export function isGymDay(trainWeekdays: number[], d: DateStr): boolean {
  return trainWeekdays.includes(isoWeekday(d));
}

/** The first chosen gym day on or after `from` (null when no days are chosen). */
export function nextGymDay(trainWeekdays: number[], from: DateStr): DateStr | null {
  for (let i = 0; i < 7; i++) {
    const d = addDays(from, i);
    if (isGymDay(trainWeekdays, d)) return d;
  }
  return null;
}
