/**
 * Health: today's workout (always from the member's loaded plan — never a
 * made-up default), the 52-week plan, moving a workout, the workout log and
 * history (A4), daily habits. Ported from apiHealthToday / apiHealthPlan /
 * apiHealthLogExercise / apiHealthCompleteDay / apiAdultLogWorkout /
 * apiAdultHealth / apiAdultSaveHealthBase.
 */
import { Router } from 'express';
import {
  HABITS,
  type CompleteDayResponse,
  type DateStr,
  type ExerciseLog,
  type HabitKey,
  type HealthHistory,
  type HealthPlan,
  type HealthProfile,
  type HealthToday,
  type HouseholdMember,
  type LastLift,
  type PlanPhase,
  type PlanWeek,
  type SessionLog,
  type ToggleHabitResponse,
  type WorkoutExercise,
  type WorkoutSession,
  type XpTrack,
} from '@myday/shared';
import { pool, tx } from '../db.js';
import { addDays, isoToWeekday, isoWeekday, today } from '../lib/dates.js';
import { bool, HttpError, int, str } from '../lib/http.js';
import { targetMember } from '../lib/members.js';
import { awardXpOnce, withEarn, XP_ACTIONS } from '../lib/xp.js';
import { phasesFor, programStatus, weekNum } from './program.js';

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
  build: string | null;
  baseline_exercise: string;
  baseline_sleep: string;
  baseline_food: string;
}

export async function profileFor(memberId: number): Promise<ProfileRow | null> {
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

async function hasPlan(memberId: number): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM workouts WHERE member_id = $1 LIMIT 1', [memberId]);
  return rows.length > 0;
}

/** The planned session for a calendar day (ignoring moves), from the plan rows. */
export async function plannedSession(
  memberId: number,
  prof: ProfileRow | null,
  date: DateStr,
): Promise<{ session: WorkoutSession | null; phaseName: string; focus: string; week: number }> {
  const week = weekNum(prof?.plan_start, date);
  const { rows } = await pool.query<WorkoutRow>(
    `SELECT phase_name, focus, day_num, day_name, exercise, sets, reps, rest, equipment, cues, subs
       FROM workouts WHERE member_id = $1 AND $2 BETWEEN week_start AND week_end
      ORDER BY day_num, sort_order, id`,
    [memberId, week],
  );
  let phaseName = '';
  let focus = '';
  const days = new Map<number, { name: string; ex: WorkoutExercise[] }>();
  for (const r of rows) {
    phaseName = r.phase_name;
    focus = r.focus;
    const d = days.get(r.day_num) ?? { name: r.day_name, ex: [] };
    d.ex.push({ exercise: r.exercise, sets: r.sets, reps: r.reps, rest: r.rest, equipment: r.equipment, cues: r.cues, subs: r.subs });
    days.set(r.day_num, d);
  }
  // Training weekdays map in order to plan days 1..n (e.g. Mon,Tue,Thu,Fri -> 1..4).
  const trainDays = prof?.train_weekdays ?? [1, 2, 4, 5];
  const di = trainDays.indexOf(isoWeekday(date));
  const day = di >= 0 ? days.get(di + 1) : undefined;
  return { session: day ? { dayNum: di + 1, dayName: day.name, exercises: day.ex } : null, phaseName, focus, week };
}

healthRouter.get('/api/workouts/today', async (req, res) => {
  const member: HouseholdMember = await targetMember(req);
  const t = today();
  const prof = await profileFor(member.id);
  const planned = await plannedSession(member.id, prof, t);
  let session = planned.session;
  let moved: HealthToday['moved'] = null;
  const { rows: moves } = await pool.query<{ from_day: DateStr; to_day: DateStr }>(
    'SELECT from_day::text AS from_day, to_day::text AS to_day FROM workout_moves WHERE member_id = $1 AND (from_day = $2 OR to_day = $2)',
    [member.id, t],
  );
  const away = moves.find((m) => m.from_day === t);
  const here = moves.find((m) => m.to_day === t && m.from_day !== t);
  if (here) {
    session = (await plannedSession(member.id, prof, here.from_day)).session;
    moved = { from: here.from_day };
  } else if (away) {
    session = null;
    moved = { to: away.to_day };
  }

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
    habits: await habitsFor(member.id, t),
    date: t,
    weekNum: planned.week,
    phaseName: planned.phaseName,
    focus: planned.focus,
    session,
    isRest: session === null,
    profile: prof ? toProfile(prof) : null,
    last,
    dayCompleted: done.length > 0,
    hasPlan: await hasPlan(member.id),
    moved,
    program: await programStatus(member.id),
  };
  res.json(out);
});

