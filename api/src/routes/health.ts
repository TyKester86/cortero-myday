/**
 * Health: today's workout + the year plan. Ported from apiHealthToday,
 * apiHealthPlan, apiHealthLogExercise, apiHealthCompleteDay. The plan rows
 * and profile are per household member (no hard-coded people).
 */
import { Router } from 'express';
import type {
  CompleteDayResponse,
  DateStr,
  HealthPlan,
  HealthProfile,
  HealthToday,
  HouseholdMember,
  LastLift,
  PlanPhase,
  WorkoutExercise,
  WorkoutSession,
} from '@myday/shared';
import { pool, tx } from '../db.js';
import { daysBetween, isoToWeekday, isoWeekday, today } from '../lib/dates.js';
import { int, str } from '../lib/http.js';
import { targetMember } from '../lib/members.js';

export const healthRouter = Router();

interface ProfileRow {
  plan_start: DateStr;
  train_weekdays: number[];
  target_calories: number;
  target_protein: number;
  target_carbs: number;
  target_fat: number;
  breakfast: string;
  shake: string;
  cardio: string;
  workout_chore_name: string;
}

async function profileFor(memberId: number): Promise<ProfileRow | null> {
  const { rows } = await pool.query<ProfileRow>('SELECT * FROM health_profiles WHERE member_id = $1', [memberId]);
  return rows[0] ?? null;
}

function toProfile(p: ProfileRow): HealthProfile {
  return {
    planStart: p.plan_start,
    trainWeekdays: p.train_weekdays.map(isoToWeekday),
    targetCalories: p.target_calories,
    targetProtein: p.target_protein,
    targetCarbs: p.target_carbs,
    targetFat: p.target_fat,
    breakfast: p.breakfast,
    shake: p.shake,
    cardio: p.cardio,
  };
}

/** Week 1..52 of the year plan (mhWeekNum_). */
function weekNum(planStart: DateStr | undefined, t: DateStr): number {
  if (!planStart) return 1;
  return Math.max(1, Math.min(52, Math.floor(daysBetween(planStart, t) / 7) + 1));
}

interface WorkoutRow {
  phase_name: string;
  focus: string;
  day_num: number;
  day_name: string;
  exercise: string;
  sets: number;
  reps: string;
  rest: string;
  equipment: string;
  cues: string;
  subs: string;
}

healthRouter.get('/api/workouts/today', async (req, res) => {
  const member: HouseholdMember = await targetMember(req);
  const t = today();
  const prof = await profileFor(member.id);
  const wk = weekNum(prof?.plan_start, t);

  const { rows } = await pool.query<WorkoutRow>(
    `SELECT phase_name, focus, day_num, day_name, exercise, sets, reps, rest, equipment, cues, subs
       FROM workouts WHERE member_id = $1 AND $2 BETWEEN week_start AND week_end
      ORDER BY day_num, sort_order, id`,
    [member.id, wk],
  );
  let phaseName = '';
  let focus = '';
  const days = new Map<number, { name: string; ex: WorkoutExercise[] }>();
  for (const r of rows) {
    phaseName = r.phase_name;
    focus = r.focus;
    const d = days.get(r.day_num) ?? { name: r.day_name, ex: [] };
    d.ex.push({
      exercise: r.exercise,
      sets: r.sets,
      reps: r.reps,
      rest: r.rest,
      equipment: r.equipment,
      cues: r.cues,
      subs: r.subs,
    });
    days.set(r.day_num, d);
  }
  // Training weekdays map in order to plan days 1..n (Mon,Tue,Thu,Fri -> 1..4).
  const trainDays = prof?.train_weekdays ?? [1, 2, 4, 5];
  const di = trainDays.indexOf(isoWeekday(t));
  const day = di >= 0 ? days.get(di + 1) : undefined;
  const session: WorkoutSession | null = day ? { dayNum: di + 1, dayName: day.name, exercises: day.ex } : null;

  const { rows: logs } = await pool.query<{ exercise: string; weight: string; reps: string; logged_on: DateStr }>(
    `SELECT DISTINCT ON (exercise) exercise, weight, reps, logged_on::text AS logged_on
       FROM workout_logs WHERE member_id = $1 AND kind = 'exercise'
      ORDER BY exercise, logged_on DESC, id DESC`,
    [member.id],
  );
  const last: Record<string, LastLift> = {};
  for (const l of logs) last[l.exercise] = { weight: l.weight, reps: l.reps, date: l.logged_on };

  const { rows: done } = await pool.query(
    "SELECT 1 FROM workout_logs WHERE member_id = $1 AND kind = 'day_complete' AND logged_on = $2",
    [member.id, t],
  );

  const out: HealthToday = {
    member,
    date: t,
    weekNum: wk,
    phaseName,
    focus,
    session,
    isRest: session === null,
    profile: prof ? toProfile(prof) : null,
    last,
    dayCompleted: done.length > 0,
  };
  res.json(out);
});

