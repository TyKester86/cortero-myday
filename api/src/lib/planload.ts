/**
 * Loading a year plan for a member — used by `plan:load` (CLI) and by the
 * build picker. Either generated from a build, or imported from a CSV in the
 * "MH Workouts" sheet layout. Both replace the member's plan rows and phases;
 * workout logs are never touched.
 */
import type { Activity, BuildKey, DateStr, LifeStage, ProgramPhase, Sex, TrainingLevel } from '@myday/shared';
import { pool, tx } from '../db.js';
import { today, weekStart } from './dates.js';
import { buildPhases, cardioFor, defaultFoodProtein, programRows, trainWeekdays } from './program.js';

export interface BuildPlanOptions {
  build: BuildKey;
  level: TrainingLevel;
  bodyweightLb: number | null;
  foodProtein: number | null;
  /** Week 1 starts on this Monday (default: this week — "re-plan from the current week"). */
  start?: DateStr;
  sex?: Sex | null;
  heightIn?: number | null;
  activity?: Activity | null;
  goalWeightLb?: number | null;
  lifeStage?: LifeStage;
  clinicianCleared?: boolean;
  startWithCut?: boolean;
  shreddedAck?: boolean;
}

/** Under 18 (or a kid on the roster): teen mode. */
export async function isTeen(memberId: number): Promise<boolean> {
  const { rows } = await pool.query<{ kind: string; age: number | null }>('SELECT kind, age FROM household_members WHERE id = $1', [memberId]);
  const m = rows[0];
  return !!m && (m.kind === 'kid' || (m.age !== null && m.age < 18));
}

export async function loadBuildPlan(memberId: number, o: BuildPlanOptions): Promise<{ phases: number; rows: number }> {
  const teen = await isTeen(memberId);
  const lifeStage = o.lifeStage ?? 'none';
  const phases = buildPhases(o.build, o.level, { teen, startWithCut: o.startWithCut, noCut: lifeStage !== 'none' });
  const rows = programRows(o.build, phases);
  const start = weekStart(o.start ?? today());
  await tx(async (c) => {
    await c.query(
      `INSERT INTO health_profiles (member_id, plan_start, train_weekdays, build, level, bodyweight_lb, food_protein, cardio,
         sex, height_in, activity, goal_weight_lb, life_stage, clinician_cleared, start_with_cut, shredded_ack,
         cut_paused, diet_break_until, deload_week)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'moderate'), $12, $13, $14, $15, $16, NULL, NULL, NULL)
       ON CONFLICT (member_id) DO UPDATE SET plan_start = EXCLUDED.plan_start, train_weekdays = EXCLUDED.train_weekdays,
         build = EXCLUDED.build, level = EXCLUDED.level,
         bodyweight_lb = COALESCE(EXCLUDED.bodyweight_lb, health_profiles.bodyweight_lb),
         food_protein = COALESCE(EXCLUDED.food_protein, health_profiles.food_protein), cardio = EXCLUDED.cardio,
         sex = COALESCE(EXCLUDED.sex, health_profiles.sex),
         height_in = COALESCE(EXCLUDED.height_in, health_profiles.height_in),
         activity = COALESCE($11, health_profiles.activity),
         goal_weight_lb = EXCLUDED.goal_weight_lb, life_stage = EXCLUDED.life_stage,
         clinician_cleared = EXCLUDED.clinician_cleared, start_with_cut = EXCLUDED.start_with_cut,
         shredded_ack = COALESCE(EXCLUDED.shredded_ack, health_profiles.shredded_ack),
         -- A paused cut stays paused through a re-plan (only a clinician's OK clears a red flag).
         diet_break_until = NULL, deload_week = NULL`,
      [
        memberId,
        start,
        trainWeekdays(o.build),
        o.build,
        o.level,
        o.bodyweightLb,
        o.foodProtein ?? defaultFoodProtein(o.build),
        phases[0] ? cardioFor(o.build, phases[0]) : '',
        o.sex ?? null,
        o.heightIn ?? null,
        o.activity ?? null,
        o.goalWeightLb ?? null,
        lifeStage,
        !!o.clinicianCleared,
        !!o.startWithCut,
        o.shreddedAck ? new Date() : null,
      ],
    );
    await replacePhases(c, memberId, phases, (p) => cardioFor(o.build, p));
    await c.query('DELETE FROM workouts WHERE member_id = $1', [memberId]);
    let order = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO workouts (member_id, phase_id, phase_name, week_start, week_end, day_num, day_name, exercise, sets,
           reps, rest, equipment, cues, subs, focus, muscle, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [memberId, r.phaseId, r.phaseName, r.weekStart, r.weekEnd, r.dayNum, r.dayName, r.exercise, r.sets, r.reps, r.rest,
          r.equipment, r.cues, r.subs, r.focus, r.muscle, order++],
      );
    }
  });
  return { phases: phases.length, rows: rows.length };
}

