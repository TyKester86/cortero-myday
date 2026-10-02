/**
 * Body-style programs: a 52-week, phased plan per build, generated from the
 * training + nutrition rules in the build spec (README "Programs").
 *
 *   Foundation 8–12 wk → Hypertrophy 12–24 wk → (optional) Strength 4–8 wk
 *   → Cut 8–16 wk → Maintenance 2–4 wk.   Beginners: 16 wk recomp first.
 *
 * Hypertrophy: 6–12 reps @ 65–85%, 1–3 min rest, 10–20 sets/muscle/week
 * (never > 26), each muscle 2×/week, double progression on isolation and
 * linear on compounds, deload (≈50% volume) every 5th week. Strength: 1–5
 * reps @ 80–95%, 3–5 min rest. Cuts keep the weight heavy and trim volume
 * 20% in the late weeks.
 */
import {
  BUILD_INFO,
  PROTEIN_G_PER_LB,
  type BuildKey,
  type Macros,
  type NutritionMode,
  type PhaseKind,
  type ProgramPhase,
  type TrainingLevel,
} from '@myday/shared';

export type Muscle = 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'core';

interface Exercise {
  name: string;
  muscle: Muscle;
  compound: boolean;
  equipment: string;
  cues: string;
  subs: string;
}

const X = (name: string, muscle: Muscle, compound: boolean, equipment: string, cues: string, subs: string): Exercise => ({
  name,
  muscle,
  compound,
  equipment,
  cues,
  subs,
});

const LIB = {
  bench: X('Bench press', 'chest', true, 'Barbell + bench', 'Shoulder blades pinned, feet planted, bar to mid-chest', 'Dumbbell bench press'),
  incline: X('Incline dumbbell press', 'chest', true, 'Dumbbells + incline bench', '30° bench, elbows ~45°, full stretch', 'Incline machine press'),
  fly: X('Cable fly', 'chest', false, 'Cable station', 'Soft elbows, hug a tree, squeeze', 'Pec deck'),
  pushup: X('Push-up', 'chest', true, 'Bodyweight', 'Rigid plank, chest to fist height', 'Incline push-up'),
  row: X('Barbell row', 'back', true, 'Barbell', 'Flat back, pull to lower ribs', 'Chest-supported row'),
  pulldown: X('Lat pulldown', 'back', true, 'Cable station', 'Lead with elbows, bar to upper chest', 'Assisted pull-up'),
  pullup: X('Pull-up', 'back', true, 'Pull-up bar', 'Full hang, chin over bar, no swing', 'Lat pulldown'),
  cableRow: X('Seated cable row', 'back', true, 'Cable station', 'Tall chest, squeeze shoulder blades', 'Dumbbell row'),
  ohp: X('Overhead press', 'shoulders', true, 'Barbell', 'Squeeze glutes, bar path close to face', 'Seated dumbbell press'),
  dbPress: X('Seated dumbbell press', 'shoulders', true, 'Dumbbells + bench', 'Ribs down, press to just short of lockout', 'Machine shoulder press'),
  lateral: X('Lateral raise', 'shoulders', false, 'Dumbbells', 'Lead with elbows, stop at shoulder height', 'Cable lateral raise'),
  rearDelt: X('Rear-delt fly', 'shoulders', false, 'Dumbbells', 'Hinge forward, sweep wide, pause', 'Reverse pec deck'),
  curl: X('Dumbbell curl', 'biceps', false, 'Dumbbells', 'Elbows pinned, slow lower', 'Cable curl'),
  hammer: X('Hammer curl', 'biceps', false, 'Dumbbells', 'Neutral grip, no swing', 'Rope curl'),
  pressdown: X('Triceps pressdown', 'triceps', false, 'Cable + rope', 'Elbows tucked, spread rope at bottom', 'Dip machine'),
  skull: X('Overhead triceps extension', 'triceps', false, 'Cable or dumbbell', 'Deep stretch behind head', 'Skull crusher'),
  squat: X('Back squat', 'quads', true, 'Barbell + rack', 'Brace, sit between hips, knees track toes', 'Goblet squat'),
  goblet: X('Goblet squat', 'quads', true, 'Dumbbell or kettlebell', 'Elbows inside knees, chest up', 'Leg press'),
  legPress: X('Leg press', 'quads', true, 'Leg press machine', 'Low back flat, full depth you own', 'Hack squat'),
  rdl: X('Romanian deadlift', 'hamstrings', true, 'Barbell', 'Hinge, soft knees, bar close, flat back', 'Dumbbell RDL'),
  deadlift: X('Deadlift', 'hamstrings', true, 'Barbell', 'Wedge in, push the floor away, lockout with glutes', 'Trap-bar deadlift'),
  legCurl: X('Leg curl', 'hamstrings', false, 'Leg curl machine', 'Hips down, slow lower', 'Nordic curl (assisted)'),
  hipThrust: X('Hip thrust', 'glutes', true, 'Barbell + bench', 'Chin tucked, ribs down, full lockout squeeze', 'Glute bridge'),
  abduction: X('Cable hip abduction', 'glutes', false, 'Cable or machine', 'Slight forward lean, slow out and back', 'Banded abduction'),
  split: X('Bulgarian split squat', 'glutes', true, 'Dumbbells + bench', 'Long stance, lean slightly forward', 'Reverse lunge'),
  bridge: X('Glute bridge', 'glutes', false, 'Barbell or bodyweight', 'Drive through heels, 2-second squeeze', 'Single-leg glute bridge'),
  kickback: X('Cable kickback', 'glutes', false, 'Cable + ankle strap', 'Square hips, kick back and up', 'Banded kickback'),
  calf: X('Standing calf raise', 'calves', false, 'Machine or step', 'Full stretch, pause at top', 'Seated calf raise'),
  plank: X('Plank', 'core', false, 'Bodyweight', 'Squeeze glutes, ribs down', 'Dead bug'),
  hangLeg: X('Hanging knee raise', 'core', false, 'Pull-up bar', 'Curl pelvis up, no swing', 'Reverse crunch'),
} as const;

