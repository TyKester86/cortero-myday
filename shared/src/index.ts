/**
 * Types shared by api/ and web/. Every request/response shape lives here and
 * only here — never redefine one of these in either package.
 */

/* ---------- calendar ---------- */

/** Mon..Sun, in the order the original Chore Board columns ran. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** yyyy-MM-dd in the household time zone. */
export type DateStr = string;

/* ---------- household + identity ---------- */

export type MemberKind = 'kid' | 'adult';

export interface HouseholdMember {
  id: number;
  key: string;
  name: string;
  kind: MemberKind;
  age: number | null;
}

export interface Me {
  userId: number;
  email: string;
  name: string;
  /** null until the signed-in account is linked to a household member. */
  member: HouseholdMember | null;
}

export interface HouseholdResponse {
  members: HouseholdMember[];
}

export interface ApiError {
  error: string;
}

export interface HealthCheck {
  ok: true;
}

/* ---------- chores ---------- */

export interface Chore {
  id: number;
  name: string;
  memberId: number;
  memberName: string;
  days: Weekday[];
  points: number;
}

export interface ChoreListResponse {
  chores: Chore[];
}

export interface NewChore {
  name: string;
  memberId: number;
  days: Weekday[];
  points: number;
}

export interface TodayChore {
  id: number;
  name: string;
  points: number;
  done: boolean;
}

export interface HomeworkItem {
  id: number;
  assignment: string;
  subject: string;
  due: DateStr | null;
  overdue: boolean;
  points: number;
}

export interface TodayResponse {
  member: HouseholdMember;
  date: DateStr;
  weekday: Weekday;
  chores: TodayChore[];
  homework: HomeworkItem[];
  /** Everything on today's plate: scheduled chores + open homework. */
  pointsToday: number;
  /** Points from chores already checked off today. */
  pointsEarned: number;
}

export interface ToggleChoreRequest {
  done: boolean;
}

export interface PerfectWeekResult {
  awarded: boolean;
  /** Every scheduled chore Mon..today done and no homework hanging. */
  clean: boolean;
  alreadyAwarded: boolean;
  bonus: number;
}

export interface ToggleChoreResponse {
  today: TodayResponse;
  totalPoints: number;
  /** Present when checking off finished the day; null otherwise. */
  perfectWeek: PerfectWeekResult | null;
}

/* ---------- score + streaks ---------- */

export type ScoreSource = 'chore' | 'homework' | 'perfect_week' | 'bonus';

export interface ScoreEntry {
  id: number;
  date: DateStr;
  points: number;
  source: ScoreSource;
  note: string;
}

export interface StreakInfo {
  current: number;
  longest: number;
  shields: number;
  totalDays: number;
}

export interface ScoreSummary {
  member: HouseholdMember;
  totalPoints: number;
  weekPoints: number;
  todayPoints: number;
  weekStart: DateStr;
  perfectWeek: PerfectWeekResult;
  /** Adults only. Kids get no streaks (positive-only economy, see README). */
  streak: StreakInfo | null;
  recent: ScoreEntry[];
}

/* ---------- health ---------- */

export interface WorkoutExercise {
  exercise: string;
  sets: number;
  reps: string;
  rest: string;
  equipment: string;
  cues: string;
  subs: string;
}

export interface WorkoutSession {
  dayNum: number;
  dayName: string;
  exercises: WorkoutExercise[];
}

export interface HealthProfile {
  planStart: DateStr;
  trainWeekdays: Weekday[];
  targetCalories: number;
  targetProtein: number;
  targetCarbs: number;
  targetFat: number;
  breakfast: string;
  shake: string;
  cardio: string;
}

export interface LastLift {
  weight: string;
  reps: string;
  date: DateStr;
}

export interface HealthToday {
  member: HouseholdMember;
  date: DateStr;
  weekNum: number;
  phaseName: string;
  focus: string;
  session: WorkoutSession | null;
  isRest: boolean;
  profile: HealthProfile | null;
  last: Record<string, LastLift>;
  dayCompleted: boolean;
}

export interface PlanPhase {
  id: string;
  name: string;
  weekStart: number;
  weekEnd: number;
  focus: string;
  days: string[];
}

export interface HealthPlan {
  member: HouseholdMember;
  currentWeek: number;
  phases: PlanPhase[];
}

export interface LogExerciseRequest {
  exercise: string;
  sets: number;
  reps: string;
  weight: string;
  phaseName: string;
  dayName: string;
}

export interface CompleteDayResponse {
  choreMarked: boolean;
}

/* ---------- meals + grocery ---------- */

export interface MealSummary {
  id: number;
  title: string;
  cuisine: string;
  calories: number | null;
  protein: number | null;
}

export interface MealDetail extends MealSummary {
  carbs: number | null;
  fat: number | null;
  ingredients: string[];
  steps: string[];
}

export interface MealListResponse {
  meals: MealSummary[];
  cuisines: string[];
}

export interface MealPlanEntry {
  mealId: number;
  title: string;
  cuisine: string;
  day: Weekday | null;
}

export interface MealPlanResponse {
  member: HouseholdMember;
  meals: MealPlanEntry[];
}

export interface SetMealDayRequest {
  day: Weekday | null;
}

export interface GroceryItem {
  id: number;
  item: string;
  qty: string;
  done: boolean;
  addedBy: string;
}

export interface GroceryStaple {
  id: number;
  item: string;
}

export interface GroceryState {
  items: GroceryItem[];
  staples: GroceryStaple[];
}

export interface AddGroceryRequest {
  item: string;
  qty: string;
}

export interface GroceryFromWeekResult {
  added: number;
  merged: number;
  skipped: number;
  staples: number;
  meals: number;
  grocery: GroceryState;
}

/* ---------- weekly plan ---------- */

export interface WeeklyPlanFields {
  theme: string;
  top: string;
  energy: string;
  focus: string;
  rsd: string;
  review: string;
}

export interface WeeklyPlan extends WeeklyPlanFields {
  weekStart: DateStr;
}

export interface WeeklyPlanResponse {
  member: HouseholdMember;
  weekStart: DateStr;
  current: WeeklyPlan | null;
  previous: WeeklyPlan | null;
}
