/**
 * Body-style programs: a 52-week, phased plan per build, generated from the
 * evidence in "Evidence for the nine body builds" (docs).
 *
 *   Every build has its own year map (Thick & Powerful lives in a surplus,
 *   Lean Runner at maintenance, Shredded needs a base first). Every year
 *   starts with "First 28 days": short sessions, attendance is the goal.
 *
 * Training: compounds 6–12 reps at 1–3 RIR, isolation 10–20 at 0–2 RIR,
 * strength 3–5 at 1–3 RIR; double progression. Sets are counted
 * fractionally (a press is ½ a set for triceps), capped at 25 per muscle per
 * week and ~11 per session; beginners ramp from ~4–8. Deloads every 6 weeks
 * (8 for beginners) or on demand; cuts hold load, effort and volume.
 * Exercise variants rotate every 3–4 weeks; main lifts never rotate.
 *
 * Food: Mifflin-St Jeor × activity, recalibrated from the weigh-in trend;
 * deficits capped at 500 kcal/day (≤1%/wk), floors of 1,200 / 1,500 kcal;
 * protein, fat and shakes scale with reference weight.
 */
import {
  BUILD_INFO,
  CALORIE_FLOOR,
  MAX_DEFICIT_KCAL,
  MAX_DEFICIT_KCAL_HIGHER_BF,
  PROTEIN_G_PER_LB,
  bmiOf,
  maintenanceCalories,
  referenceWeightLb,
  type BodyInputs,
  type BuildKey,
  type EnergyMath,
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
  /** Muscles that get half a set from it (a bench press is ½ a set for triceps and front delts). */
  secondary: Muscle[];
  compound: boolean;
  /** Jumps and hops: low contacts, full rest, never taken near failure. */
  power: boolean;
  equipment: string;
  cues: string;
  /** Tiers: the easier / no-barbell / no-machine version of the same movement. */
  subs: string;
}

const X = (name: string, muscle: Muscle, compound: boolean, equipment: string, cues: string, subs: string, secondary: Muscle[] = [], power = false): Exercise => ({
  name,
  muscle,
  secondary,
  compound,
  power,
  equipment,
  cues,
  subs,
});