type ExKey = keyof typeof LIB;
interface DayTemplate {
  name: string;
  items: Array<[ExKey, number]>; // [exercise, hypertrophy sets]
}

interface BuildTemplate {
  /** ISO weekdays the lifting days fall on (in order). */
  weekdays: number[];
  days: DayTemplate[];
  /** Muscles this look prioritizes (checked: 10–20 sets/week in hypertrophy). */
  priority: Muscle[];
  /** Hypertrophy weekly gain target, % bodyweight (0.25–0.5). */
  gainPct: number;
  /** Cut weekly loss target, % bodyweight (0.5–0.7). */
  cutPct: number;
  /** Weeks per phase for experienced lifters: [foundation, hypertrophy, strength, cut, maintenance] = 52. */
  weeks: [number, number, number, number, number];
  cardio: { gaining: string; cutting: string; base: string };
}

const EASY = '20–30 min easy, conversational pace';
const STANDARD_CARDIO = {
  gaining: `2–3 easy cardio sessions/week (${EASY}). Keep cardio 6+ hours from lifting.`,
  cutting: `4–6 easy sessions + 1–2 hard interval sessions/week (e.g. 8 × 30 s hard / 90 s easy). Keep cardio 6+ hours from lifting.`,
  base: `2–3 easy cardio sessions/week (${EASY}). Keep cardio 6+ hours from lifting.`,
};
const GLUTE_CARDIO = {
  gaining: '2–3 incline walks or stairmill sessions/week, 20–30 min easy. Keep cardio 6+ hours from lifting.',
  cutting: '4–6 incline walks/stairmill sessions (25–40 min easy) + 1–2 hard stairmill intervals/week. Keep cardio 6+ hours from lifting.',
  base: '2–3 incline walks or stairmill sessions/week, 20–30 min easy. Keep cardio 6+ hours from lifting.',
};
const RUNNER_CARDIO = {
  gaining: 'Running leads: 4 runs/week — 3 easy (30–45 min) + 1 tempo (20 min at comfortably hard). Lift on non-hard-run days, 6+ hours apart.',
  cutting: 'Running leads: 5 runs/week — 4 easy (30–50 min) + 1 interval session (6 × 3 min hard / 2 min easy). Lift 6+ hours from runs.',
  base: 'Running leads: 3–4 easy runs/week building 10% per week, plus strides. Lift 6+ hours from runs.',
};

const UL: Pick<BuildTemplate, 'weekdays'> = { weekdays: [1, 2, 4, 5] };

