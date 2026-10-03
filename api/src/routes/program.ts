/**
 * Body-style programs: the build picker (with its safety gates) and the
 * program status (phase, week, today's calories and protein, shakes/day,
 * check-ins, deloads, diet breaks), plus opt-in weigh-ins.
 *
 * Safety, from "Evidence for the nine body builds":
 *   - under 18: teen mode — no calorie, weight or shake targets; no Shredded
 *   - Shredded: adults, experienced, after an eating-disorder screen + disclosure
 *   - pregnancy / postpartum: a clinician's OK first, and no cut
 *   - every cut: ≤500 kcal/day deficit and a calorie floor (lib/program)
 *   - women cutting, Lean Runner, Shredded: a check-in every 4 weeks; red
 *     flags pause the cut until a clinician clears it
 *   - weigh-ins: opt-in, 7-day averages only
 */
import { Router } from 'express';
import {
  ACTIVITY,
  BUILD_INFO,
  BUILDS,
  ED_SCREEN,
  TEEN_STYLE,
  perMealProtein,
  shakesPerDay,
  type Activity,
  type BodyCheckinAnswers,
  type BuildKey,
  type DateStr,
  type LifeStage,
  type NutritionMode,
  type PhaseKind,
  type ProgramPhase,
  type ProgramStatus,
  type Sex,
  type TrainingLevel,
  type WeighInSummary,
} from '@myday/shared';
import { pool } from '../db.js';
import { addDays, daysBetween, isoWeekday, today, weekStart } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { HttpError, bool, int } from '../lib/http.js';
import { targetMember } from '../lib/members.js';
import { isTeen, loadBuildPlan } from '../lib/planload.js';
import { CHAPTERS, bodyInputs, chapterOf, energyFor, weekOf } from '../lib/program.js';

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

interface ProgramRow {
  build: BuildKey | null;
  level: TrainingLevel;
  bodyweight_lb: string | null;
  food_protein: number | null;
  plan_start: DateStr;
  sex: Sex | null;
  height_in: string | null;
  activity: Activity;
  goal_weight_lb: string | null;
  life_stage: LifeStage;
  weigh_ins: boolean;
  calorie_adjust: number;
  calibrated_on: DateStr | null;
  cut_paused: string | null;
  diet_break_until: DateStr | null;
  deload_week: DateStr | null;
}