const LIB = {
  // Chest
  bench: X('Bench press', 'chest', true, 'Barbell + bench', 'Shoulder blades pinned, feet planted, bar to mid-chest', 'Dumbbell bench press · Push-up (no bench)', ['triceps', 'shoulders']),
  incline: X('Incline dumbbell press', 'chest', true, 'Dumbbells + incline bench', '30° bench, elbows ~45°, full stretch', 'Incline machine press · Smith machine incline press', ['shoulders', 'triceps']),
  smithIncline: X('Smith machine incline press', 'chest', true, 'Smith machine + incline bench', '30° bench, bar to upper chest, control the stretch', 'Incline dumbbell press', ['shoulders', 'triceps']),
  machinePress: X('Machine chest press', 'chest', true, 'Chest press machine', 'Handles at mid-chest, slow 2-second lower', 'Bench press · Push-up', ['triceps', 'shoulders']),
  fly: X('Cable fly', 'chest', false, 'Cable station', 'Soft elbows, hug a tree, squeeze', 'Pec deck · Dumbbell fly'),
  pushup: X('Push-up', 'chest', true, 'Bodyweight', 'Rigid plank, chest to fist height', 'Incline push-up (easier)', ['triceps', 'shoulders']),
  // Back
  row: X('Barbell row', 'back', true, 'Barbell', 'Flat back, pull to lower ribs', 'Chest-supported row · Dumbbell row', ['biceps', 'shoulders']),
  pulldown: X('Lat pulldown', 'back', true, 'Cable station', 'Lead with elbows, bar to upper chest', 'Pull-up (harder) · Band pulldown', ['biceps']),
  pullup: X('Pull-up', 'back', true, 'Pull-up bar', 'Full hang, chin over bar, no swing', 'Assisted pull-up · Lat pulldown', ['biceps']),
  cableRow: X('Seated cable row', 'back', true, 'Cable station', 'Tall chest, squeeze shoulder blades', 'Dumbbell row', ['biceps']),
  shrug: X('Dumbbell shrug', 'back', false, 'Dumbbells', 'Straight up toward the ears, 1-second hold, no rolling', "Farmer's carry · Barbell shrug"),
  // Shoulders
  ohp: X('Overhead press', 'shoulders', true, 'Barbell', 'Squeeze glutes, bar path close to face', 'Seated dumbbell press', ['triceps']),
  dbPress: X('Seated dumbbell press', 'shoulders', true, 'Dumbbells + bench', 'Ribs down, press to just short of lockout', 'Machine shoulder press', ['triceps']),
  lateral: X('Lateral raise', 'shoulders', false, 'Dumbbells', 'Lead with elbows, stop at shoulder height', 'Cable lateral raise'),
  rearDelt: X('Rear-delt fly', 'shoulders', false, 'Dumbbells', 'Hinge forward, sweep wide, pause', 'Reverse pec deck · Face pull'),
  facePull: X('Face pull', 'shoulders', false, 'Cable + rope', 'Pull to eyebrows, elbows high, thumbs back', 'Rear-delt fly · Band pull-apart', ['back']),
  // Arms
  curl: X('Dumbbell curl', 'biceps', false, 'Dumbbells', 'Elbows pinned, slow lower', 'Cable curl'),
  inclineCurl: X('Incline dumbbell curl', 'biceps', false, 'Dumbbells + incline bench', 'Arms hang behind you, full stretch, no swing', 'Dumbbell curl'),
  hammer: X('Hammer curl', 'biceps', false, 'Dumbbells', 'Neutral grip, no swing', 'Rope curl'),
  pressdown: X('Triceps pressdown', 'triceps', false, 'Cable + rope', 'Elbows tucked, spread rope at bottom', 'Dip machine'),
  skull: X('Overhead triceps extension', 'triceps', false, 'Cable or dumbbell', 'Deep stretch behind head', 'Skull crusher'),
  // Legs
  squat: X('Back squat', 'quads', true, 'Barbell + rack', 'Brace, sit deep between the hips, knees track toes', 'Goblet squat (easier) · Leg press (no barbell)', ['glutes']),
  goblet: X('Goblet squat', 'quads', true, 'Dumbbell or kettlebell', 'Elbows inside knees, chest up, sit deep', 'Leg press · Back squat (harder)', ['glutes']),
  legPress: X('Leg press', 'quads', true, 'Leg press machine', 'Low back flat, full depth you own', 'Hack squat · Goblet squat', ['glutes']),
  legExt: X('Leg extension', 'quads', false, 'Leg extension machine', 'Lean back a little, squeeze at the top, slow lower', 'Reverse Nordic · Spanish squat'),
  rdl: X('Romanian deadlift', 'hamstrings', true, 'Barbell', 'Hinge, soft knees, bar close, flat back', 'Dumbbell RDL', ['glutes']),
  deadlift: X('Deadlift', 'hamstrings', true, 'Barbell', 'Wedge in, push the floor away, lockout with glutes', 'Trap-bar deadlift', ['glutes', 'back']),
  legCurl: X('Seated leg curl', 'hamstrings', false, 'Seated leg curl machine', 'Lean forward over the pad, full stretch, slow lower', 'Lying leg curl · Nordic curl (assisted)'),
  hipThrust: X('Hip thrust', 'glutes', true, 'Barbell + bench', 'Chin tucked, ribs down, full lockout squeeze', 'Glute bridge (easier) · Smith machine hip thrust'),
  smithThrust: X('Smith machine hip thrust', 'glutes', true, 'Smith machine + bench', 'Chin tucked, ribs down, pause at the top', 'Hip thrust'),
  abduction: X('Cable hip abduction', 'glutes', false, 'Cable + ankle strap', 'Slight forward lean, slow out and back', 'Hip abduction machine · Banded abduction'),
  abductionMachine: X('Hip abduction machine', 'glutes', false, 'Abduction machine', 'Lean forward a little, push out, 1-second hold', 'Cable hip abduction'),
  split: X('Bulgarian split squat', 'glutes', true, 'Dumbbells + bench', 'Long stance, lean slightly forward', 'Reverse lunge (easier)', ['quads']),
  lunge: X('Dumbbell walking lunge', 'glutes', true, 'Dumbbells', 'Long steps, back knee kisses the floor', 'Reverse lunge', ['quads']),
  bridge: X('Glute bridge', 'glutes', false, 'Barbell or bodyweight', 'Drive through heels, 2-second squeeze', 'Single-leg glute bridge'),
  kickback: X('Cable kickback', 'glutes', false, 'Cable + ankle strap', 'Square hips, kick back and up', 'Banded kickback'),
  calf: X('Standing calf raise', 'calves', false, 'Machine or step', 'Full stretch at the bottom, pause at the top', 'Single-leg calf raise on a step'),
  seatedCalf: X('Seated calf raise', 'calves', false, 'Seated calf machine', 'Knees bent (works the soleus), full stretch, pause', 'Bent-knee calf raise on a step'),
  // Core + carries
  plank: X('Plank', 'core', false, 'Bodyweight', 'Squeeze glutes, ribs down', 'Dead bug'),
  deadBug: X('Dead bug', 'core', false, 'Bodyweight', 'Low back glued down, slow opposite arm + leg', 'Plank'),
  hangLeg: X('Hanging knee raise', 'core', false, 'Pull-up bar', 'Curl pelvis up, no swing', 'Reverse crunch'),
  crunch: X('Cable crunch', 'core', false, 'Cable + rope', 'Hips still, curl ribs toward hips, slow back up', 'Weighted crunch'),
  carry: X("Farmer's carry", 'core', false, 'Heavy dumbbells or kettlebells', 'Tall, shoulders down, short quick steps', 'Suitcase carry (one hand)', ['back']),
  // Plyometrics (runners)
  boxJump: X('Box jump', 'quads', false, 'Box or step', 'Soft, quiet landing; step down, never jump down', 'Squat jump (no box)', [], true),
  pogo: X('Pogo hops', 'calves', false, 'Bodyweight', 'Stiff ankles, quick light contacts, tall posture', 'Jump rope', [], true),
} as const;

type ExKey = keyof typeof LIB;

/** Exercise variants rotated in every 3–4 weeks (novelty, fresh progress) — never on a build's main lifts. */
const ROTATE: Partial<Record<ExKey, ExKey>> = {
  curl: 'inclineCurl',
  abduction: 'abductionMachine',
  split: 'lunge',
  rearDelt: 'facePull',
  incline: 'smithIncline',
  bench: 'machinePress',
  hipThrust: 'smithThrust',
  plank: 'deadBug',
};

interface DayTemplate {
  name: string;
  items: Array<[ExKey, number]>; // [exercise, full-dose sets]
  /** Heavy day: compounds at 3–6 reps (weekly undulating heavy/volume mix). */
  heavy?: boolean;
}

type Style = 'standard' | 'runner';