type Client = { query: (text: string, values?: unknown[]) => Promise<unknown> };

async function replacePhases(c: Client, memberId: number, phases: ProgramPhase[], cardio: (p: ProgramPhase) => string): Promise<void> {
  await c.query('DELETE FROM program_phases WHERE member_id = $1', [memberId]);
  let idx = 0;
  for (const p of phases) {
    await c.query(
      `INSERT INTO program_phases (member_id, idx, kind, name, week_start, week_end, nutrition, focus, weekly_change_pct, cardio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [memberId, idx++, p.kind, p.name, p.weekStart, p.weekEnd, p.nutrition, p.focus, p.weeklyChangePct, cardio(p)],
    );
  }
}

/** One row of the "MH Workouts" sheet layout. */
export interface CsvWorkout {
  phaseId: string;
  phaseName: string;
  weekStart: number;
  weekEnd: number;
  dayNum: number;
  dayName: string;
  exercise: string;
  sets: number;
  reps: string;
  rest: string;
  equipment: string;
  cues: string;
  subs: string;
  focus: string;
}

/**
 * Import a hand-written plan. Its phases become the year's phases (weeks the
 * CSV doesn't cover show as unplanned); nutrition defaults to maintenance.
 */
export async function loadCsvPlan(memberId: number, rows: CsvWorkout[], start?: DateStr): Promise<{ phases: number; rows: number }> {
  const byPhase = new Map<string, ProgramPhase>();
  for (const r of rows) {
    if (!byPhase.has(r.phaseId)) {
      byPhase.set(r.phaseId, {
        kind: /strength/i.test(r.phaseName) ? 'strength' : /cut/i.test(r.phaseName) ? 'cut' : /deload/i.test(r.phaseName) ? 'deload' : 'hypertrophy',
        name: r.phaseName,
        weekStart: r.weekStart,
        weekEnd: r.weekEnd,
        nutrition: 'maintenance',
        focus: r.focus,
        weeklyChangePct: 0,
      });
    }
  }
  const phases = [...byPhase.values()].sort((a, b) => a.weekStart - b.weekStart);
  await tx(async (c) => {
    await c.query(
      `INSERT INTO health_profiles (member_id, plan_start) VALUES ($1, $2)
       ON CONFLICT (member_id) DO UPDATE SET plan_start = COALESCE($3, health_profiles.plan_start)`,
      [memberId, weekStart(start ?? today()), start ? weekStart(start) : null],
    );
    await replacePhases(c, memberId, phases, () => '');
    await c.query('DELETE FROM workouts WHERE member_id = $1', [memberId]);
    let order = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO workouts (member_id, phase_id, phase_name, week_start, week_end, day_num, day_name, exercise, sets,
           reps, rest, equipment, cues, subs, focus, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [memberId, r.phaseId, r.phaseName, r.weekStart, r.weekEnd, r.dayNum, r.dayName, r.exercise, r.sets, r.reps, r.rest,
          r.equipment, r.cues, r.subs, r.focus, order++],
      );
    }
  });
  return { phases: phases.length, rows: rows.length };
}