async function programRow(memberId: number): Promise<ProgramRow | null> {
  const { rows } = await pool.query<ProgramRow>(
    `SELECT build, level, bodyweight_lb, food_protein, plan_start::text AS plan_start, sex, height_in, activity, goal_weight_lb,
            life_stage, weigh_ins, calorie_adjust, calibrated_on::text AS calibrated_on, cut_paused,
            diet_break_until::text AS diet_break_until, deload_week::text AS deload_week
       FROM health_profiles WHERE member_id = $1`,
    [memberId],
  );
  return rows[0] ?? null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/**
 * Every 2 weeks, compare the 7-day average weight trend with the phase's
 * target and nudge the calorie estimate by 100–250 kcal. The first 2 weeks of
 * each phase are ignored (water and glycogen swing).
 */
async function recalibrate(memberId: number, p: ProgramRow, phase: ProgramPhase, pctNow: number): Promise<void> {
  if (!p.weigh_ins || p.bodyweight_lb === null) return;
  const t = today();
  if (p.calibrated_on && daysBetween(p.calibrated_on, t) < 14) return;
  const phaseStart = addDays(p.plan_start, (phase.weekStart - 1) * 7);
  if (daysBetween(phaseStart, t) < 14) return;
  const { rows } = await pool.query<{ day: DateStr; weight_lb: string }>(
    'SELECT day::text AS day, weight_lb FROM weigh_ins WHERE member_id = $1 AND day > $2 AND day <= $3',
    [memberId, addDays(t, -14), t],
  );
  const recent = rows.filter((r) => r.day > addDays(t, -7)).map((r) => Number(r.weight_lb));
  const before = rows.filter((r) => r.day <= addDays(t, -7)).map((r) => Number(r.weight_lb));
  if (recent.length < 4 || before.length < 4) return;
  const observed = avg(recent) - avg(before); // lb per week
  const target = (Number(p.bodyweight_lb) * pctNow) / 100;
  const offKcal = (observed - target) * 500; // + = gaining faster (or losing slower) than planned
  const step = Math.abs(offKcal) < 100 ? 0 : Math.max(-250, Math.min(250, Math.round(offKcal / 50) * 50));
  await pool.query(
    'UPDATE health_profiles SET calorie_adjust = calorie_adjust - $2, calibrated_on = $3, bodyweight_lb = $4 WHERE member_id = $1',
    [memberId, step, t, Math.round(avg(recent) * 10) / 10],
  );
  p.calorie_adjust -= step;
  p.calibrated_on = t;
  p.bodyweight_lb = String(Math.round(avg(recent) * 10) / 10);
}

/** Why a deload might help now: soft flags in a recent check-in, or a main lift stalled for 2 sessions. */
async function deloadSuggestion(memberId: number): Promise<string | null> {
  const t = today();
  const { rows: ci } = await pool.query<{ flags: string[] }>(
    'SELECT flags FROM body_checkins WHERE member_id = $1 AND taken_on > $2 ORDER BY taken_on DESC, id DESC LIMIT 1',
    [memberId, addDays(t, -7)],
  );
  const soft = (ci[0]?.flags ?? []).filter((f) => ['aches', 'sleep', 'fatigue'].includes(f));
  if (soft.length) return `Your check-in mentioned ${soft.map((f) => (f === 'aches' ? 'aches' : f === 'sleep' ? 'poor sleep' : 'feeling run down')).join(' and ')}. A lighter week now usually means a stronger month after.`;
  const { rows } = await pool.query<{ exercise: string; weight: string; reps: string }>(
    `SELECT exercise, weight, reps FROM workout_logs WHERE member_id = $1 AND kind = 'exercise' AND logged_on > $2
      ORDER BY exercise, logged_on DESC, id DESC`,
    [memberId, addDays(t, -42)],
  );
  const by = new Map<string, Array<{ w: number; r: number }>>();
  for (const r of rows) {
    const w = parseFloat(r.weight);
    const reps = parseInt(r.reps, 10);
    if (!Number.isFinite(w) || !Number.isFinite(reps)) continue;
    by.set(r.exercise, [...(by.get(r.exercise) ?? []), { w, r: reps }]);
  }
  for (const [ex, logs] of by) {
    const [a, b, c] = logs; // newest first
    // Stalled: the last two sessions didn't beat the one before (no more weight, no more reps).
    if (a && b && c && a.w <= c.w && b.w <= c.w && a.r <= c.r && b.r <= c.r) {
      return `${ex} hasn't moved for 2 sessions. A deload week often breaks a stall.`;
    }
  }
  return null;
}

const CHECKIN_BUILDS: BuildKey[] = ['lean_runner', 'shredded'];

function notesFor(o: {
  build: BuildKey;
  teen: boolean;
  sex: Sex;
  age: number;
  week: number;
  phase: ProgramPhase;
  lifeStage: LifeStage;
  cutWeeksIn: number;
}): string[] {
  if (o.teen) {
    return [
      'You’re building skills and strength that last. Your goals here are about what your body can do: lifting more, running farther, showing up, sleeping well.',
      'We don’t do calorie targets or weight goals for teens — your body is still growing and needs plenty of fuel. Eat regular meals with a protein food at each one.',
      'Bodies change on their own schedule, and comparing yours to anyone online isn’t a fair test.',
    ];
  }
  const n: string[] = [];
  if (o.lifeStage === 'pregnant') n.push('In pregnancy your clinician sets your food targets and limits. This plan never includes a cut.');
  if (o.week <= 4) {
    n.push('Your build is a training style, not a guarantee. Training decides where you add muscle; your genes decide your frame and where you lose fat first and last. Strength shows up within weeks; visible change takes months.');
    n.push(
      o.sex === 'male'
        ? 'In a first year of consistent training, many men add roughly 4–9 kg (9–20 lb) of muscle. Some gain more, some less, and gains slow every year after.'
        : 'In a first year of consistent training, many women add roughly 2–4.5 kg (4–10 lb) of muscle. Some gain more, some less, and gains slow every year after.',
    );
  }
  if (['toned_athletic', 'hourglass', 'lean_runner'].includes(o.build)) {
    n.push('“Toned” means building muscle and lowering body fat enough for it to show. Ab and thigh exercises won’t burn fat from those spots — fat comes off your whole body, in an order set by your genes.');
  }
  if (o.build === 'hourglass' || o.build === 'v_taper') {
    n.push('Bone structure, like hip and shoulder width, doesn’t change — your version of this look will be uniquely yours.');
  }
  if (o.build === 'shredded') {
    n.push('Shredded is a peak, not a lifestyle. Near the end of the cut, energy, mood, sleep and sex drive commonly dip. If food starts to feel like it’s running your life, tap “I need a break”.');
  }
  if (o.build === 'lean_runner') {
    n.push('Your runner’s look comes from consistent running and strength work with enough fuel, not from eating as little as possible. If your period changes or stops, or you get a bone injury, we pause any deficit and suggest a doctor — a signal, not a failure.');
  }
  if (o.phase.nutrition === 'cutting' && o.cutWeeksIn >= 6) n.push('Six or more weeks into a cut: a 1-week diet break at maintenance is a good option. Tap “Take a diet break”.');
  if (o.lifeStage === 'none') n.push('Optional: creatine monohydrate, 3–5 g a day, is the best-studied supplement for strength. Expect 1–2 lb of water weight early — not fat.');
  n.push('Sleep 7–9 hours. Dieting on short sleep shifted the weight lost away from fat and toward muscle in a controlled study.');
  if (o.age >= 40) n.push('Over 40, progress is a bit slower. It still works.');
  if (o.sex === 'female' && o.age >= 45) n.push('Around menopause, lifting matters even more for muscle and bone. If symptoms get in the way of training, note them in your check-in and we’ll adjust.');
  return n;
}

/** The member's program status, or null until a build + bodyweight are set. */
export async function programStatus(memberId: number): Promise<ProgramStatus | null> {
  const p = await programRow(memberId);
  if (!p || !p.build) return null;
  const teen = await isTeen(memberId);
  if (p.bodyweight_lb === null && !teen) return null;
  const phases = await phasesFor(memberId);
  if (!phases.length) return null;
  const t = today();
  const week = weekNum(p.plan_start, t);
  const phase = weekOf(phases, week);
  const info = BUILD_INFO[p.build];
  const { rows: mrow } = await pool.query<{ age: number | null }>('SELECT age FROM household_members WHERE id = $1', [memberId]);
  const dietBreak = p.diet_break_until && p.diet_break_until >= t ? p.diet_break_until : null;
  const paused = !!p.cut_paused || !!dietBreak || p.life_stage !== 'none';
  // A paused cut (stop rule, diet break, pregnancy/postpartum) eats at maintenance.
  const eat: Pick<ProgramPhase, 'nutrition' | 'weeklyChangePct'> =
    paused && phase.nutrition === 'cutting' ? { nutrition: 'maintenance', weeklyChangePct: 0 } : phase;
  if (!teen) await recalibrate(memberId, p, phase, eat.weeklyChangePct);
  const bw = p.bodyweight_lb === null ? null : Number(p.bodyweight_lb);
  const body = bodyInputs(p.build, {
    weightLb: bw ?? 120,
    sex: p.sex,
    ageYears: mrow[0]?.age ?? null,
    heightIn: num(p.height_in),
    activity: p.activity,
    goalWeightLb: num(p.goal_weight_lb),
  });
  const noTargets = teen || p.life_stage === 'pregnant' || bw === null;
  const food = noTargets ? null : energyFor(body, eat, p.calorie_adjust);
  const shakes = food ? shakesPerDay(food.energy.referenceLb, eat.nutrition, p.food_protein ?? info.foodProteinDefault) : null;
  let plannedProtein: number | null = null;
  if (shakes) {
    const { rows: meals } = await pool.query<{ protein: number | null }>(
      `SELECT m.protein FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id WHERE e.member_id = $1 AND e.day = $2`,
      [memberId, isoWeekday(t)],
    );
    plannedProtein = meals.reduce((s, m) => s + (m.protein ?? 0), 0) + shakes.shakes * 25;
  }
  const cardio = phases.find((x) => x.name === phase.name && x.weekStart === phase.weekStart)?.cardio ?? '';
  const { rows: last } = await pool.query<{ taken_on: DateStr }>(
    'SELECT taken_on::text AS taken_on FROM body_checkins WHERE member_id = $1 ORDER BY taken_on DESC, id DESC LIMIT 1',
    [memberId],
  );
  const needed = CHECKIN_BUILDS.includes(p.build) || (body.sex === 'female' && phases.some((x) => x.nutrition === 'cutting'));
  const lastOn = last[0]?.taken_on ?? null;
  const firstCutWeek = phases.find((x) => x.nutrition === 'cutting' && x.weekStart <= week)?.weekStart ?? week;
  return {
    build: info,
    teen,
    label: teen ? (TEEN_STYLE[p.build] ?? info.label) : info.label,
    level: p.level,
    bodyweightLb: bw,
    week,
    chapter: chapterOf(week),
    phase: { kind: phase.kind, name: phase.name, weekStart: phase.weekStart, weekEnd: phase.weekEnd, nutrition: phase.nutrition, focus: phase.focus, weeklyChangePct: phase.weeklyChangePct },
    phases: phases.map(({ cardio: _c, ...rest }) => rest),
    macros: food?.macros ?? null,
    energy: food?.energy ?? null,
    shakes,
    perMeal: shakes && food ? { meals: 4, grams: perMealProtein(shakes.proteinTarget, 4, food.energy.referenceLb) } : null,
    cardio,
    plannedProtein,
    cutPaused: p.cut_paused,
    dietBreakUntil: dietBreak,
    deloadThisWeek: p.deload_week === weekStart(t),
    deloadSuggested: p.deload_week === weekStart(t) ? null : await deloadSuggestion(memberId),
    checkin: { needed, due: needed && (!lastOn || daysBetween(lastOn, t) >= 28), lastOn, askPeriods: body.sex === 'female' },
    weighIns: p.weigh_ins && !teen,
    lifeStage: p.life_stage,
    notes: notesFor({ build: p.build, teen, sex: body.sex, age: body.ageYears, week, phase, lifeStage: p.life_stage, cutWeeksIn: week - firstCutWeek }),
  };
}

programRouter.get('/api/program', async (req, res) => {
  const member = await targetMember(req);
  res.json({ program: await programStatus(member.id) });
});

const optNum = (v: unknown, field: string, min: number, max: number): number | null =>
  v === undefined || v === null || v === '' ? null : int(v, field, min, max);

/** Pick (or change) a build. Re-plans the year starting this week — after the safety gates. */
programRouter.put('/api/program', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const build = BUILDS.find((x) => x === b.build);
  if (!build) throw new HttpError(400, 'Pick one of the builds');
  const level: TrainingLevel = b.level === 'experienced' ? 'experienced' : 'beginner';
  const foodProtein = optNum(b.foodProtein, 'foodProtein', 0, 400);
  const ageYears = optNum(b.ageYears, 'ageYears', 8, 100);
  if (ageYears !== null) await pool.query('UPDATE household_members SET age = $2 WHERE id = $1', [member.id, ageYears]);
  // Teens don't need to give a weight (no calorie or weight targets).
  const bodyweightLb = (await isTeen(member.id)) && (b.bodyweightLb === undefined || b.bodyweightLb === null || b.bodyweightLb === '')
    ? null
    : int(b.bodyweightLb, 'bodyweightLb', 70, 500);
  const sex: Sex | null = b.sex === 'male' || b.sex === 'female' ? b.sex : null;
  const activity: Activity | null = typeof b.activity === 'string' && b.activity in ACTIVITY ? (b.activity as Activity) : null;
  const lifeStage: LifeStage = b.lifeStage === 'pregnant' || b.lifeStage === 'postpartum' ? b.lifeStage : 'none';
  const clinicianCleared = b.clinicianCleared === true;
  const teen = await isTeen(member.id);

  if (build === 'shredded') {
    if (teen) throw new HttpError(400, 'Shredded is for adults only. Try the Athletic style instead.', 'adults_only');
    if (level === 'beginner') {
      throw new HttpError(409, 'Shredded needs a muscular base first. Start with Lean Athletic this year — “Shredded-ready” is a milestone for later.', 'shredded_needs_base');
    }
    const screen = Array.isArray(b.edScreen) ? b.edScreen : null;
    if (!screen || screen.length !== ED_SCREEN.length) throw new HttpError(409, 'A few quick questions first.', 'shredded_screen');
    if (screen.filter((x) => x === true).length >= 2) {
      await logEvent('build_screen_referred', { build }, member.id);
      throw new HttpError(
        409,
        'Your answers suggest food may be feeling like a lot right now. A very lean cut isn’t a good fit at the moment — please talk with a doctor or a dietitian. Lean Athletic at maintenance is a great place to train meanwhile.',
        'shredded_screen_positive',
      );
    }
    if (b.shreddedAck !== true) throw new HttpError(409, 'Please read what a Shredded peak costs first.', 'shredded_ack');
  }
  if (lifeStage !== 'none' && !clinicianCleared) {
    throw new HttpError(
      409,
      lifeStage === 'pregnant'
        ? 'Congratulations! Please get your clinician’s OK for exercise first. Once they’ve cleared you, we’ll set up a plan with no cut and no calorie targets.'
        : 'Please get your clinician’s OK for exercise first (most people get it at the postpartum check). Once cleared, your plan starts with no cut.',
      'clinician_needed',
    );
  }
  const heightIn = optNum(b.heightIn, 'heightIn', 48, 90);
  const goalWeightLb = optNum(b.goalWeightLb, 'goalWeightLb', 70, 500);
  const startWithCut = typeof b.startWithCut === 'boolean' ? b.startWithCut : !!heightIn && !!bodyweightLb && (703 * bodyweightLb) / (heightIn * heightIn) >= 30;
  await loadBuildPlan(member.id, {
    build,
    level,
    bodyweightLb,
    foodProtein,
    sex,
    heightIn,
    activity,
    goalWeightLb,
    lifeStage,
    clinicianCleared,
    startWithCut: !teen && lifeStage === 'none' && startWithCut,
    shreddedAck: build === 'shredded',
  });
  await logEvent('build_chosen', { build, level }, member.id);
  res.json({ program: await programStatus(member.id) });
});