interface BuildTemplate {
  /** ISO weekdays the lifting days fall on (in order). */
  weekdays: number[];
  days: DayTemplate[];
  /** Muscles this look prioritizes (checked: 10–25 fractional sets/week at full dose). */
  priority: Muscle[];
  /** Main lifts: practised heavy, never rotated. */
  main: ExKey[];
  style: Style;
  cardio: { gaining: string; cutting: string; base: string; race?: string };
}

const STEPS = 'Daily steps: aim for 8–10k.';
const STANDARD_CARDIO = {
  gaining: `${STEPS} Plus 1–2 easy cardio sessions/week (20–30 min; cycling or walking is kindest to leg days). Keep hard cardio away from leg days.`,
  cutting: `${STEPS} Plus 1–2 interval sessions/week (e.g. 8 × 30 s hard / 90 s easy). Cardio counts inside your calorie target — never eat less to “make room”.`,
  base: `${STEPS} Plus 1–2 easy cardio sessions/week (20–30 min). Keep hard cardio away from leg days.`,
};
const GLUTE_CARDIO = {
  gaining: `${STEPS} Plus 1–2 incline walks or bike sessions/week, 20–30 min easy. Keep them away from lower days.`,
  cutting: `${STEPS} Plus 1–2 incline walks and 1 interval session/week. Cardio counts inside your calorie target — never eat less to “make room”.`,
  base: `${STEPS} Plus 1–2 incline walks or bike sessions/week, 20–30 min easy.`,
};
const LIGHT_CARDIO = {
  gaining: 'Health minimum: about 150 min/week of easy activity (walks, cycling) plus daily steps. Keep it easy and away from heavy leg days.',
  cutting: `${STEPS} Plus 1–2 easy sessions/week. Cardio counts inside your calorie target.`,
  base: 'Health minimum: about 150 min/week of easy activity (walks, cycling) plus daily steps. Keep it easy.',
};
const RUN_CAP = 'No single run more than 10% longer than your longest run in the past 30 days.';
const RUNNER_CARDIO = {
  gaining: `Running leads: 3–4 runs/week, about 80% easy, plus strides. ${RUN_CAP} Hard runs and lifting 6+ hours apart.`,
  cutting: `Hold your running flat during this block — never add miles and cut calories at the same time. Mostly easy + 1 quality session. ${RUN_CAP}`,
  base: `Running leads: 3–4 runs/week, about 80% easy, plus strides. ${RUN_CAP} Hard runs and lifting 6+ hours apart.`,
  race: `Race block: 1–2 quality sessions/week (tempo, intervals), the rest easy. ${RUN_CAP} Strength deloads line up with running down-weeks.`,
};

const UL: Pick<BuildTemplate, 'weekdays'> = { weekdays: [1, 2, 4, 5] };

