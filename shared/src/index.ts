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

export type AuthKind = 'google' | 'dev' | 'pin';

export interface Me {
  userId: number;
  email: string;
  name: string;
  auth: AuthKind;
  /** null until the signed-in account is linked to a household member. */
  member: HouseholdMember | null;
}

/* ---------- kid sign-in (parent-managed PIN) ---------- */

/** Kid PINs are exactly this many digits. */
export const KID_PIN_LENGTH = 6;

export interface KidPinLoginRequest {
  name: string;
  pin: string;
}

export interface KidAccess {
  memberId: number;
  key: string;
  name: string;
  hasPin: boolean;
  lockedUntil: string | null;
}

export interface KidAccessResponse {
  kids: KidAccess[];
}

export interface SetKidPinRequest {
  /** Omit to have the server generate a random PIN. */
  pin?: string;
}

export interface SetKidPinResponse {
  /** Returned once so the parent can hand it to the kid. Never stored in plain text. */
  pin: string;
}

/* ---------- XP + levels ---------- */

export type XpTrack = 'leader' | 'woman' | 'student' | 'kid';

export interface XpStatus {
  track: XpTrack;
  total: number;
  level: number;
  title: string;
  /** null at max level. */
  next: { level: number; title: string; at: number } | null;
  /** Progress to the next level, 0..100. */
  pct: number;
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

/** Returned by every action that can earn points/XP. */
export interface EarnResult {
  totalPoints: number;
  xp: XpStatus;
  leveledUp: boolean;
}

export interface ToggleChoreResponse extends EarnResult {
  today: TodayResponse;
  /** Present when checking off finished the day; null otherwise. */
  perfectWeek: PerfectWeekResult | null;
}

/* ---------- homework ---------- */

/** The script's default: every homework item is worth 20 points. */
export const HOMEWORK_POINTS = 20;

export interface NewHomework {
  assignment: string;
  subject: string;
  due: DateStr | null;
  /** Grown-ups may set a custom value; kids always get HOMEWORK_POINTS. */
  points?: number;
}

export interface HomeworkEntry extends HomeworkItem {
  done: boolean;
  doneOn: DateStr | null;
}

export interface HomeworkListResponse {
  member: HouseholdMember;
  open: HomeworkEntry[];
  doneRecently: HomeworkEntry[];
}

export interface ToggleHomeworkResponse extends EarnResult {
  homework: HomeworkListResponse;
}

/* ---------- rewards ---------- */

export interface Reward {
  id: number;
  name: string;
  cost: number;
  /** null = for every kid. */
  memberId: number | null;
  memberName: string | null;
}

export type RedemptionStatus = 'pending' | 'approved' | 'denied';

export interface Redemption {
  id: number;
  memberId: number;
  memberName: string;
  rewardName: string;
  cost: number;
  status: RedemptionStatus;
  requestedOn: DateStr;
}

export interface RewardStore {
  member: HouseholdMember;
  /** Spendable: earned points minus pending + approved redemptions. */
  bank: number;
  rewards: Reward[];
  redemptions: Redemption[];
}

export interface NewReward {
  name: string;
  cost: number;
  memberId: number | null;
}

export interface RewardAdminResponse {
  rewards: Reward[];
  pending: Redemption[];
}

/* ---------- score + streaks ---------- */

export type ScoreSource = 'chore' | 'homework' | 'perfect_week' | 'bonus' | 'habit';

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
  /** Lifetime points earned (never goes down when spending). */
  totalPoints: number;
  /** Spendable in the rewards store. */
  bank: number;
  xp: XpStatus;
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
  habits: Record<HabitKey, boolean>;
}

/* ---------- health habits ---------- */

export const HABITS = [
  { key: 'water', label: 'Water', points: 5 },
  { key: 'shake', label: 'Protein shake', points: 5 },
  { key: 'creatine', label: 'Creatine', points: 5 },
] as const;
export type HabitKey = (typeof HABITS)[number]['key'];

export interface ToggleHabitRequest {
  done: boolean;
}

export interface ToggleHabitResponse extends EarnResult {
  habits: Record<HabitKey, boolean>;
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
  /** Plan entry id (the same meal can sit on several days). */
  id: number;
  mealId: number;
  title: string;
  cuisine: string;
  calories: number | null;
  protein: number | null;
  day: Weekday | null;
}

export interface MealPlanDay {
  day: Weekday;
  date: DateStr;
  isToday: boolean;
  meals: MealPlanEntry[];
  calories: number;
  protein: number;
}

export interface MealPlanResponse {
  member: HouseholdMember;
  weekStart: DateStr;
  /** Mon..Sun of the current week. */
  days: MealPlanDay[];
  /** Picked for the week but not on a day yet. */
  unassigned: MealPlanEntry[];
  /** Every entry (days + unassigned), in the order added. */
  meals: MealPlanEntry[];
}

export interface AddMealPlanRequest {
  mealId: number;
  day?: Weekday | null;
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

export type StoreAvailability = 'advertised' | 'check' | 'no';
export type Fulfillment = 'instore' | 'pickup' | 'delivery';

export interface GroceryChain {
  name: string;
  shopUrl: string;
  acctUrl: string;
  pickup: StoreAvailability;
  delivery: StoreAvailability;
  note: string;
  custom: boolean;
}

export interface GroceryFavorite {
  store: string;
  fulfillment: Fulfillment;
  signedIn: boolean;
}

export interface GroceryState {
  items: GroceryItem[];
  staples: GroceryStaple[];
  /** Household ZIP ('' until set). Drives the "stores near you" links. */
  zip: string;
  chains: GroceryChain[];
  /** The signed-in member's favorite stores. */
  favorites: GroceryFavorite[];
}

export interface SetFavoriteRequest {
  store: string;
  favorite: boolean;
}

export interface UpdateFavoriteRequest {
  store: string;
  fulfillment?: Fulfillment;
  signedIn?: boolean;
}

export interface AddCustomStoreRequest {
  name: string;
  url: string;
}

export interface AddGroceryRequest {
  item: string;
  qty: string;
}

export interface GroceryFromWeekResult {
  added: number;
  merged: number;
  skipped: number;
  /** Plan-only rows dropped because no planned meal needs them anymore. */
  removed: number;
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