/**
 * The 4-weekly check-in. Red flags (3+ months without a period, a bone-stress
 * injury, food running your life) pause any cut and suggest a clinician.
 */
programRouter.post('/api/program/checkin', async (req, res) => {
  const member = await targetMember(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const yes = (k: string): boolean => b[k] === true;
  const a: BodyCheckinAnswers = {
    periodChange: yes('periodChange'),
    monthsNoPeriod: optNum(b.monthsNoPeriod, 'monthsNoPeriod', 0, 24) ?? 0,
    boneInjury: yes('boneInjury'),
    fatigue: yes('fatigue'),
    foodWorry: yes('foodWorry'),
    sleepPoor: yes('sleepPoor'),
    aches: yes('aches'),
  };
  const red: string[] = [];
  if ((a.monthsNoPeriod ?? 0) >= 3) red.push('3+ months without a period');
  if (a.boneInjury) red.push('a bone-stress injury');
  if (a.foodWorry) red.push('food feeling like it’s running your life');
  const flags = [...red.map(() => 'red'), a.periodChange ? 'period' : '', a.fatigue ? 'fatigue' : '', a.sleepPoor ? 'sleep' : '', a.aches ? 'aches' : ''].filter(Boolean);
  await pool.query('INSERT INTO body_checkins (member_id, taken_on, answers, flags) VALUES ($1, $2, $3, $4)', [member.id, today(), JSON.stringify(a), flags]);
  if (red.length) {
    const reason = `Paused because of ${red.join(' and ')}. Please check in with a doctor; we’ll keep training going at maintenance meanwhile.`;
    await pool.query('UPDATE health_profiles SET cut_paused = $2 WHERE member_id = $1', [member.id, reason]);
    await logEvent('cut_paused', { reasons: red.length }, member.id);
  }
  res.json({ program: await programStatus(member.id), red: red.length > 0 });
});

/** Resume a paused cut — only with a clinician's OK. */
programRouter.post('/api/program/resume', async (req, res) => {
  const member = await targetMember(req);
  if ((req.body as { clinicianCleared?: unknown }).clinicianCleared !== true) {
    throw new HttpError(400, 'Resuming needs your clinician’s OK first', 'clinician_needed');
  }
  await pool.query('UPDATE health_profiles SET cut_paused = NULL WHERE member_id = $1', [member.id]);
  res.json({ program: await programStatus(member.id) });
});

/** "I need a break" / diet break: a week at maintenance calories (or end it early). */
programRouter.post('/api/program/diet-break', async (req, res) => {
  const member = await targetMember(req);
  const on = bool((req.body as { on?: unknown }).on, 'on');
  await pool.query('UPDATE health_profiles SET diet_break_until = $2 WHERE member_id = $1', [member.id, on ? addDays(today(), 6) : null]);
  res.json({ program: await programStatus(member.id) });
});

/** A flexible deload: make this week a light week (or undo it). */
programRouter.post('/api/program/deload', async (req, res) => {
  const member = await targetMember(req);
  const on = bool((req.body as { on?: unknown }).on, 'on');
  await pool.query('UPDATE health_profiles SET deload_week = $2 WHERE member_id = $1', [member.id, on ? weekStart(today()) : null]);
  res.json({ program: await programStatus(member.id) });
});

/** Restart a week (default: the start of the current phase) — e.g. back after a long break, or a chapter start. */
programRouter.post('/api/program/restart', async (req, res) => {
  const member = await targetMember(req);
  const p = await programRow(member.id);
  if (!p?.build) throw new HttpError(409, 'No build plan to restart');
  const phases = await phasesFor(member.id);
  const b = req.body as { week?: unknown; chapter?: unknown };
  const now = weekNum(p.plan_start, today());
  const target =
    b.chapter !== undefined
      ? (CHAPTERS.find((c) => c.n === int(b.chapter, 'chapter', 1, 4))?.weekStart ?? 1)
      : b.week !== undefined
        ? int(b.week, 'week', 1, 52)
        : weekOf(phases, now).weekStart;
  await pool.query('UPDATE health_profiles SET plan_start = $2 WHERE member_id = $1', [member.id, addDays(weekStart(today()), -(target - 1) * 7)]);
  res.json({ program: await programStatus(member.id) });
});

/* ---------- opt-in weigh-ins: 7-day averages only ---------- */

async function weighInSummary(memberId: number, enabled: boolean): Promise<WeighInSummary> {
  const t = today();
  const { rows } = await pool.query<{ day: DateStr; weight_lb: string }>(
    'SELECT day::text AS day, weight_lb FROM weigh_ins WHERE member_id = $1 AND day > $2 ORDER BY day',
    [memberId, addDays(t, -84)],
  );
  const recent = rows.filter((r) => r.day > addDays(t, -7)).map((r) => Number(r.weight_lb));
  const byWeek = new Map<DateStr, number[]>();
  for (const r of rows) byWeek.set(weekStart(r.day), [...(byWeek.get(weekStart(r.day)) ?? []), Number(r.weight_lb)]);
  return {
    enabled,
    average7: recent.length ? Math.round(avg(recent) * 10) / 10 : null,
    weeks: [...byWeek].map(([weekOf, ws]) => ({ weekOf, average: Math.round(avg(ws) * 10) / 10 })),
  };
}

async function weighInsAllowed(memberId: number): Promise<boolean> {
  if (await isTeen(memberId)) throw new HttpError(403, 'Weigh-ins aren’t part of teen mode', 'teen');
  const { rows } = await pool.query<{ weigh_ins: boolean }>('SELECT weigh_ins FROM health_profiles WHERE member_id = $1', [memberId]);
  return rows[0]?.weigh_ins ?? false;
}

programRouter.get('/api/weigh-ins', async (req, res) => {
  const member = await targetMember(req);
  res.json(await weighInSummary(member.id, await weighInsAllowed(member.id)));
});

/** Turn weigh-ins on or off (off by default). */
programRouter.put('/api/weigh-ins', async (req, res) => {
  const member = await targetMember(req);
  await weighInsAllowed(member.id);
  const enabled = bool((req.body as { enabled?: unknown }).enabled, 'enabled');
  await pool.query(
    `INSERT INTO health_profiles (member_id, plan_start, weigh_ins) VALUES ($1, $2, $3)
     ON CONFLICT (member_id) DO UPDATE SET weigh_ins = EXCLUDED.weigh_ins`,
    [member.id, today(), enabled],
  );
  res.json(await weighInSummary(member.id, enabled));
});

/** Log today's weight. The answer is the 7-day average — never the raw number back. */
programRouter.post('/api/weigh-ins', async (req, res) => {
  const member = await targetMember(req);
  if (!(await weighInsAllowed(member.id))) throw new HttpError(409, 'Turn weigh-ins on first', 'weigh_ins_off');
  const b = req.body as { weightLb?: unknown; day?: unknown };
  const t = today();
  const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && b.day <= t && b.day > addDays(t, -14) ? b.day : t;
  await pool.query(
    `INSERT INTO weigh_ins (member_id, day, weight_lb) VALUES ($1, $2, $3)
     ON CONFLICT (member_id, day) DO UPDATE SET weight_lb = EXCLUDED.weight_lb`,
    [member.id, day, int(b.weightLb, 'weightLb', 50, 700)],
  );
  res.status(201).json(await weighInSummary(member.id, true));
});