const TEMPLATES: Record<BuildKey, BuildTemplate> = {
  // Men
  lean_athletic: {
    ...UL,
    days: [
      { name: 'Upper A (upper chest + delts)', items: [['incline', 4], ['pullup', 3], ['cableRow', 3], ['lateral', 4], ['pressdown', 2], ['curl', 2]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 3], ['calf', 3], ['crunch', 3]] },
      { name: 'Upper B (lats + arms)', items: [['bench', 3], ['pulldown', 3], ['row', 3], ['fly', 3], ['lateral', 4], ['rearDelt', 2], ['skull', 2], ['hammer', 2]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 3], ['legExt', 2], ['legCurl', 2], ['calf', 3], ['hangLeg', 2]] },
    ],
    priority: ['shoulders', 'back', 'chest'],
    main: ['squat', 'rdl'],
    style: 'standard',
    cardio: STANDARD_CARDIO,
  },
  v_taper: {
    weekdays: [1, 2, 4, 5, 6],
    days: [
      { name: 'Upper A (delts + lats)', items: [['dbPress', 3], ['pulldown', 4], ['incline', 4], ['lateral', 4], ['curl', 2]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 2], ['calf', 3]] },
      { name: 'Upper B (back width)', items: [['pullup', 4], ['incline', 3], ['cableRow', 3], ['lateral', 4], ['fly', 3], ['pressdown', 2]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 2], ['legExt', 2], ['calf', 3], ['crunch', 3]] },
      { name: 'Delts + arms', items: [['lateral', 4], ['rearDelt', 3], ['pulldown', 3], ['hammer', 2], ['skull', 3]] },
    ],
    priority: ['shoulders', 'back', 'chest'],
    main: ['squat', 'dbPress'],
    style: 'standard',
    cardio: STANDARD_CARDIO,
  },
  thick_powerful: {
    weekdays: [1, 2, 3, 5, 6],
    days: [
      { name: 'Heavy lower', heavy: true, items: [['squat', 4], ['rdl', 3], ['legExt', 3], ['calf', 3]] },
      { name: 'Heavy upper', heavy: true, items: [['bench', 4], ['row', 4], ['ohp', 3], ['shrug', 3]] },
      { name: 'Volume lower', items: [['deadlift', 3], ['legPress', 3], ['split', 3], ['legCurl', 3], ['crunch', 3]] },
      { name: 'Volume upper', items: [['incline', 3], ['pulldown', 3], ['cableRow', 3], ['fly', 3], ['lateral', 3], ['pressdown', 3]] },
      { name: 'Glutes, delts + arms', items: [['hipThrust', 3], ['lateral', 3], ['rearDelt', 3], ['hammer', 3], ['skull', 3]] },
    ],
    priority: ['quads', 'glutes', 'back', 'chest'],
    main: ['squat', 'bench', 'deadlift', 'row', 'ohp'],
    style: 'standard',
    cardio: LIGHT_CARDIO,
  },
  shredded: {
    ...UL,
    days: [
      { name: 'Upper A', items: [['bench', 4], ['row', 4], ['dbPress', 3], ['lateral', 4], ['curl', 2], ['pressdown', 2]] },
      { name: 'Lower A', items: [['squat', 3], ['rdl', 3], ['legCurl', 3], ['calf', 3], ['crunch', 3]] },
      { name: 'Upper B', items: [['incline', 3], ['pullup', 3], ['cableRow', 3], ['fly', 3], ['lateral', 3], ['hammer', 2], ['skull', 2]] },
      { name: 'Lower B', items: [['legPress', 3], ['hipThrust', 3], ['legExt', 2], ['calf', 3], ['hangLeg', 3]] },
    ],
    priority: ['chest', 'back', 'shoulders'],
    main: ['bench', 'squat', 'rdl'],
    style: 'standard',
    cardio: STANDARD_CARDIO,
  },
  strong_dense: {
    ...UL,
    days: [
      { name: 'Squat + bench (heavy)', heavy: true, items: [['squat', 4], ['bench', 4], ['row', 3], ['crunch', 2]] },
      { name: 'Deadlift + press (heavy)', heavy: true, items: [['deadlift', 3], ['ohp', 4], ['pullup', 3], ['legCurl', 3]] },
      { name: 'Bench + squat (volume)', items: [['bench', 3], ['squat', 3], ['cableRow', 3], ['incline', 3], ['pressdown', 2], ['curl', 2]] },
      { name: 'Hinge + press (volume)', items: [['rdl', 3], ['ohp', 3], ['legPress', 3], ['pulldown', 3], ['carry', 3], ['calf', 2]] },
    ],
    priority: ['back', 'chest', 'quads'],
    main: ['squat', 'bench', 'deadlift', 'ohp', 'row', 'rdl'],
    style: 'standard',
    cardio: LIGHT_CARDIO,
  },
  // Women
  toned_athletic: {
    weekdays: [1, 3, 5],
    days: [
      { name: 'Full body A', items: [['goblet', 3], ['hipThrust', 3], ['pulldown', 4], ['dbPress', 2], ['lateral', 3], ['plank', 2]] },
      { name: 'Full body B', items: [['rdl', 3], ['split', 3], ['cableRow', 3], ['incline', 3], ['lateral', 3], ['crunch', 2]] },
      { name: 'Full body C', items: [['legPress', 3], ['hipThrust', 3], ['pullup', 3], ['legCurl', 3], ['rearDelt', 2], ['curl', 2]] },
    ],
    priority: ['glutes', 'shoulders', 'back'],
    main: ['goblet', 'rdl'],
    style: 'standard',
    cardio: STANDARD_CARDIO,
  },
  hourglass: {
    weekdays: [1, 2, 3, 5, 6],
    days: [
      // Deep squats and hip thrusts grow glute max about equally; neither grows the side glute, so abduction stays in.
      { name: 'Lower A (glutes)', items: [['hipThrust', 4], ['squat', 3], ['rdl', 3], ['abduction', 3]] },
      { name: 'Upper A (shoulders + back)', items: [['dbPress', 3], ['pulldown', 3], ['lateral', 4], ['cableRow', 3], ['pressdown', 2]] },
      { name: 'Lower B (glutes)', items: [['hipThrust', 3], ['split', 3], ['legCurl', 3], ['abduction', 3]] },
      { name: 'Upper B (back + delts)', items: [['incline', 2], ['pullup', 3], ['lateral', 4], ['rearDelt', 2], ['curl', 2]] },
      { name: 'Lower C (glutes)', items: [['legPress', 2], ['kickback', 2], ['abduction', 2], ['crunch', 2]] },
    ],
    priority: ['glutes', 'shoulders', 'back'],
    main: ['squat', 'rdl'],
    style: 'standard',
    cardio: GLUTE_CARDIO,
  },
  strong_curvy: {
    ...UL,
    days: [
      { name: 'Upper A (shoulders + back)', items: [['ohp', 3], ['row', 3], ['lateral', 3], ['pulldown', 3], ['curl', 2]] },
      { name: 'Lower A (heavy)', heavy: true, items: [['squat', 4], ['hipThrust', 3], ['rdl', 3], ['legExt', 3]] },
      { name: 'Upper B (back + shoulders)', items: [['bench', 3], ['pullup', 3], ['cableRow', 3], ['lateral', 3], ['pressdown', 2]] },
      { name: 'Lower B', items: [['deadlift', 3], ['legPress', 3], ['split', 3], ['legCurl', 4], ['hipThrust', 2], ['calf', 2]] },
    ],
    priority: ['glutes', 'quads', 'hamstrings'],
    main: ['squat', 'deadlift', 'hipThrust', 'bench', 'ohp', 'row'],
    style: 'standard',
    cardio: LIGHT_CARDIO,
  },
  lean_runner: {
    weekdays: [2, 5],
    days: [
      { name: 'Strength A (runner)', items: [['squat', 3], ['split', 2], ['pulldown', 2], ['calf', 3], ['pogo', 3], ['plank', 2]] },
      { name: 'Strength B (runner)', items: [['deadlift', 3], ['split', 2], ['legCurl', 2], ['pushup', 2], ['seatedCalf', 3], ['boxJump', 3]] },
    ],
    priority: [],
    main: ['squat', 'deadlift', 'split'],
    style: 'runner',
    cardio: RUNNER_CARDIO,
  },
};

