import type { DateStr, StreakInfo } from '@myday/shared';
import { pool, type Db } from '../db.js';
import { addDays, weekStart } from './dates.js';

/**
 * Days with any logged system activity (the script's activeDates_): chores
 * done, workouts, morning check-ins, evening reviews, tasks finished.
 */
export async function activeDates(memberId: number, db: Db = pool): Promise<Set<DateStr>> {
  const { rows } = await db.query<{ day: DateStr }>(
    `SELECT cc.completed_on::text AS day
       FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id WHERE c.member_id = $1
     UNION SELECT logged_on::text FROM workout_logs WHERE member_id = $1
     UNION SELECT day::text FROM checkins WHERE member_id = $1
     UNION SELECT day::text FROM reviews WHERE member_id = $1
     UNION SELECT done_on::text FROM tasks WHERE member_id = $1 AND done AND done_on IS NOT NULL`,
    [memberId],
  );
  return new Set(rows.map((r) => r.day));
}

/**
 * Port of streakInfo_. Current streak counts back from today (or yesterday if
 * today has no activity yet). A shield is earned for each of the last 12
 * weeks with 5+ active days (max 5 banked) and covers one missed day.
 */
export function computeStreak(act: Set<DateStr>, t: DateStr): StreakInfo {
  const dates = [...act].sort();
  const first = dates[0];
  let shields = 0;
  let ws = weekStart(t);
  for (let w = 0; w < 12; w++) {
    let n = 0;
    for (let k = 0; k < 7; k++) if (act.has(addDays(ws, k))) n++;
    if (n >= 5) shields = Math.min(5, shields + 1);
    ws = addDays(ws, -7);
  }

  let current = 0;
  let d = act.has(t) ? t : addDays(t, -1);
  while (first !== undefined && d >= first) {
    if (act.has(d)) current++;
    else if (shields > 0) {
      shields--;
      current++;
    } else break;
    d = addDays(d, -1);
  }

  let longest = 0;
  let run = 0;
  let prev: DateStr | null = null;
  for (const ds of dates) {
    run = prev !== null && addDays(prev, 1) === ds ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = ds;
  }
  return { current, longest, shields, totalDays: dates.length };
}

/** consecDays_: how many days in a row (ending today, or yesterday) pass `test`. */
export function consecutiveDays(test: (d: DateStr) => boolean, t: DateStr): number {
  let d = test(t) ? t : addDays(t, -1);
  let n = 0;
  for (let guard = 0; guard < 400 && test(d); guard++) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}