const TEMPLATES: Record<BuildKey, BuildTemplate> = {
  // Men
  lean_athletic: {
    ...UL,
    days: [
      { name: 'Upper A (chest + delts)', items: [['bench', 3], ['pulldown', 3], ['incline', 4], ['lateral', 4], ['curl', 3], ['pressdown', 3]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 3], ['calf', 3], ['plank', 3]] },
      { name: 'Upper B (lats + arms)', items: [['ohp', 3], ['pullup', 4], ['cableRow', 3], ['fly', 3], ['lateral', 3], ['curl', 3], ['hammer', 4], ['skull', 4], ['pressdown', 3]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 3], ['legCurl', 3], ['calf', 3], ['hangLeg', 3]] },
    ],
    priority: ['shoulders', 'chest', 'back', 'biceps', 'triceps'],
    gainPct: 0.25,
    cutPct: 0.7,
    weeks: [10, 16, 6, 16, 4],
    cardio: STANDARD_CARDIO,
  },
  v_taper: {
    weekdays: [1, 2, 4, 5, 6],
    days: [
      { name: 'Upper A (delts + lats)', items: [['ohp', 3], ['pulldown', 4], ['incline', 4], ['lateral', 3], ['curl', 3]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 2], ['calf', 3]] },
      { name: 'Upper B (chest + back width)', items: [['bench', 3], ['pullup', 3], ['cableRow', 3], ['fly', 3], ['lateral', 3], ['pressdown', 3]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 2], ['legCurl', 3], ['calf', 3], ['hangLeg', 3]] },
      { name: 'Arms + delts', items: [['lateral', 3], ['rearDelt', 2], ['curl', 3], ['hammer', 4], ['pressdown', 3], ['skull', 4]] },
    ],
    priority: ['shoulders', 'back', 'chest', 'biceps', 'triceps'],
    gainPct: 0.35,
    cutPct: 0.6,
    weeks: [10, 20, 6, 12, 4],
    cardio: STANDARD_CARDIO,
  },
  thick_powerful: {
    weekdays: [1, 2, 3, 5, 6],
    days: [
      { name: 'Heavy lower', items: [['squat', 4], ['rdl', 3], ['legPress', 3], ['calf', 4]] },
      { name: 'Heavy upper', items: [['bench', 4], ['row', 4], ['ohp', 3], ['pulldown', 3]] },
      { name: 'Volume lower', items: [['deadlift', 3], ['legPress', 3], ['split', 3], ['legCurl', 4], ['hipThrust', 3], ['plank', 3]] },
      { name: 'Volume upper', items: [['incline', 4], ['cableRow', 4], ['dbPress', 3], ['lateral', 3], ['curl', 3], ['pressdown', 3]] },
      { name: 'Arms + delts', items: [['lateral', 4], ['rearDelt', 3], ['hammer', 3], ['skull', 3], ['pushup', 3]] },
    ],
    priority: ['back', 'quads', 'chest', 'hamstrings'],
    gainPct: 0.5,
    cutPct: 0.5,
    weeks: [8, 24, 8, 8, 4],
    cardio: STANDARD_CARDIO,
  },
  shredded: {
    ...UL,
    days: [
      { name: 'Upper A', items: [['bench', 4], ['row', 4], ['ohp', 3], ['lateral', 4], ['curl', 3], ['pressdown', 3]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 3], ['calf', 3], ['hangLeg', 3]] },
      { name: 'Upper B', items: [['incline', 3], ['pullup', 3], ['cableRow', 3], ['fly', 3], ['lateral', 3], ['hammer', 3], ['skull', 3]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 3], ['legCurl', 3], ['calf', 3], ['plank', 3]] },
    ],
    priority: ['chest', 'back', 'shoulders'],
    gainPct: 0.25,
    cutPct: 0.7,
    weeks: [10, 18, 4, 16, 4],
    cardio: STANDARD_CARDIO,
  },
  strong_dense: {
    ...UL,
    days: [
      { name: 'Squat + bench', items: [['squat', 4], ['bench', 4], ['row', 3], ['pushup', 3], ['plank', 3]] },
      { name: 'Deadlift + press', items: [['deadlift', 3], ['ohp', 4], ['pullup', 3], ['legCurl', 3]] },
      { name: 'Bench + squat (volume)', items: [['bench', 3], ['goblet', 3], ['cableRow', 3], ['pressdown', 3], ['curl', 3]] },
      { name: 'Hinge + press (volume)', items: [['rdl', 3], ['legPress', 3], ['dbPress', 3], ['pulldown', 3], ['hipThrust', 3], ['calf', 3]] },
    ],
    priority: ['back', 'chest', 'quads'],
    gainPct: 0.35,
    cutPct: 0.5,
    weeks: [8, 20, 8, 12, 4],
    cardio: STANDARD_CARDIO,
  },
  // Women
  toned_athletic: {
    weekdays: [1, 3, 5],
    days: [
      { name: 'Full body A', items: [['goblet', 3], ['bench', 3], ['pulldown', 4], ['hipThrust', 3], ['lateral', 3], ['plank', 3]] },
      { name: 'Full body B', items: [['rdl', 3], ['dbPress', 3], ['cableRow', 3], ['split', 3], ['pressdown', 2], ['hangLeg', 3]] },
      { name: 'Full body C', items: [['legPress', 3], ['incline', 3], ['pullup', 3], ['legCurl', 3], ['curl', 2], ['calf', 3]] },
    ],
    priority: ['back'],
    gainPct: 0.25,
    cutPct: 0.5,
    weeks: [12, 20, 0, 16, 4],
    cardio: {
      gaining: '3 cardio sessions/week: 2 easy (30 min) + 1 harder (20 min intervals). Keep cardio 6+ hours from lifting.',
      cutting: STANDARD_CARDIO.cutting,
      base: '3 cardio sessions/week, 25–30 min, mostly easy. Keep cardio 6+ hours from lifting.',
    },
  },
  hourglass: {
    weekdays: [1, 2, 3, 5, 6],
    days: [
      // Every lower day has BOTH a hip thrust and a squat pattern (the research is split; we do both).
      { name: 'Lower A (glutes)', items: [['hipThrust', 4], ['squat', 3], ['rdl', 3], ['abduction', 3]] },
      { name: 'Upper A (shoulders + back)', items: [['dbPress', 3], ['pulldown', 3], ['lateral', 3], ['cableRow', 3], ['pressdown', 2]] },
      { name: 'Lower B (glutes)', items: [['hipThrust', 3], ['goblet', 3], ['split', 3], ['legCurl', 3]] },
      { name: 'Upper B (back + arms)', items: [['incline', 3], ['pullup', 3], ['lateral', 3], ['rearDelt', 2], ['curl', 2]] },
      { name: 'Lower C (glutes)', items: [['bridge', 3], ['legPress', 3], ['abduction', 3]] },
    ],
    priority: ['glutes'],
    gainPct: 0.35,
    cutPct: 0.5,
    weeks: [10, 24, 0, 14, 4],
    cardio: GLUTE_CARDIO,
  },
  strong_curvy: {
    ...UL,
    days: [
      { name: 'Upper A (shoulders + back)', items: [['ohp', 3], ['row', 3], ['lateral', 4], ['pulldown', 3], ['curl', 2], ['pressdown', 2]] },
      { name: 'Lower A', items: [['squat', 3], ['hipThrust', 3], ['rdl', 3], ['abduction', 3]] },
      { name: 'Upper B (back + shoulders)', items: [['dbPress', 3], ['pullup', 3], ['cableRow', 3], ['lateral', 3], ['rearDelt', 3]] },
      { name: 'Lower B', items: [['legPress', 3], ['split', 3], ['legCurl', 3], ['bridge', 3], ['calf', 3]] },
    ],
    priority: ['shoulders', 'back', 'glutes'],
    gainPct: 0.35,
    cutPct: 0.5,
    weeks: [10, 20, 6, 12, 4],
    cardio: STANDARD_CARDIO,
  },
  lean_runner: {
    weekdays: [2, 5],
    days: [
      { name: 'Strength A (runner)', items: [['goblet', 3], ['rdl', 3], ['split', 2], ['pulldown', 3], ['pushup', 2], ['plank', 3]] },
      { name: 'Strength B (runner)', items: [['legPress', 3], ['hipThrust', 3], ['legCurl', 2], ['cableRow', 3], ['calf', 3], ['hangLeg', 2]] },
    ],
    priority: [],
    gainPct: 0.25,
    cutPct: 0.5,
    weeks: [12, 20, 0, 16, 4],
    cardio: RUNNER_CARDIO,
  },
};