export function trainWeekdays(build: BuildKey): number[] {
  return TEMPLATES[build].weekdays;
}

export function priorityMuscles(build: BuildKey): Muscle[] {
  return TEMPLATES[build].priority;
}

/* ---------------- the year map ---------------- */

/** A phase plus how it is dosed (never stored — only shapes the workout rows). */
export interface PlannedPhase extends ProgramPhase {
  /** Beginner ramp / first 28 days: fraction of the full set count. */
  setScale: number;
  /** First 28 days: short sessions (the first 4 exercises of each day). */
  short: boolean;
  /** Rotation B: exercise variants swapped in. */
  variant: boolean;
}

export interface PlanOptions {
  /** Under 18: no deficits or surpluses; cuts become build blocks. */
  teen?: boolean;
  /** Higher body fat: start with the cut (builds where the evidence says so). */
  startWithCut?: boolean;
  /** Pregnancy / postpartum (clinician-cleared): no cut. */
  noCut?: boolean;
}

type Seg = [PhaseKind, string, number, NutritionMode, string, number];

const FOCUS = {
  first28: 'Short sessions on fixed days. The only goal: show up. Two sessions in a week counts as a win.',
  recomp: 'Eat at maintenance with high protein. Add weight when every set hits the top of the rep range.',
  foundation: 'Groove technique and work capacity at maintenance calories. Stop each set 2–3 reps short of failure.',
  gain: 'Lean gain: a small surplus. Beat last time by a rep or a little weight (double progression).',
  strength: 'Heavy 3–5 rep work on the main lifts; accessories keep building size.',
  cut: 'Lose fat slowly. Keep the weights, the effort and the sets — that is what keeps the muscle.',
  maintenance: 'Hold your new body at maintenance calories.',
};

/** The 52-week map per build (week counts, in order). Consensus designs from the evidence report. */
function yearMap(build: BuildKey, level: TrainingLevel, startCut: boolean): Seg[] {
  const b = level === 'beginner';
  const first: Seg = ['foundation', 'First 28 days', 4, b ? 'recomp' : 'maintenance', FOCUS.first28, 0];
  const recompOrFoundation = (weeks: number): Seg =>
    b ? ['foundation', 'Foundation (recomp)', weeks, 'recomp', FOCUS.recomp, 0] : ['foundation', 'Foundation', weeks, 'maintenance', FOCUS.foundation, 0];
  const gain = (weeks: number, pct: number, focus = FOCUS.gain): Seg => ['hypertrophy', 'Lean gain', weeks, 'gaining', focus, pct];
  const cut = (weeks: number, pct: number, name = 'Cut'): Seg => ['cut', name, weeks, 'cutting', FOCUS.cut, -pct];
  const maint = (weeks: number, name = 'Maintenance', focus = FOCUS.maintenance): Seg => ['maintenance', name, weeks, 'maintenance', focus, 0];
  // Higher body fat: the cut comes first, then build at maintenance.
  const cutFirst = (pct: number): Seg[] => [
    ['foundation', 'First 28 days', 4, 'maintenance', FOCUS.first28, 0],
    cut(12, pct),
    maint(4, 'Maintenance (diet break)', 'A planned month at maintenance: let energy, sleep and training bounce back.'),
    ['hypertrophy', 'Build (recomp)', 28, 'recomp', FOCUS.recomp, 0],
    maint(4),
  ];
  switch (build) {
    case 'lean_athletic':
      if (startCut) return cutFirst(0.7);
      return [first, recompOrFoundation(12), gain(20, b ? 0.4 : 0.25), cut(12, 0.6), maint(4)];
    case 'v_taper':
      if (startCut) return cutFirst(0.7);
      return [first, recompOrFoundation(12), gain(24, 0.25), cut(10, 0.6), maint(2)];
    case 'thick_powerful':
      return [
        first,
        startCut ? ['foundation', 'Foundation (recomp)', 4, 'recomp', FOCUS.recomp, 0] : ['foundation', 'Foundation', 4, 'maintenance', FOCUS.foundation, 0],
        gain(36, b ? 0.4 : 0.25, 'Lean gain with heavy and volume days each week. Check your waist every 4 weeks — slow the surplus if it grows faster than you want.'),
        maint(8, 'Maintenance', 'Hold at maintenance. If your waist grew more than you wanted, a 6–8 week mini-cut fits here.'),
      ];
    case 'shredded':
      // Experienced only (beginners are routed to Lean Athletic). The cut is capped at 16 weeks, then required maintenance.
      return [
        ['foundation', 'Foundation', 4, 'maintenance', FOCUS.foundation, 0],
        gain(24, 0.25),
        cut(16, 0.6),
        maint(8, 'Maintenance + recovery', 'Required: back to a level you can live at. Energy, mood and sleep come back here.'),
      ];
    case 'strong_dense':
      return [
        first,
        ['hypertrophy', 'Size with heavy days', 16, 'gaining', 'Build size with one heavy day per lift each week.', b ? 0.35 : 0.25],
        ['strength', 'Strength emphasis', 16, 'gaining', FOCUS.strength, 0.15],
        ['hypertrophy', 'Size + strength (maintenance)', 12, 'maintenance', 'Alternate heavy and moderate days at maintenance calories.', 0],
        maint(4, 'Test week + maintenance', 'Test your main lifts in week 1 of this block, then hold at maintenance.'),
      ];
    case 'toned_athletic':
      if (startCut) return cutFirst(0.6);
      return [first, recompOrFoundation(12), gain(20, 0.25), cut(10, 0.6), maint(6)];
    case 'hourglass':
      if (startCut) return cutFirst(0.6);
      return [first, recompOrFoundation(12), gain(24, 0.25), cut(10, 0.5, 'Gentle cut'), maint(2)];
    case 'strong_curvy':
      return [
        first,
        startCut ? ['foundation', 'Foundation (recomp)', 4, 'recomp', FOCUS.recomp, 0] : ['foundation', 'Foundation', 4, 'maintenance', FOCUS.foundation, 0],
        gain(32, b ? 0.35 : 0.25, 'Lean gain with a heavy lower day each week.'),
        maint(12, 'Maintenance', 'Hold at maintenance. An optional 6–8 week mini-cut fits here if you want one.'),
      ];
    case 'lean_runner':
      return [
        ['foundation', 'First 28 days (run-walk)', 4, 'maintenance', 'Run-walk habit plus 2 short strength sessions. Show up; that is the goal.', 0],
        ['foundation', 'Aerobic base', 16, 'maintenance', 'Mostly easy running at maintenance calories. Strength makes running cheaper and safer.', 0],
        cut(12, 0.4, 'Lean block (small deficit, running held flat)'),
        ['strength', 'Race block', 16, 'maintenance', 'Race-specific running at maintenance; heavy, low-rep strength keeps legs springy.', 0],
        maint(4, 'Recovery', 'Easy running and light strength. Let the year settle in.'),
      ];
  }
}

