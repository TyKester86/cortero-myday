/**
 * Score & Streaks. Points totals from the ledger, the Perfect Week rule
 * (ported from apiTryPerfectWeek) and, for adults, the daily score, streaks
 * with shields, streak bonuses and achievements (lib/adult.ts).
 */
import { Router } from 'express';
import type { DateStr, HouseholdMember, PerfectWeekResult, ScoreEntry, ScoreSource, ScoreSummary } from '@myday/shared';
import { pool } from '../db.js';
import { isoWeekday, today, weekStart } from '../lib/dates.js';
import { targetMember } from '../lib/members.js';
import { refreshAdultProgress } from '../lib/adult.js';
import { xpStatus } from '../lib/xp.js';
import { bankFor } from './rewards.js';

export const scoreRouter = Router();

/**
 * Perfect Week: every scheduled chore Mon..today done and no hanging
 * homework. Awarded on Sunday only, once per member per week; the bonus
 * equals the week's total earned points (the week doubles).
 *
 * `award=false` evaluates without writing (for the score page).
 */
export async function tryPerfectWeek(member: HouseholdMember, award = true): Promise<PerfectWeekResult> {
  const t = today();
  const ws = weekStart(t);

  const { rows: prior } = await pool.query<{ points: number }>(
    "SELECT points FROM scores WHERE member_id = $1 AND source = 'perfect_week' AND week_start = $2",
    [member.id, ws],
  );
  if (prior[0]) return { awarded: false, clean: true, alreadyAwarded: true, bonus: prior[0].points };

  // Scheduled chore-days Mon..today, and whether each was done. A chore only
  // counts from the day it was added (new chores don't retroactively "miss").
  const { rows: slots } = await pool.query<{ day: DateStr; done: boolean }>(
    `SELECT d::date::text AS day, (cc.id IS NOT NULL) AS done
       FROM generate_series($2::date, $3::date, interval '1 day') AS d
       JOIN chores c ON c.member_id = $1 AND c.active
                    AND EXTRACT(ISODOW FROM d)::smallint = ANY (c.days)
                    AND c.created_on <= d::date
       LEFT JOIN chore_completions cc ON cc.chore_id = c.id AND cc.completed_on = d::date`,
    [member.id, ws, t],
  );
  const anyScheduled = slots.length > 0;
  let clean = slots.every((s) => s.done);

  // Homework: anything not done that is due by today (or undated) is hanging.
  const { rows: hanging } = await pool.query<{ n: number }>(
    'SELECT COUNT(*)::int AS n FROM homework WHERE member_id = $1 AND NOT done AND (due IS NULL OR due <= $2)',
    [member.id, t],
  );
  if ((hanging[0]?.n ?? 0) > 0) clean = false;

  const result: PerfectWeekResult = { awarded: false, clean, alreadyAwarded: false, bonus: 0 };
  if (!clean || !anyScheduled) return result;
  if (isoWeekday(t) !== 7) return result; // week so far: perfect — pays out Sunday

  // Week's earned points: chore completions Mon..today + homework done this week.
  const { rows: earned } = await pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(points), 0)::int AS total FROM scores
      WHERE member_id = $1 AND earned_on BETWEEN $2 AND $3 AND source IN ('chore', 'homework')`,
    [member.id, ws, t],
  );
  const bonus = Math.max(0, Math.round(earned[0]?.total ?? 0));
  if (bonus <= 0 || !award) return { ...result, bonus };

  const ins = await pool.query(
    `INSERT INTO scores (member_id, earned_on, points, source, note, week_start)
     VALUES ($1, $2, $3, 'perfect_week', 'Perfect week', $4)
     ON CONFLICT (member_id, week_start) WHERE source = 'perfect_week' DO NOTHING`,
    [member.id, t, bonus, ws],
  );
  return ins.rowCount
    ? { awarded: true, clean: true, alreadyAwarded: false, bonus }
    : { awarded: false, clean: true, alreadyAwarded: true, bonus };
}

interface ScoreRow {
  id: number;
  earned_on: DateStr;
  points: number;
  source: ScoreSource;
  note: string;
}

scoreRouter.get('/api/score', async (req, res) => {
  const member = await targetMember(req);
  const t = today();
  const ws = weekStart(t);
  // Adults: daily score, streak bonuses, achievements (may award XP, so first).
  const progress = member.kind === 'adult' ? await refreshAdultProgress(member.id) : null;
  const { rows: sums } = await pool.query<{ total: number; week: number; today: number }>(
    `SELECT COALESCE(SUM(points), 0)::int AS total,
            COALESCE(SUM(points) FILTER (WHERE earned_on >= $2), 0)::int AS week,
            COALESCE(SUM(points) FILTER (WHERE earned_on = $3), 0)::int AS today
       FROM scores WHERE member_id = $1`,
    [member.id, ws, t],
  );
  const { rows: recent } = await pool.query<ScoreRow>(
    `SELECT id, earned_on, points, source, note FROM scores
      WHERE member_id = $1 ORDER BY earned_on DESC, id DESC LIMIT 20`,
    [member.id],
  );
  const { rows: hist } = await pool.query<{ date: DateStr; total: number }>(
    'SELECT day::text AS date, total FROM daily_scores WHERE member_id = $1 ORDER BY day DESC LIMIT 30',
    [member.id],
  );
  const s = sums[0];
  const out: ScoreSummary = {
    member,
    totalPoints: s?.total ?? 0,
    bank: await bankFor(member.id),
    xp: await xpStatus(member.id),
    weekPoints: s?.week ?? 0,
    todayPoints: s?.today ?? 0,
    weekStart: ws,
    perfectWeek: await tryPerfectWeek(member, false),
    // Kids: no streaks, no comparison (positive-only economy).
    streak: progress?.streak ?? null,
    daily: progress?.daily ?? null,
    dailyHistory: progress ? hist.reverse() : [],
    achievements: progress?.achievements ?? [],
    newlyUnlocked: progress?.newly ?? [],
    recent: recent.map(
      (r): ScoreEntry => ({ id: r.id, date: r.earned_on, points: r.points, source: r.source, note: r.note }),
    ),
  };
  res.json(out);
});