export function trainWeekdays(build: BuildKey): number[] {
  return TEMPLATES[build].weekdays;
}

export function priorityMuscles(build: BuildKey): Muscle[] {
  return TEMPLATES[build].priority;
}

/** The year's phases, with deload weeks broken out (every 5th week of a training block). */
export function buildPhases(build: BuildKey, level: TrainingLevel): ProgramPhase[] {
  const t = TEMPLATES[build];
  const out: ProgramPhase[] = [];
  let week = 1;
  const add = (kind: PhaseKind, name: string, weeks: number, nutrition: NutritionMode, focus: string, pct: number): void => {
    if (weeks <= 0) return;
    out.push({ kind, name, weekStart: week, weekEnd: week + weeks - 1, nutrition, focus, weeklyChangePct: pct });
    week += weeks;
  };
  /** A training block with a deload after every 4 hard weeks. */
  const block = (kind: PhaseKind, name: string, weeks: number, nutrition: NutritionMode, focus: string, pct: number): void => {
    let left = weeks;
    while (left > 0) {
      const hard = Math.min(4, left);
      add(kind, name, hard, nutrition, focus, pct);
      left -= hard;
      if (left > 0) {
        add('deload', 'Deload', 1, nutrition, 'Same exercises, about half the sets, lighter. Recover, then push again.', pct);
        left -= 1;
      }
    }
  };
  const [foundation, hyper, strength, cut, maint] = t.weeks;
  if (level === 'beginner') {
    // Beginners: ~4 months of recomp at maintenance first, then one gain + one cut.
    add('foundation', 'Foundation (recomp)', 16, 'recomp', 'Learn the lifts, add weight steadily, eat at maintenance with high protein.', 0);
    block('hypertrophy', 'Hypertrophy', 16, 'gaining', 'Build muscle in a small surplus. Beat last week by a rep or a little weight.', t.gainPct);
    const cutLate = Math.round(16 * 0.4);
    add('cut', 'Cut', 16 - cutLate, 'cutting', 'Keep the weights heavy; lose fat slowly.', -t.cutPct);
    add('cut', 'Cut (late — trimmed volume)', cutLate, 'cutting', 'Same heavy weights, about 20% fewer sets to recover in the deficit.', -t.cutPct);
    add('maintenance', 'Maintenance', 52 - week + 1, 'maintenance', 'Hold your new body at maintenance calories. Enjoy it.', 0);
    return out;
  }
  add('foundation', 'Foundation', foundation, 'maintenance', 'Groove technique and work capacity at maintenance calories.', 0);
  block('hypertrophy', 'Hypertrophy', hyper, 'gaining', 'Build muscle in a small surplus. Beat last week by a rep or a little weight.', t.gainPct);
  if (strength > 0) add('strength', 'Strength block', strength, 'gaining', 'Heavy 1–5 rep work on the big lifts; accessories stay moderate.', 0.25);
  const cutLate = Math.round(cut * 0.4);
  add('cut', 'Cut', cut - cutLate, 'cutting', 'Keep the weights heavy; lose fat slowly.', -t.cutPct);
  add('cut', 'Cut (late — trimmed volume)', cutLate, 'cutting', 'Same heavy weights, about 20% fewer sets to recover in the deficit.', -t.cutPct);
  add('maintenance', 'Maintenance', maint, 'maintenance', 'Hold your new body at maintenance calories.', 0);
  return out;
}