/**
 * The year's phases. Long blocks get a deload after every 6 hard weeks (8 for
 * beginners) and swap exercise variants every 3–4 weeks.
 */
export function buildPhases(build: BuildKey, level: TrainingLevel, o: PlanOptions = {}): PlannedPhase[] {
  const startCut = !!o.startWithCut && build !== 'shredded' && build !== 'lean_runner';
  const segs = yearMap(build, level, startCut);
  const total = segs.reduce((s, x) => s + x[2], 0);
  if (total !== 52) throw new Error(`${build}/${level}: year map is ${total} weeks`);
  const every = level === 'beginner' ? 8 : 6;
  const out: PlannedPhase[] = [];
  let week = 1;
  let chunkNo = 0;
  const push = (p: Omit<PlannedPhase, 'weekStart' | 'weekEnd' | 'setScale'>, weeks: number): void => {
    // Beginner ramp: about half the sets in the first month, about ¾ through week 16, full after.
    const setScale =
      p.kind === 'deload' ? (out[out.length - 1]?.setScale ?? 1) : p.short ? (level === 'beginner' ? 0.5 : 0.75) : level === 'beginner' && week <= 16 ? 0.75 : 1;
    out.push({ ...p, setScale, weekStart: week, weekEnd: week + weeks - 1 });
    week += weeks;
  };
  for (const [kind, name, weeks, nutrition, focus, pct] of segs) {
    const short = name.startsWith('First 28');
    const base = { kind, name, nutrition, focus, weeklyChangePct: pct, short, variant: false };
    if (short || weeks < 6 || kind === 'maintenance') {
      push(base, weeks);
      continue;
    }
    const chunk = (): typeof base => {
      const variant = chunkNo++ % 2 === 1;
      return { ...base, variant, name: variant ? `${name} · new variations` : name };
    };
    let left = weeks;
    while (left > 0) {
      const hard = Math.min(every, left);
      if (hard >= 6) {
        // Rotation: split each hard run into two halves (3+3 or 4+4); every other half uses the variants.
        const a = Math.ceil(hard / 2);
        push(chunk(), a);
        push(chunk(), hard - a);
      } else {
        push(chunk(), hard);
      }
      left -= hard;
      if (left > 1) {
        push({ ...base, kind: 'deload', name: 'Deload', focus: 'Same exercises, about half the sets, 3–4 reps short of failure. Recover, then push again.' }, 1);
        left -= 1;
      }
    }
  }
  if (o.teen || o.noCut) {
    return out.map((p) => {
      const q = { ...p };
      if (q.kind === 'cut') {
        q.kind = 'hypertrophy';
        q.name = q.name.replace(/^(Gentle cut|Cut|Lean block[^·]*)/, o.teen ? 'Build' : 'Build (no cut)').trim();
        q.focus = 'Train hard and eat regular meals with a protein food at each one.';
      }
      if (o.teen || q.nutrition === 'cutting') {
        q.nutrition = 'maintenance';
        q.weeklyChangePct = 0;
      }
      if (o.teen) q.name = q.name.replace('Lean gain', 'Build').replace(' (recomp)', '').replace('Lean block', 'Build');
      if (o.teen) q.focus = q.focus.replace(/ at maintenance calories| in a small surplus|Lean gain: a small surplus\. |Eat at maintenance with high protein\. /g, '');
      return q;
    });
  }
  return out;
}

export function cardioFor(build: BuildKey, phase: ProgramPhase): string {
  const c = TEMPLATES[build].cardio;
  if (c.race && phase.name.startsWith('Race')) return c.race;
  if (phase.nutrition === 'cutting') return c.cutting;
  if (phase.nutrition === 'gaining') return c.gaining;
  return c.base;
}

/* ---------------- workout rows ---------------- */

export interface WorkoutRow {
  phaseId: string;
  phaseName: string;
  weekStart: number;
  weekEnd: number;
  dayNum: number;
  dayName: string;
  exercise: string;
  muscle: Muscle;
  secondary: Muscle[];
  /** Jumps / hops: not counted as hard sets. */
  power: boolean;
  sets: number;
  reps: string;
  rest: string;
  equipment: string;
  cues: string;
  subs: string;
  focus: string;
}