healthRouter.get('/api/workouts/plan', async (req, res) => {
  const member = await targetMember(req);
  const prof = await profileFor(member.id);
  const { rows } = await pool.query<{
    phase_id: string;
    phase_name: string;
    week_start: number;
    week_end: number;
    focus: string;
    day_name: string;
  }>(
    `SELECT phase_id, phase_name, week_start, week_end, focus, day_name
       FROM workouts WHERE member_id = $1 ORDER BY week_start, day_num, sort_order, id`,
    [member.id],
  );
  const phases = new Map<string, PlanPhase>();
  for (const r of rows) {
    const p = phases.get(r.phase_id) ?? {
      id: r.phase_id,
      name: r.phase_name,
      weekStart: r.week_start,
      weekEnd: r.week_end,
      focus: r.focus,
      days: [],
    };
    if (!p.days.includes(r.day_name)) p.days.push(r.day_name);
    phases.set(r.phase_id, p);
  }
  const out: HealthPlan = { member, currentWeek: weekNum(prof?.plan_start, today()), phases: [...phases.values()] };
  res.json(out);
});

healthRouter.post('/api/workouts/log', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  await pool.query(
    `INSERT INTO workout_logs (member_id, logged_on, kind, phase_name, day_name, exercise, sets, reps, weight)
     VALUES ($1, $2, 'exercise', $3, $4, $5, $6, $7, $8)`,
    [
      member.id,
      today(),
      str(b.phaseName, 'phaseName', 40),
      str(b.dayName, 'dayName', 40),
      str(b.exercise, 'exercise', 80, true),
      int(b.sets ?? 3, 'sets', 1, 20),
      str(b.reps, 'reps', 20),
      str(b.weight, 'weight', 20),
    ],
  );
  res.status(201).json({ ok: true });
});

/**
 * Complete today's session. Like the original, this also checks off the
 * member's workout chore ("Indoor workout (AM)" by default) when they have one
 * scheduled today, which awards its points.
 */
healthRouter.post('/api/workouts/complete-day', async (req, res) => {
  const member = await targetMember(req);
  const t = today();
  const prof = await profileFor(member.id);
  const choreName = prof?.workout_chore_name ?? 'Indoor workout (AM)';
  const choreMarked = await tx(async (c) => {
    await c.query(
      `INSERT INTO workout_logs (member_id, logged_on, kind)
       SELECT $1, $2, 'day_complete'
        WHERE NOT EXISTS (SELECT 1 FROM workout_logs WHERE member_id = $1 AND logged_on = $2 AND kind = 'day_complete')`,
      [member.id, t],
    );
    const { rows } = await c.query<{ id: number; points: number; name: string }>(
      `SELECT id, points, name FROM chores
        WHERE member_id = $1 AND active AND lower(name) = lower($2) AND $3 = ANY (days)`,
      [member.id, choreName, isoWeekday(t)],
    );
    const chore = rows[0];
    if (!chore) return false;
    const ins = await c.query<{ id: number }>(
      `INSERT INTO chore_completions (chore_id, completed_on, points, completed_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (chore_id, completed_on) DO NOTHING RETURNING id`,
      [chore.id, t, chore.points, req.user?.id ?? null],
    );
    const cid = ins.rows[0]?.id;
    if (cid !== undefined) {
      await c.query(
        `INSERT INTO scores (member_id, earned_on, points, source, note, chore_completion_id)
         VALUES ($1, $2, $3, 'chore', $4, $5)`,
        [member.id, t, chore.points, chore.name, cid],
      );
    }
    return true;
  });
  const out: CompleteDayResponse = { choreMarked };
  res.json(out);
});