export function cardioFor(build: BuildKey, phase: ProgramPhase): string {
  const c = TEMPLATES[build].cardio;
  if (phase.nutrition === 'cutting') return c.cutting;
  if (phase.nutrition === 'gaining') return c.gaining;
  return c.base;
}

export interface WorkoutRow {
  phaseId: string;
  phaseName: string;
  weekStart: number;
  weekEnd: number;
  dayNum: number;
  dayName: string;
  exercise: string;
  muscle: Muscle;
  sets: number;
  reps: string;
  rest: string;
  equipment: string;
  cues: string;
  subs: string;
  focus: string;
}

/** Sets/reps/rest for one exercise in one phase. */
function dose(kind: PhaseKind, ex: Exercise, baseSets: number, late: boolean, position: number): { sets: number; reps: string; rest: string } {
  switch (kind) {
    case 'strength':
      return ex.compound
        ? { sets: Math.max(3, baseSets), reps: '3–5 @ 80–95% (top set 1–3)', rest: '3–5 min' }
        : { sets: Math.max(2, baseSets - 1), reps: '8–12', rest: '1–2 min' };
    case 'deload':
      // About half the sets: alternate rounding up/down across the day so the week lands near 50%.
      return {
        sets: Math.max(1, position % 2 === 0 ? Math.ceil(baseSets / 2) : Math.floor(baseSets / 2)),
        reps: ex.compound ? '6–8 @ ~65%' : '10–12 light',
        rest: '1–2 min',
      };
    case 'foundation':
      return { sets: Math.max(2, baseSets - 1), reps: ex.compound ? '8–10 @ ~65–70%' : '12', rest: ex.compound ? '2 min' : '1 min' };
    case 'maintenance':
      return { sets: Math.max(2, Math.round(baseSets * 0.7)), reps: ex.compound ? '6–10 @ 70–80%' : '10–12', rest: ex.compound ? '2 min' : '1 min' };
    case 'cut': {
      const sets = late ? Math.max(2, Math.round(baseSets * 0.8)) : baseSets;
      return { sets, reps: ex.compound ? '6–8 @ 75–85% (keep it heavy)' : '10–12', rest: ex.compound ? '2–3 min' : '1–1.5 min' };
    }
    default:
      return ex.compound
        ? { sets: baseSets, reps: '6–8 @ 70–85% (add weight when all sets hit 8)', rest: '2–3 min' }
        : { sets: baseSets, reps: '10–12 (double progression: reps, then weight)', rest: '1–1.5 min' };
  }
}