interface Dose {
  sets: number;
  reps: string;
  rest: string;
}

const DELOAD_REPS = { compound: '6–8 · 4+ RIR (light week)', iso: '10–12 · 4+ RIR (light week)' };

/** Halve the sets, alternating rounding so a day lands near 50%. */
export const deloadSets = (sets: number, position: number): number => Math.max(1, position % 2 === 0 ? Math.ceil(sets / 2) : Math.floor(sets / 2));

/** Sets/reps/rest for one exercise in one phase. RIR = reps in reserve (how many more you could do). */
function dose(p: PlannedPhase, ex: Exercise, fullSets: number, style: Style, heavyDay: boolean, position: number): Dose {
  const sets = Math.max(1, Math.floor(fullSets * p.setScale + 0.25));
  if (ex.power) {
    const reps = ex.muscle === 'calves' ? '15–20 quick hops · full rest' : '5 jumps · full rest, land soft';
    return { sets: p.kind === 'deload' ? 1 : Math.min(sets, 3), reps, rest: '1–2 min' };
  }
  if (p.kind === 'deload') return { sets: deloadSets(sets, position), reps: ex.compound ? DELOAD_REPS.compound : DELOAD_REPS.iso, rest: '1–2 min' };
  if (style === 'runner') {
    return ex.compound
      ? { sets, reps: '3–6 heavy · 2–3 RIR', rest: '2–3 min' }
      : { sets, reps: '8–12 · 2–3 RIR', rest: '1–2 min' };
  }
  switch (p.kind) {
    case 'strength':
      return ex.compound
        ? { sets: Math.max(3, sets), reps: '3–5 · 1–3 RIR (~80–90%)', rest: '3–5 min' }
        : { sets, reps: '8–12 · 1–2 RIR', rest: '1–2 min' };
    case 'foundation':
      return ex.compound
        ? { sets, reps: '8–12 · 2–3 RIR (learn the groove)', rest: '2 min' }
        : { sets, reps: '12–15 · 2–3 RIR', rest: '1–1.5 min' };
    case 'maintenance': {
      const m = Math.max(1, Math.round(sets * 0.7));
      return ex.compound ? { sets: m, reps: '6–10 · 1–3 RIR', rest: '2–3 min' } : { sets: m, reps: '10–15 · 1–2 RIR', rest: '1–2 min' };
    }
    default:
      // Hypertrophy and cut alike: a cut holds load, effort and volume.
      if (ex.compound && heavyDay) return { sets, reps: '3–6 · 1–3 RIR (~80–88%)', rest: '3–4 min' };
      return ex.compound
        ? { sets, reps: '6–12 · 1–3 RIR', rest: '2–3 min' }
        : { sets, reps: '10–20 · 0–2 RIR', rest: '1–2 min' };
  }
}

