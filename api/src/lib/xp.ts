/**
 * XP + levels. Port of the script's ADULT_CONF level tables / levelFor_, plus
 * a kids' table (the script had none — see README "Decisions").
 *
 * XP = every point ever earned (scores, 1:1) + XP-only events (the script's
 * adult XP actions: workout completed, weekly plan saved). Spending points in
 * the rewards store never lowers XP.
 */
import type { EarnResult, XpStatus, XpTrack } from '@myday/shared';
import { pool, type Db } from '../db.js';

type LevelTable = ReadonlyArray<readonly [title: string, at: number]>;

export const LEVELS: Record<XpTrack, LevelTable> = {
  // Verbatim from ADULT_CONF in myday-app.gs.
  leader: [
    ['Surviving', 0], ['Aware', 100], ['Anchored', 250], ['Stable', 500], ['Consistent', 900],
    ['Leading', 1400], ['Present', 2000], ['Thriving', 2800], ['Building', 3800], ['Architect', 5000],
  ],
  woman: [
    ['Surviving', 0], ['Aware', 100], ['Anchored', 250], ['Stable', 500], ['Consistent', 900],
    ['Regulated', 1400], ['Thriving', 2000], ['Leading', 2800],
  ],
  student: [
    ['Freshman', 0], ['Sophomore', 100], ['Junior', 250], ['Senior', 500], ["Dean's List", 900],
    ['Honor Roll', 1400], ['Scholar', 2000], ['Valedictorian', 2800],
  ],
  // New in v2 (decision): same thresholds as the student table, kid titles.
  kid: [
    ['Rookie', 0], ['Helper', 100], ['Builder', 250], ['Go-Getter', 500], ['All-Star', 900],
    ['Champion', 1400], ['Superstar', 2000], ['Legend', 2800],
  ],
};

/** The script's XP for non-point actions (student values in parentheses there). */
export const XP_ACTIONS = {
  workoutCompleted: (track: XpTrack): number => (track === 'student' ? 10 : 15),
  weeklyPlanCompleted: (track: XpTrack): number => (track === 'student' ? 20 : 25),
};

/** levelFor_ port. */
export function levelFor(track: XpTrack, total: number): XpStatus {
  const table = LEVELS[track];
  let level = 1;
  let title = table[0]?.[0] ?? '';
  let at = 0;
  let next: XpStatus['next'] = null;
  for (let i = 0; i < table.length; i++) {
    const row = table[i];
    if (!row) continue;
    if (total >= row[1]) {
      level = i + 1;
      title = row[0];
      at = row[1];
    } else {
      next = { level: i + 1, title: row[0], at: row[1] };
      break;
    }
  }
  const pct = next ? Math.min(100, Math.round(((total - at) / (next.at - at)) * 100)) : 100;
  return { track, total, level, title, next, pct };
}

export async function xpStatus(memberId: number, db: Db = pool): Promise<XpStatus> {
  const { rows } = await db.query<{ track: XpTrack; total: number }>(
    `SELECT m.xp_track AS track,
            (COALESCE((SELECT SUM(points) FROM scores WHERE member_id = m.id AND points > 0), 0)
           + COALESCE((SELECT SUM(xp) FROM xp_events WHERE member_id = m.id), 0))::int AS total
       FROM household_members m WHERE m.id = $1`,
    [memberId],
  );
  const r = rows[0];
  return levelFor(r?.track ?? 'leader', r?.total ?? 0);
}

/** Award XP once per `onceKey` (e.g. "workout:2026-10-01"). Returns true if new. */
export async function awardXpOnce(
  memberId: number,
  date: string,
  xp: number,
  action: string,
  onceKey: string,
  db: Db = pool,
): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO xp_events (member_id, earned_on, xp, action, once_key) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_id, once_key) DO NOTHING`,
    [memberId, date, xp, action, onceKey],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function totalPoints(memberId: number, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    'SELECT COALESCE(SUM(points), 0)::int AS total FROM scores WHERE member_id = $1',
    [memberId],
  );
  return rows[0]?.total ?? 0;
}

/** Runs an earning action and reports points, XP and whether a level was gained. */
export async function withEarn<T>(memberId: number, fn: () => Promise<T>): Promise<{ result: T; earn: EarnResult }> {
  const before = await xpStatus(memberId);
  const result = await fn();
  const xp = await xpStatus(memberId);
  return { result, earn: { totalPoints: await totalPoints(memberId), xp, leveledUp: xp.level > before.level } };
}