/** Every workout row of the 52-week program. */
export function programRows(build: BuildKey, phases: ProgramPhase[]): WorkoutRow[] {
  const t = TEMPLATES[build];
  const rows: WorkoutRow[] = [];
  phases.forEach((p, idx) => {
    const late = p.name.includes('late');
    t.days.forEach((d, i) => {
      d.items.forEach(([key, baseSets], position) => {
        const ex = LIB[key];
        const { sets, reps, rest } = dose(p.kind, ex, baseSets, late, position);
        rows.push({
          phaseId: `P${idx + 1}`,
          phaseName: p.name,
          weekStart: p.weekStart,
          weekEnd: p.weekEnd,
          dayNum: i + 1,
          dayName: d.name,
          exercise: ex.name,
          muscle: ex.muscle,
          sets,
          reps,
          rest,
          equipment: ex.equipment,
          cues: ex.cues,
          subs: ex.subs,
          focus: p.focus,
        });
      });
    });
  });
  return rows;
}

/** Hard sets per muscle per week for the rows of one phase. */
export function weeklySets(rows: WorkoutRow[]): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const r of rows) out[r.muscle] = (out[r.muscle] ?? 0) + r.sets;
  return out;
}

/** Days per week each muscle is trained (frequency) for the rows of one phase. */
export function weeklyFrequency(rows: WorkoutRow[]): Partial<Record<Muscle, number>> {
  const days = new Map<Muscle, Set<number>>();
  for (const r of rows) days.set(r.muscle, (days.get(r.muscle) ?? new Set()).add(r.dayNum));
  const out: Partial<Record<Muscle, number>> = {};
  for (const [m, s] of days) out[m] = s.size;
  return out;
}

/**
 * Daily macros. Maintenance calories are estimated at bodyweight × 15 kcal
 * (a standard moderately-active estimate); the phase's weekly weight change
 * (% of bodyweight, 3,500 kcal per lb) sets the surplus or deficit. Protein
 * from PROTEIN_G_PER_LB, fat 0.35 g/lb, carbs fill the rest.
 */
export function macrosFor(bodyweightLb: number, phase: ProgramPhase): Macros {
  const maintenance = bodyweightLb * 15;
  const deltaPerDay = ((bodyweightLb * phase.weeklyChangePct) / 100) * (3500 / 7);
  const calories = Math.round((maintenance + deltaPerDay) / 10) * 10;
  const protein = Math.round(bodyweightLb * PROTEIN_G_PER_LB[phase.nutrition].target);
  const fat = Math.round(bodyweightLb * 0.35);
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { calories, protein, carbs, fat };
}

export function weekOf(phases: ProgramPhase[], week: number): ProgramPhase {
  const hit = phases.find((p) => week >= p.weekStart && week <= p.weekEnd);
  const last = phases[phases.length - 1];
  const first = phases[0];
  if (hit) return hit;
  if (last && week > last.weekEnd) return last;
  if (first) return first;
  throw new Error('program has no phases');
}

export const defaultFoodProtein = (build: BuildKey): number => BUILD_INFO[build].foodProteinDefault;
