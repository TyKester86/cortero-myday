/**
 * Body-style programs: the build picker and the program status (phase, week,
 * today's macros, shakes/day, planned protein vs target).
 */
import { Router } from 'express';
import {
  BUILD_INFO,
  BUILDS,
  shakesPerDay,
  type BuildKey,
  type DateStr,
  type NutritionMode,
  type PhaseKind,
  type ProgramPhase,
  type ProgramStatus,
  type TrainingLevel,
} from '@myday/shared';
import { pool } from '../db.js';
import { daysBetween, isoWeekday, today } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { HttpError, int } from '../lib/http.js';
import { targetMember } from '../lib/members.js';
import { loadBuildPlan } from '../lib/planload.js';
import { macrosFor, weekOf } from '../lib/program.js';

export const programRouter = Router();

/** Week 1..52 of the year plan. */
export function weekNum(planStart: DateStr | undefined | null, t: DateStr): number {
  if (!planStart) return 1;
  return Math.max(1, Math.min(52, Math.floor(daysBetween(planStart, t) / 7) + 1));
}

interface PhaseRow {
  kind: PhaseKind;
  name: string;
  week_start: number;
  week_end: number;
  nutrition: NutritionMode;
  focus: string;
  weekly_change_pct: string;
  cardio: string;
}

export async function phasesFor(memberId: number): Promise<Array<ProgramPhase & { cardio: string }>> {
  const { rows } = await pool.query<PhaseRow>(
    'SELECT kind, name, week_start, week_end, nutrition, focus, weekly_change_pct, cardio FROM program_phases WHERE member_id = $1 ORDER BY idx',
    [memberId],
  );
  return rows.map((r) => ({
    kind: r.kind,
    name: r.name,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    nutrition: r.nutrition,
    focus: r.focus,
    weeklyChangePct: Number(r.weekly_change_pct),
    cardio: r.cardio,
  }));
}

/** The member's program status, or null until a build + bodyweight are set. */
export async function programStatus(memberId: number): Promise<ProgramStatus | null> {
  const { rows } = await pool.query<{
    build: BuildKey | null;
    level: TrainingLevel;
    bodyweight_lb: string | null;
    food_protein: number | null;
    plan_start: DateStr;
  }>('SELECT build, level, bodyweight_lb, food_protein, plan_start FROM health_profiles WHERE member_id = $1', [memberId]);
  const p = rows[0];
  if (!p || !p.build || p.bodyweight_lb === null) return null;
  const phases = await phasesFor(memberId);
  if (!phases.length) return null;
  const t = today();
  const week = weekNum(p.plan_start, t);
  const phase = weekOf(phases, week);
  const bw = Number(p.bodyweight_lb);
  const info = BUILD_INFO[p.build];
  const shakes = shakesPerDay(bw, phase.nutrition, p.food_protein ?? info.foodProteinDefault);
  const { rows: meals } = await pool.query<{ protein: number | null }>(
    `SELECT m.protein FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id WHERE e.member_id = $1 AND e.day = $2`,
    [memberId, isoWeekday(t)],
  );
  const mealProtein = meals.reduce((s, m) => s + (m.protein ?? 0), 0);
  const cardio = phases.find((x) => x.name === phase.name && x.weekStart === phase.weekStart)?.cardio ?? '';
  return {
    build: info,
    level: p.level,
    bodyweightLb: bw,
    week,
    phase: { ...phase },
    phases: phases.map(({ cardio: _c, ...rest }) => rest),
    macros: macrosFor(bw, phase),
    shakes,
    cardio,
    plannedProtein: mealProtein + shakes.shakes * 25,
  };
}

programRouter.get('/api/program', async (req, res) => {
  const member = await targetMember(req);
  res.json({ program: await programStatus(member.id) });
});

/** Pick (or change) a build. Re-plans the year starting this week. */
programRouter.put('/api/program', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const build = BUILDS.find((x) => x === b.build);
  if (!build) throw new HttpError(400, 'Pick one of the builds');
  const level: TrainingLevel = b.level === 'experienced' ? 'experienced' : 'beginner';
  const bodyweightLb = int(b.bodyweightLb, 'bodyweightLb', 70, 500);
  const foodProtein = b.foodProtein === undefined || b.foodProtein === null ? null : int(b.foodProtein, 'foodProtein', 0, 400);
  await loadBuildPlan(member.id, { build, level, bodyweightLb, foodProtein });
  await logEvent('build_chosen', { build, level }, member.id);
  res.json({ program: await programStatus(member.id) });
});