/** The whole year: phases + all 52 weeks with the current one flagged. */
healthRouter.get('/api/workouts/plan', async (req, res) => {
  const member = await targetMember(req);
  const prof = await profileFor(member.id);
  const current = weekNum(prof?.plan_start, today());
  const phaseRows = await phasesFor(member.id);
  const { rows } = await pool.query<{ week_start: number; week_end: number; day_num: number; day_name: string; phase_name: string }>(
    `SELECT DISTINCT week_start, week_end, day_num, day_name, phase_name FROM workouts WHERE member_id = $1 ORDER BY day_num`,
    [member.id],
  );
  const phases: PlanPhase[] = phaseRows.map((p, i) => ({
    id: `P${i + 1}`,
    name: p.name,
    kind: p.kind,
    nutrition: p.nutrition,
    weekStart: p.weekStart,
    weekEnd: p.weekEnd,
    focus: p.focus,
    cardio: p.cardio,
    days: [...new Set(rows.filter((r) => r.week_start === p.weekStart).map((r) => r.day_name))],
  }));
  const start = prof?.plan_start ?? today();
  const weeks: PlanWeek[] = Array.from({ length: 52 }, (_, i) => {
    const week = i + 1;
    const p = phaseRows.find((x) => week >= x.weekStart && week <= x.weekEnd) ?? null;
    return {
      week,
      starts: addDays(start, i * 7),
      phase: p?.name ?? null,
      kind: p?.kind ?? null,
      isCurrent: week === current,
      days: [...new Set(rows.filter((r) => week >= r.week_start && week <= r.week_end).map((r) => r.day_name))],
    };
  });
  const out: HealthPlan = { member, currentWeek: current, phases, weeks, hasPlan: rows.length > 0, build: (prof?.build as HealthPlan['build']) ?? null };
  res.json(out);
});

/** Move a day's workout (default today) to another day — e.g. "move my workout to tomorrow". */
healthRouter.post('/api/workouts/move', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const t = today();
  const from = typeof b.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.from) ? b.from : t;
  const to = b.to === 'tomorrow' ? addDays(from, 1) : typeof b.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.to) ? b.to : null;
  if (!to || to === from) throw new HttpError(400, "Say where to move it: 'tomorrow' or a date");
  const prof = await profileFor(member.id);
  const { session } = await plannedSession(member.id, prof, from);
  if (!session) throw new HttpError(409, 'There is no workout planned that day to move');
  await pool.query(
    `INSERT INTO workout_moves (member_id, from_day, to_day) VALUES ($1, $2, $3)
     ON CONFLICT (member_id, from_day) DO UPDATE SET to_day = EXCLUDED.to_day, created_at = now()`,
    [member.id, from, to],
  );
  res.json({ ok: true, from, to, session: session.dayName });
});

/** A4: log any workout (activity + minutes), like the script's FamWorkout. */
healthRouter.post('/api/workouts/session', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const t = today();
  const { rows: tr } = await pool.query<{ xp_track: XpTrack }>('SELECT xp_track FROM household_members WHERE id = $1', [member.id]);
  const { earn } = await withEarn(member.id, async () => {
    await pool.query(
      `INSERT INTO workout_logs (member_id, logged_on, kind, activity, minutes) VALUES ($1, $2, 'session', $3, $4)`,
      [member.id, t, str(b.activity, 'activity', 40) || 'Workout', int(b.minutes ?? 20, 'minutes', 1, 600)],
    );
    await awardXpOnce(member.id, t, XP_ACTIONS.workoutCompleted(tr[0]?.xp_track ?? 'leader'), 'Workout completed', `workout:${t}`);
  });
  res.status(201).json({ ...earn, history: await historyFor(member.id) });
});

