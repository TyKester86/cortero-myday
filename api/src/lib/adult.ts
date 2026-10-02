/**
 * The adult engine's progress layer, ported from the script: the 5 × 20
 * daily score (scoreToday_), achievements (ACH_DEFS / checkAchievements_)
 * and streak XP bonuses (apiAdultScore). Evaluated whenever an adult's
 * score or day is loaded; every award is idempotent.
 */
import type { Achievement, DailyScore, DateStr, StreakInfo, XpTrack } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from './dates.js';
import { activeDates, computeStreak, consecutiveDays } from './streak.js';
import { awardXpOnce, levelFor, xpStatus } from './xp.js';

/** ADULT_CONF xp table (same for every adult role). */
export const ADULT_XP = { task: 5, checkin: 5, review: 10, habit: 3 } as const;

export async function trackOf(memberId: number): Promise<XpTrack> {
  const { rows } = await pool.query<{ xp_track: XpTrack }>('SELECT xp_track FROM household_members WHERE id = $1', [
    memberId,
  ]);
  return rows[0]?.xp_track ?? 'leader';
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

/** scoreToday_: five parts worth 20 each. */
export async function dailyScore(memberId: number, track: XpTrack, t: DateStr): Promise<DailyScore> {
  const ci = (
    await pool.query<{ sleep: string; grateful: string }>('SELECT sleep, grateful FROM checkins WHERE member_id = $1 AND day = $2', [
      memberId,
      t,
    ])
  ).rows[0];
  const workout = (await count("SELECT COUNT(*)::int AS n FROM workout_logs WHERE member_id = $1 AND logged_on = $2", [memberId, t])) > 0;
  const tasksDone = (mitOnly: boolean): Promise<number> =>
    count(`SELECT COUNT(*)::int AS n FROM tasks WHERE member_id = $1 AND done AND done_on = $2 ${mitOnly ? 'AND mit' : ''}`, [memberId, t]);

  let labels: string[];
  let parts: number[];
  if (track === 'student') {
    const mind =
      (ci !== undefined && ci.grateful.trim() !== '') ||
      (await count('SELECT COUNT(*)::int AS n FROM reviews WHERE member_id = $1 AND day = $2', [memberId, t])) > 0 ||
      (await count('SELECT COUNT(*)::int AS n FROM dump_items WHERE member_id = $1 AND captured_on = $2', [memberId, t])) > 0;
    // Study/assignment (script: FamAssign or FamStudy today); a non-MIT task still counts too.
    const study =
      (await count('SELECT COUNT(*)::int AS n FROM study_sessions WHERE member_id = $1 AND day = $2', [memberId, t])) +
      (await count('SELECT COUNT(*)::int AS n FROM assignments WHERE member_id = $1 AND (created_on = $2 OR done_on = $2)', [memberId, t])) +
      (await count('SELECT COUNT(*)::int AS n FROM tasks WHERE member_id = $1 AND done AND done_on = $2 AND NOT mit', [memberId, t]));
    labels = ['Dashboard + MITs', '1 MIT done', 'Study/assignment', 'Exercise', 'Mind care'];
    parts = [ci ? 20 : 0, (await tasksDone(true)) > 0 ? 20 : 0, study > 0 ? 20 : 0, workout ? 20 : 0, mind ? 20 : 0];
  } else {
    // familyActionRecent_: a partner check-in or 1-on-1 within the last 3 days.
    const family =
      (await count('SELECT COUNT(*)::int AS n FROM partner_checkins WHERE member_id = $1 AND updated_on >= $2', [memberId, addDays(t, -3)])) +
        (await count('SELECT COUNT(*)::int AS n FROM one_on_ones WHERE member_id = $1 AND logged_on >= $2', [memberId, addDays(t, -3)])) >
      0;
    labels = ['Sleep 7+ hrs', 'Workout', 'Today started', 'Top task done', 'Family action'];
    parts = [
      ci && (ci.sleep === 'Good' || ci.sleep === 'Great') ? 20 : 0,
      workout ? 20 : 0,
      ci ? 20 : 0,
      (await tasksDone(false)) > 0 ? 20 : 0,
      family ? 20 : 0,
    ];
  }
  const total = parts.reduce((s, p) => s + p, 0);
  await pool.query(
    `INSERT INTO daily_scores (member_id, day, parts, total) VALUES ($1, $2, $3, $4)
     ON CONFLICT (member_id, day) DO UPDATE SET parts = EXCLUDED.parts, total = EXCLUDED.total`,
    [memberId, t, parts, total],
  );
  if (total === 100) await awardXpOnce(memberId, t, 50, 'Perfect day (100/100)', `perfectday:${t}`);
  return { labels, parts, total };
}

interface AchContext {
  checkins: number;
  redAlerts: number;
  partnerCount: number;
  parentCount: number;
  posTotal: number;
  streak: StreakInfo;
  activeDays: number;
  xp: number;
  level: number;
  perfectDays: number;
  bosses: number;
  workouts: number;
  workoutsMonth: number;
  dumpCount: number;
  sleepStreak: number;
  mitStreak: number;
  moneyLinked: boolean;
  billsTracked: boolean;
  studyCount: number;
  assignZero: number;
  campusVisits: number;
  campusDistinct: number;
}

type AchDef = [name: string, desc: string, xp: number, test: (x: AchContext) => boolean];

/** ACH_DEFS, student academic badges included. */
export function achievementDefs(track: XpTrack): AchDef[] {
  if (track === 'student') {
    return [
      ['🚀 First Launch', '3 active days', 50, (x) => x.activeDays >= 3],
      ['📅 First Week', '7-day streak', 30, (x) => x.streak.current >= 7],
      ['📚 Bookworm', '10 study sessions', 40, (x) => x.studyCount >= 10],
      ['⚡ MIT Master', 'MIT done 5 days running', 50, (x) => x.mitStreak >= 5],
      ['💰 Budget Boss', 'Bills tracked + 30-day streak', 40, (x) => (x.billsTracked || x.moneyLinked) && x.streak.current >= 30],
      ['🏋️ Gym Rat', '12 workouts in a month', 40, (x) => x.workoutsMonth >= 12],
      ['😴 Sleep Champion', '7+ hrs, 14 nights running', 60, (x) => x.sleepStreak >= 14],
      ['🧠 Brain Dumper', '50 brain dumps', 25, (x) => x.dumpCount >= 50],
      ['🎯 Assignment Zero', '7 days, nothing overdue', 50, (x) => x.assignZero >= 7],
      ['📞 Office Hours Hero', '5 campus visits', 40, (x) => x.campusVisits >= 5],
      ['🤝 Support Seeker', '3 different campus resources', 35, (x) => x.campusDistinct >= 3],
      ['🔥 7-Day Streak', '7 consecutive system days', 35, (x) => x.streak.current >= 7],
    ];
  }
  const leader = track === 'leader';
  const fam = leader ? 'Dad' : 'Mom';
  const famAct = leader ? 'Marriage + Dad' : 'Relationship + Mom';
  const maxLvl: Array<[string, number]> = leader
    ? [['Reach Level 5', 5], ['Reach Level 7 (Present)', 7], ['Reach Level 9 (Building)', 9], ['Reach Level 10 (Architect)', 10]]
    : [['Reach Level 5', 5], ['Reach Level 7 (Thriving)', 7], ['Reach Level 8 (Leading)', 8]];
  const defs: AchDef[] = [
    ['🌅 First Day', 'First check-in', 0, (x) => x.checkins >= 1],
    ['📅 Week One', '7 check-ins', 0, (x) => x.checkins >= 7],
    ['🛡️ Restarted', 'Used the restart protocol', 0, (x) => x.redAlerts >= 1],
    ['💛 Family 10', `10 family actions (${famAct})`, 0, (x) => x.partnerCount + x.parentCount >= 10],
    [`👨‍👧 ${fam} 10`, `10 ${fam.toLowerCase()} presence check-ins`, 0, (x) => x.parentCount >= 10],
    ['💬 30 Positives', '30 positive partner interactions', 0, (x) => x.posTotal >= 30],
    ['🔥 30-Day Streak', '30-day streak', 0, (x) => x.streak.current >= 30 || x.streak.longest >= 30],
    ['🔥 90-Day Streak', '90-day streak', 0, (x) => x.streak.current >= 90 || x.streak.longest >= 90],
    ['📆 365 Days', 'A full year in the system', 0, (x) => x.activeDays >= 365],
    ['⭐ 1,000 XP', 'Earn 1,000 XP', 0, (x) => x.xp >= 1000],
  ];
  for (const [nm, lv] of maxLvl) defs.push([`🏔 ${nm}`, `Hit level ${lv}`, 0, (x) => x.level >= lv]);
  defs.push(['💯 Perfect Day', 'Score 100/100', 0, (x) => x.perfectDays >= 1]);
  defs.push(['⚔️ Boss x5', 'Complete 5 boss battles', 0, (x) => x.bosses >= 5]);
  defs.push(['🏃 30 Workouts', 'Log 30 workouts', 0, (x) => x.workouts >= 30]);
  return defs;
}

async function achContext(memberId: number, track: XpTrack, t: DateStr, streak: StreakInfo): Promise<AchContext> {
  const m = [memberId];
  const sleepGreat = new Set(
    (await pool.query<{ day: DateStr }>("SELECT day::text AS day FROM checkins WHERE member_id = $1 AND sleep = 'Great'", m)).rows.map((r) => r.day),
  );
  const mitDays = new Set(
    (await pool.query<{ day: DateStr }>('SELECT DISTINCT done_on::text AS day FROM tasks WHERE member_id = $1 AND done AND mit', m)).rows.map((r) => r.day),
  );
  const xp = await xpStatus(memberId);
  // Assignment Zero: days running (back from today) with nothing overdue and something done.
  const asg = (await pool.query<{ due: DateStr | null; done: boolean }>('SELECT due::text AS due, done FROM assignments WHERE member_id = $1', m)).rows;
  const anyDone = asg.some((a) => a.done);
  const assignZero = anyDone ? consecutiveDays((d) => !asg.some((a) => !a.done && a.due !== null && a.due < d), t) : 0;
  return {
    checkins: await count('SELECT COUNT(*)::int AS n FROM checkins WHERE member_id = $1', m),
    redAlerts: await count('SELECT COUNT(*)::int AS n FROM red_alerts WHERE member_id = $1', m),
    partnerCount: await count('SELECT COUNT(*)::int AS n FROM partner_checkins WHERE member_id = $1', m),
    parentCount: await count('SELECT COUNT(*)::int AS n FROM one_on_ones WHERE member_id = $1', m),
    posTotal: await count('SELECT COALESCE(SUM(positives), 0)::int AS n FROM partner_checkins WHERE member_id = $1', m),
    streak,
    activeDays: streak.totalDays,
    xp: xp.total,
    level: levelFor(track, xp.total).level,
    perfectDays: await count('SELECT COUNT(*)::int AS n FROM daily_scores WHERE member_id = $1 AND total = 100', m),
    bosses: await count("SELECT COUNT(*)::int AS n FROM boss_battles WHERE member_id = $1 AND status = 'done'", m),
    workouts: await count("SELECT COUNT(DISTINCT logged_on)::int AS n FROM workout_logs WHERE member_id = $1 AND kind = 'day_complete'", m),
    workoutsMonth: await count(
      "SELECT COUNT(DISTINCT logged_on)::int AS n FROM workout_logs WHERE member_id = $1 AND kind = 'day_complete' AND to_char(logged_on, 'YYYY-MM') = $2",
      [memberId, t.slice(0, 7)],
    ),
    dumpCount: await count('SELECT COUNT(*)::int AS n FROM dump_items WHERE member_id = $1', m),
    sleepStreak: consecutiveDays((d) => sleepGreat.has(d), t),
    mitStreak: consecutiveDays((d) => mitDays.has(d), t),
    moneyLinked: (await count('SELECT COUNT(*)::int AS n FROM money_items WHERE member_id IS NULL', [])) > 0,
    billsTracked: (await count('SELECT COUNT(*)::int AS n FROM bills', [])) > 0,
    studyCount: await count('SELECT COUNT(*)::int AS n FROM study_sessions WHERE member_id = $1', m),
    assignZero,
    campusVisits: await count('SELECT COUNT(*)::int AS n FROM campus_visits WHERE member_id = $1', m),
    campusDistinct: await count('SELECT COUNT(DISTINCT name)::int AS n FROM campus_visits WHERE member_id = $1', m),
  };
}

export interface AdultProgress {
  daily: DailyScore;
  streak: StreakInfo;
  achievements: Achievement[];
  newly: string[];
}

/** apiAdultScore: score today, pay streak bonuses, unlock achievements. */
export async function refreshAdultProgress(memberId: number): Promise<AdultProgress> {
  const t = today();
  const track = await trackOf(memberId);
  const daily = await dailyScore(memberId, track, t);
  const streak = computeStreak(await activeDates(memberId), t);

  // Streak XP bonuses, paid the day the streak reaches each mark.
  const bonuses: Array<[number, number]> = [[7, track === 'student' ? 35 : 20], [30, 100], [90, 200]];
  for (const [days, xp] of bonuses) {
    if (streak.current === days) await awardXpOnce(memberId, t, xp, `${days}-day streak`, `streak${days}:${t}`);
  }

  const ctx = await achContext(memberId, track, t, streak);
  const { rows } = await pool.query<{ name: string; unlocked_on: DateStr }>(
    'SELECT name, unlocked_on::text AS unlocked_on FROM achievements WHERE member_id = $1',
    [memberId],
  );
  const have = new Map(rows.map((r) => [r.name, r.unlocked_on]));
  const newly: string[] = [];
  const achievements: Achievement[] = [];
  for (const [name, desc, xp, test] of achievementDefs(track)) {
    let date = have.get(name) ?? null;
    if (!date && test(ctx)) {
      const ins = await pool.query(
        'INSERT INTO achievements (member_id, name, unlocked_on) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [memberId, name, t],
      );
      if (ins.rowCount) {
        newly.push(name);
        if (xp > 0) await awardXpOnce(memberId, t, xp, `Achievement: ${name}`, `ach:${name}`);
      }
      date = t;
    }
    achievements.push({ name, desc, xp, unlocked: date !== null, date });
  }
  return { daily, streak, achievements, newly };
}
