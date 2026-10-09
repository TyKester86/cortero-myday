/**
 * Participation streaks in the Feed: days in a row you showed up — a post, a clip, a story, a village post or
 * a check-in. One rest day a week is protected: missing a single day doesn't break the streak, as long as you
 * come back the next day (one per Monday–Sunday week). Today never breaks it before it's over.
 */
import { config } from '../config.js';
import { pool } from '../db.js';

export interface FeedStreak {
  /** Days shown up in the current streak (rest days don't count, they just don't break it). */
  current: number;
  best: number;
  todayDone: boolean;
  /** This week's rest day is already used (missing another day ends the streak). */
  restDayUsed: boolean;
}

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The Monday that starts this date's week. */
const weekOf = (ymd: string): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  return addDays(ymd, -((d.getUTCDay() + 6) % 7));
};

/** Streak arithmetic over a set of active days, up to `today` (exported for tests). */
export function streakFrom(days: Set<string>, today: string, lookback = 400): FeedStreak {
  let run = 0;
  let best = 0;
  let rested = new Set<string>();
  for (let d = addDays(today, -lookback); d <= today; d = addDays(d, 1)) {
    if (days.has(d)) {
      run++;
      best = Math.max(best, run);
      continue;
    }
    if (d === today) continue; // the day isn't over
    const next = addDays(d, 1);
    const wk = weekOf(d);
    if (run > 0 && !rested.has(wk) && (days.has(next) || next === today)) {
      rested.add(wk); // the protected rest day
      continue;
    }
    run = 0;
    rested = new Set();
  }
  return { current: run, best, todayDone: days.has(today), restDayUsed: rested.has(weekOf(today)) };
}

/** This person's streak (dates in the app's time zone, by the database's clock). */
export async function feedStreak(userId: number): Promise<FeedStreak> {
  const { rows } = await pool.query<{ today: string; days: string[] }>(
    `SELECT (now() AT TIME ZONE $2)::date::text AS today,
            ARRAY(SELECT DISTINCT d::text FROM (
               SELECT (created_at AT TIME ZONE $2)::date AS d FROM social_posts WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM social_clips WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM social_stories WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM forum_posts WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT day FROM feed_checkins WHERE user_id = $1 AND day > (now() AT TIME ZONE $2)::date - 400
             ) x) AS days`,
    [userId, config.tz],
  );
  const r = rows[0];
  return streakFrom(new Set(r?.days ?? []), r?.today ?? new Date().toISOString().slice(0, 10));
}