async function historyFor(memberId: number): Promise<HealthHistory> {
  const t = today();
  const { rows: s } = await pool.query<{ d: DateStr; activity: string; minutes: number }>(
    `SELECT logged_on::text AS d, activity, minutes FROM workout_logs WHERE member_id = $1 AND kind = 'session'
      ORDER BY logged_on DESC, id DESC LIMIT 30`,
    [memberId],
  );
  const { rows: e } = await pool.query<{ d: DateStr; exercise: string; sets: number | null; reps: string; weight: string }>(
    `SELECT logged_on::text AS d, exercise, sets, reps, weight FROM workout_logs WHERE member_id = $1 AND kind = 'exercise'
      ORDER BY logged_on DESC, id DESC LIMIT 60`,
    [memberId],
  );
  const { rows: c } = await pool.query<{ d: DateStr }>(
    `SELECT DISTINCT logged_on::text AS d FROM workout_logs WHERE member_id = $1 AND kind = 'day_complete' ORDER BY d DESC LIMIT 60`,
    [memberId],
  );
  const { rows: m } = await pool.query<{ n: number }>(
    `SELECT COALESCE(SUM(minutes), 0)::int AS n FROM workout_logs WHERE member_id = $1 AND kind = 'session' AND logged_on > $2`,
    [memberId, addDays(t, -7)],
  );
  const prof = await profileFor(memberId);
  return {
    sessions: s.map((r): SessionLog => ({ date: r.d, activity: r.activity, minutes: r.minutes })),
    exercises: e.map((r): ExerciseLog => ({ date: r.d, exercise: r.exercise, sets: r.sets, reps: r.reps, weight: r.weight })),
    completedDays: c.map((r) => r.d),
    weekMinutes: m[0]?.n ?? 0,
    baseline: { exercise: prof?.baseline_exercise ?? '', sleep: prof?.baseline_sleep ?? '', food: prof?.baseline_food ?? '' },
  };
}

healthRouter.get('/api/workouts/history', async (req, res) => {
  res.json(await historyFor((await targetMember(req)).id));
});

/** A4: the health baseline notes (the script's FamHealthBase: exercise / sleep / food). */
healthRouter.put('/api/workouts/baseline', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  await pool.query(
    `INSERT INTO health_profiles (member_id, plan_start, baseline_exercise, baseline_sleep, baseline_food)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_id) DO UPDATE SET baseline_exercise = EXCLUDED.baseline_exercise,
       baseline_sleep = EXCLUDED.baseline_sleep, baseline_food = EXCLUDED.baseline_food`,
    [member.id, today(), str(b.exercise, 'exercise', 100), str(b.sleep, 'sleep', 40), str(b.food, 'food', 100)],
  );
  res.json(await historyFor(member.id));
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
  const { rows: tr } = await pool.query<{ xp_track: XpTrack }>('SELECT xp_track FROM household_members WHERE id = $1', [
    member.id,
  ]);
  const track = tr[0]?.xp_track ?? 'leader';
  const choreMarked = await tx(async (c) => {
    await c.query(
      `INSERT INTO workout_logs (member_id, logged_on, kind)
       SELECT $1, $2, 'day_complete'
        WHERE NOT EXISTS (SELECT 1 FROM workout_logs WHERE member_id = $1 AND logged_on = $2 AND kind = 'day_complete')`,
      [member.id, t],
    );
    // The script's "Workout Completed" XP (15; 10 on the student track), once a day.
    await awardXpOnce(member.id, t, XP_ACTIONS.workoutCompleted(track), 'Workout completed', `workout:${t}`, c);
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

/* ---------- daily habits: water, shake, creatine (was "MH Habits") ---------- */

async function habitsFor(memberId: number, day: DateStr): Promise<Record<HabitKey, boolean>> {
  const { rows } = await pool.query<{ habit: HabitKey }>(
    'SELECT habit FROM health_habits WHERE member_id = $1 AND day = $2',
    [memberId, day],
  );
  const done = new Set(rows.map((r) => r.habit));
  return { water: done.has('water'), shake: done.has('shake'), creatine: done.has('creatine') };
}

/** Toggle today's habit. Each one pays its points (HABITS) and XP; un-ticking takes them back. */
healthRouter.post('/api/habits/:habit', async (req, res) => {
  const habit = HABITS.find((h) => h.key === req.params.habit);
  if (!habit) throw new HttpError(404, 'No such habit');
  const done = bool((req.body as { done?: unknown }).done, 'done');
  const member = await targetMember(req);
  const t = today();
  const { earn } = await withEarn(member.id, () =>
    tx(async (c) => {
      if (done) {
        const ins = await c.query<{ id: number }>(
          `INSERT INTO health_habits (member_id, day, habit) VALUES ($1, $2, $3)
           ON CONFLICT (member_id, day, habit) DO NOTHING RETURNING id`,
          [member.id, t, habit.key],
        );
        const id = ins.rows[0]?.id;
        if (id !== undefined) {
          await c.query(
            `INSERT INTO scores (member_id, earned_on, points, source, note, habit_id) VALUES ($1, $2, $3, 'habit', $4, $5)`,
            [member.id, t, habit.points, habit.label, id],
          );
        }
      } else {
        // Its ledger row goes with it (ON DELETE CASCADE).
        await c.query('DELETE FROM health_habits WHERE member_id = $1 AND day = $2 AND habit = $3', [member.id, t, habit.key]);
      }
    }),
  );
  const out: ToggleHabitResponse = { ...earn, habits: await habitsFor(member.id, t) };
  res.json(out);
});