/** Every workout row of the 52-week program. */
export function programRows(build: BuildKey, phases: PlannedPhase[]): WorkoutRow[] {
  const t = TEMPLATES[build];
  const rows: WorkoutRow[] = [];
  phases.forEach((p, idx) => {
    t.days.forEach((d, i) => {
      const items = p.short ? d.items.slice(0, 4) : d.items;
      items.forEach(([key, fullSets], position) => {
        const swap = p.variant && !t.main.includes(key) ? ROTATE[key] : undefined;
        const ex: Exercise = LIB[swap ?? key];
        const { sets, reps, rest } = dose(p, ex, fullSets, t.style, !!d.heavy && p.kind !== 'foundation', position);
        rows.push({
          phaseId: `P${idx + 1}`,
          phaseName: p.name,
          weekStart: p.weekStart,
          weekEnd: p.weekEnd,
          dayNum: i + 1,
          dayName: d.name,
          exercise: ex.name,
          muscle: ex.muscle,
          secondary: [...ex.secondary],
          power: ex.power,
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

/** Every exercise the library knows (for pictures and tests). */
export const libraryNames = (): string[] => Object.values(LIB).map((e) => e.name);

/** Fractional hard sets per muscle: 1 for the target muscle, ½ for each secondary muscle (jumps don't count). */
export function weeklySets(rows: Array<Pick<WorkoutRow, 'muscle' | 'sets'> & { secondary?: Muscle[]; power?: boolean }>): Partial<Record<Muscle, number>> {
  const out: Partial<Record<Muscle, number>> = {};
  for (const r of rows) {
    if (r.power) continue;
    out[r.muscle] = (out[r.muscle] ?? 0) + r.sets;
    for (const m of r.secondary ?? []) out[m] = (out[m] ?? 0) + r.sets / 2;
  }
  return out;
}

/** The most fractional sets any muscle gets in a single session. */
export function maxSessionSets(rows: WorkoutRow[]): { muscle: Muscle | null; day: string; sets: number } {
  const days = new Map<number, WorkoutRow[]>();
  for (const r of rows) days.set(r.dayNum, [...(days.get(r.dayNum) ?? []), r]);
  let best: { muscle: Muscle | null; day: string; sets: number } = { muscle: null, day: '', sets: 0 };
  for (const [, rs] of days) {
    for (const [m, n] of Object.entries(weeklySets(rs)) as Array<[Muscle, number]>) {
      if (n > best.sets) best = { muscle: m, day: rs[0]?.dayName ?? '', sets: n };
    }
  }
  return best;
}

/** Days per week each muscle is trained directly (frequency) for the rows of one phase. */
export function weeklyFrequency(rows: WorkoutRow[]): Partial<Record<Muscle, number>> {
  const days = new Map<Muscle, Set<number>>();
  for (const r of rows) days.set(r.muscle, (days.get(r.muscle) ?? new Set()).add(r.dayNum));
  const out: Partial<Record<Muscle, number>> = {};
  for (const [m, s] of days) out[m] = s.size;
  return out;
}

/* ---------------- food ---------------- */

/**
 * Daily calories and macros. Maintenance = Mifflin-St Jeor × activity (+ what
 * the weigh-in trend has taught us). The phase's weekly % change sets the
 * surplus or deficit; a deficit is capped at 500 kcal/day (750 with BMI ≥ 30,
 * never past 1%/wk) and no day goes under the calorie floor. Protein and fat
 * scale with reference weight; carbs fill the rest.
 */
export function energyFor(body: BodyInputs, phase: Pick<ProgramPhase, 'nutrition' | 'weeklyChangePct'>, adjust = 0): { macros: Macros; energy: EnergyMath } {
  const maintenance = Math.round(maintenanceCalories(body) + adjust);
  const ref = referenceWeightLb(body.weightLb, body.heightIn, body.goalWeightLb);
  let delta = ((body.weightLb * phase.weeklyChangePct) / 100) * (3500 / 7);
  let capped = false;
  if (delta < 0) {
    const higherBf = bmiOf(body.weightLb, body.heightIn) >= 30;
    const cap = Math.min(higherBf ? MAX_DEFICIT_KCAL_HIGHER_BF : MAX_DEFICIT_KCAL, body.weightLb * 0.01 * 500);
    if (-delta > cap) {
      delta = -cap;
      capped = true;
    }
  } else {
    delta = Math.min(delta, maintenance * 0.2);
  }
  const floor = CALORIE_FLOOR[body.sex];
  const raw = maintenance + delta;
  const floored = raw < floor;
  const calories = Math.round(Math.max(floor, raw) / 10) * 10;
  const protein = Math.round(ref * PROTEIN_G_PER_LB[phase.nutrition].target);
  // Fat: 0.35 g/lb of reference weight, kept between max(0.25 g/lb, 20% of calories) and 40% of calories.
  const fat = Math.round(Math.min((calories * 0.4) / 9, Math.max(ref * 0.35, ref * 0.25, (calories * 0.2) / 9)));
  const carbs = Math.max(0, Math.round((calories - protein * 4 - fat * 9) / 4));
  return { macros: { calories, protein, carbs, fat }, energy: { maintenance, adjust, capped, floored, referenceLb: ref } };
}

export const macrosFor = (body: BodyInputs, phase: Pick<ProgramPhase, 'nutrition' | 'weeklyChangePct'>, adjust = 0): Macros => energyFor(body, phase, adjust).macros;

/** Fill in what the person hasn't told us with sensible defaults (sex from the build, age 30, average height). */
export function bodyInputs(build: BuildKey, p: {
  weightLb: number;
  sex?: 'male' | 'female' | null;
  ageYears?: number | null;
  heightIn?: number | null;
  activity?: BodyInputs['activity'] | null;
  goalWeightLb?: number | null;
}): BodyInputs {
  const sex = p.sex ?? (BUILD_INFO[build].group === 'men' ? 'male' : 'female');
  return {
    sex,
    ageYears: p.ageYears ?? 30,
    heightIn: p.heightIn ?? (sex === 'male' ? 70 : 64),
    weightLb: p.weightLb,
    activity: p.activity ?? 'moderate',
    goalWeightLb: p.goalWeightLb ?? null,
  };
}

export function weekOf<P extends ProgramPhase>(phases: P[], week: number): P {
  const hit = phases.find((p) => week >= p.weekStart && week <= p.weekEnd);
  const last = phases[phases.length - 1];
  const first = phases[0];
  if (hit) return hit;
  if (last && week > last.weekEnd) return last;
  if (first) return first;
  throw new Error('program has no phases');
}

export const defaultFoodProtein = (build: BuildKey): number => BUILD_INFO[build].foodProteinDefault;

/** The year as four ~13-week chapters — each one a clean place to (re)start. */
export const CHAPTERS = [
  { n: 1, weekStart: 1, weekEnd: 13, title: 'Chapter 1 · Build the habit' },
  { n: 2, weekStart: 14, weekEnd: 26, title: 'Chapter 2 · Build the base' },
  { n: 3, weekStart: 27, weekEnd: 39, title: 'Chapter 3 · Push' },
  { n: 4, weekStart: 40, weekEnd: 52, title: 'Chapter 4 · Reveal + keep it' },
];
export const chapterOf = (week: number): number => CHAPTERS.find((c) => week >= c.weekStart && week <= c.weekEnd)?.n ?? 4;

/** Double progression from the last log: add weight once every set hits the top of the range. */
export function nextStep(reps: string, last: { weight: string; reps: string } | undefined): string | null {
  if (!last || reps.includes('light week')) return null;
  const range = /(\d+)\s*[–-]\s*(\d+)/.exec(reps);
  const done = (last.reps.match(/\d+/g) ?? []).map(Number);
  if (!range || !done.length) return null;
  const top = Number(range[2]);
  const low = Math.min(...done);
  const w = parseFloat(last.weight);
  if (low >= top) {
    return Number.isFinite(w) ? `You hit ${top} last time — go up to about ${w + (top <= 12 ? 5 : 2.5)} lb` : `You hit ${top} last time — add a little weight`;
  }
  return `Same weight${last.weight ? ` (${last.weight})` : ''} — aim for ${low + 1} reps`;
}
