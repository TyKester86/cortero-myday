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
  /** The member's XP level table (decides e.g. whether the tutor is offered). */
  xpTrack: XpTrack | null;
  /** null = signed in but no household yet (onboarding). */
  household: HouseholdInfo | null;
  /** MyDay staff (ADMIN_EMAILS): may open the admin dashboard. */
  isAdmin: boolean;
  /** Per-person look + first-run state (null until linked to a member). */
  prefs: { theme: 'system' | 'light' | 'dark'; accent: string; firstRunDone: boolean } | null;
}

/* ---------- households (multi-household signup) ---------- */

export const HOUSEHOLD_TYPES = ['family', 'couple', 'solo', 'empty_nesters', 'retired', 'college'] as const;
export type HouseholdType = (typeof HOUSEHOLD_TYPES)[number];

export const HOUSEHOLD_TYPE_INFO: Record<HouseholdType, { label: string; blurb: string }> = {
  family: { label: 'Family with kids', blurb: 'Grown-ups and kids: chores, homework, rewards, the whole family loop.' },
  couple: { label: 'Couple', blurb: 'Two grown-ups, no kids at home: your days, money, meals and each other.' },
  solo: { label: 'Just me', blurb: 'A single-player day: check-in, tasks, health, money, Hana.' },
  empty_nesters: { label: 'Empty nesters', blurb: 'The kids have flown: your days, health, money and each other — no kid modules.' },
  retired: { label: 'Retired', blurb: 'Your second act: days with purpose, health, money and the people you love.' },
  college: { label: 'College student', blurb: 'Classes, lectures, study library, tutor, money and your day.' },
};

/** Role art (web/public/roles): one picture per grown-up role or household life-stage. */
export const ROLE_ICONS = {
  leader: '/roles/leader.png', // Atlas — Family Leader
  woman: '/roles/heart.png', // Hestia — Heart of the Home
  kid: '/roles/kid.png', // Hermes — kids
  student: '/roles/college.png', // young philosopher — college
  solo: '/roles/solo.png', // lone traveler — one gender-neutral solo type
  couple: '/roles/couple.png', // second-act couple — empty nesters AND retired
} as const;

export const HOUSEHOLD_TYPE_ICON: Record<HouseholdType, string> = {
  family: ROLE_ICONS.leader,
  couple: ROLE_ICONS.couple,
  solo: ROLE_ICONS.solo,
  empty_nesters: ROLE_ICONS.couple,
  retired: ROLE_ICONS.couple,
  college: ROLE_ICONS.student,
};

/** Feature areas a household type turns on or off. */
export interface HouseholdFeatures {
  kids: boolean;
  partner: boolean;
  student: boolean;
}

export function featuresFor(type: HouseholdType): HouseholdFeatures {
  return {
    kids: type === 'family',
    partner: type === 'family' || type === 'couple' || type === 'empty_nesters' || type === 'retired',
    student: type === 'college' || type === 'family',
  };
}

export const ONBOARDING_STEPS = ['household', 'invite', 'kids', 'classroom', 'bank'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface HouseholdInfo {
  id: number;
  name: string;
  type: HouseholdType;
  /** Family code kids type on a new device. */
  code: string;
  trialEndsAt: string | null;
  allowTeenBankLink: boolean;
  /** Onboarding steps done or skipped. */
  onboarding: Partial<Record<OnboardingStep, boolean>>;
}

export interface CreateHouseholdRequest {
  householdName: string;
  type: HouseholdType;
  yourName: string;
  build?: BuildKey | null;
  school?: string | null;
}

/* ---------- kid sign-in (parent-managed PIN) ---------- */

/** Kid PINs are exactly this many digits. */
export const KID_PIN_LENGTH = 6;

export interface KidPinLoginRequest {
  name: string;
  pin: string;
  /** Add this kid to this device's sign-in picker. */
  remember?: boolean;
}

export interface KidAccess {
  memberId: number;
  key: string;
  name: string;
  hasPin: boolean;
  lockedUntil: string | null;
  /** Most recent sign-in attempts, newest first. */
  recentSignins: KidSignin[];
}

export interface KidSignin {
  at: string;
  ok: boolean;
  device: string;
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
  /** Kids: tonight's curfew + phone-off times (null if none set). */
  curfew: TonightCurfew | null;
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

export interface DecidedRedemption extends Redemption {
  decidedAt: string;
  decidedBy: string;
}

export interface RewardAdminResponse {
  rewards: Reward[];
  pending: Redemption[];
  /** Approved + denied, newest first. */
  history: DecidedRedemption[];
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
  /** Adults only: today's 5 × 20 score (scoreToday_). */
  daily: DailyScore | null;
  dailyHistory: Array<{ date: DateStr; total: number }>;
  achievements: Achievement[];
  /** Achievements unlocked by this request. */
  newlyUnlocked: string[];
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
  /** false = no year plan loaded yet (pick a build) — never a made-up default workout. */
  hasPlan: boolean;
  /** Today's session was moved to another day, or today shows a session moved here. */
  moved: { to?: DateStr; from?: DateStr } | null;
  /** Build program (phase, week, macros, shakes) when a build is set up. */
  program: ProgramStatus | null;
}

export interface MoveWorkoutRequest {
  /** Default today. */
  from?: DateStr;
  /** A date, or 'tomorrow'. */
  to: DateStr | 'tomorrow';
}

/** A4: a general workout log entry (the script's FamWorkout: type + minutes). */
export interface SessionLog {
  date: DateStr;
  activity: string;
  minutes: number;
}

export interface ExerciseLog {
  date: DateStr;
  exercise: string;
  sets: number | null;
  reps: string;
  weight: string;
}

export interface HealthBaseline {
  exercise: string;
  sleep: string;
  food: string;
}

export interface HealthHistory {
  sessions: SessionLog[];
  exercises: ExerciseLog[];
  completedDays: DateStr[];
  /** Minutes logged in the last 7 days. */
  weekMinutes: number;
  baseline: HealthBaseline;
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
  kind: string;
  nutrition: string;
  weekStart: number;
  weekEnd: number;
  focus: string;
  cardio: string;
  days: string[];
}

export interface PlanWeek {
  week: number;
  /** Monday of that week. */
  starts: DateStr;
  phase: string | null;
  kind: string | null;
  isCurrent: boolean;
  /** Training days that week (names), empty = unplanned. */
  days: string[];
}

export interface HealthPlan {
  member: HouseholdMember;
  currentWeek: number;
  phases: PlanPhase[];
  /** All 52 weeks, current one flagged. */
  weeks: PlanWeek[];
  hasPlan: boolean;
  build: BuildKey | null;
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
  /** Always set: every library meal has a picture. */
  imageUrl: string;
  prepMin: number | null;
  /** Nutrition phases this meal suits (body-style programs). */
  phaseTags: NutritionMode[];
}

/** URL-safe slug for a meal title (picture file name). */
export function mealSlug(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Which nutrition phases a meal suits, from its per-serving macros:
 *   cutting: ≥30 g protein, ≤560 kcal, ≥28% of calories from protein
 *   gaining: ≥560 kcal and ≥35 g protein
 *   recomp: ≥30 g protein, 420–680 kcal, ≥25% of calories from protein
 *   maintenance: ≥20 g protein
 */
export function mealPhaseTags(calories: number, protein: number): NutritionMode[] {
  const share = calories > 0 ? (protein * 4) / calories : 0;
  const tags: NutritionMode[] = [];
  if (protein >= 30 && calories <= 560 && share >= 0.28) tags.push('cutting');
  if (calories >= 560 && protein >= 35) tags.push('gaining');
  if (protein >= 30 && calories >= 420 && calories <= 680 && share >= 0.25) tags.push('recomp');
  if (protein >= 20) tags.push('maintenance');
  return tags;
}

export interface MealDetail extends MealSummary {
  carbs: number | null;
  fat: number | null;
  servings: number | null;
  ingredients: string[];
  steps: string[];
}

export interface MealListResponse {
  meals: MealSummary[];
  cuisines: string[];
  /** The viewer's current program phase, when they have one (meals can be filtered to it). */
  phase: NutritionMode | null;
}

export const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner'] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export interface MealPlanEntry {
  /** Plan entry id (the same meal can sit on several days). */
  id: number;
  slot: MealSlot | null;
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
  slot?: MealSlot | null;
}

/** Omit a field to leave it unchanged. */
export interface SetMealDayRequest {
  day?: Weekday | null;
  slot?: MealSlot | null;
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
  /** The store's online grocery ordering page; null = in-store only. */
  orderUrl: string | null;
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

/* ================= build 3 ================= */

/* ---------- family: curfews, partner check-in, 1-on-1s, kids overview ---------- */

/** "HH:MM" (24h) or '' when not set. */
export type ClockTime = string;

export interface Curfew {
  curfewWeekday: ClockTime;
  curfewWeekend: ClockTime;
  phoneOffWeekday: ClockTime;
  phoneOffWeekend: ClockTime;
}

export interface TonightCurfew {
  /** Friday and Saturday nights use the weekend times. */
  weekend: boolean;
  curfew: ClockTime;
  phoneOff: ClockTime;
}

export interface PartnerCheckin {
  weekStart: DateStr;
  positives: number;
  negatives: number;
  /** e.g. "5.0:1", "∞" or "—" (the script's ratio display). */
  ratio: string;
  connection: string;
  conflict: boolean;
  flooded: boolean;
  tookBreak: boolean;
  need: string;
}

export type PartnerCheckinFields = Omit<PartnerCheckin, 'weekStart' | 'ratio'>;

export interface OneOnOne {
  id: number;
  childId: number;
  childName: string;
  loggedOn: DateStr;
  minutes: number;
  promiseKept: boolean;
  moment: boolean;
  reflection: string;
  word: string;
}

export type NewOneOnOne = Omit<OneOnOne, 'id' | 'childName' | 'loggedOn'>;

export interface KidOverview {
  member: HouseholdMember;
  choresDone: number;
  choresToday: number;
  pointsToday: number;
  weekPoints: number;
  bank: number;
  openHomework: number;
  overdueHomework: number;
  pendingRewards: number;
  curfew: Curfew;
  lastSignIn: string | null;
}

export interface FamilyResponse {
  weekStart: DateStr;
  partner: PartnerCheckin | null;
  kids: KidOverview[];
  oneOnOnes: OneOnOne[];
}

/* ---------- household admin ---------- */

export interface RosterMember extends HouseholdMember {
  xpTrack: XpTrack;
  email: string | null;
  archived: boolean;
  hasPin: boolean;
  invite: { status: 'pending' | 'accepted' | 'expired'; sentAt: string } | null;
  isYou: boolean;
}

export interface HouseholdAdminResponse {
  members: RosterMember[];
  devices: KidDevice[];
}

export interface MemberFields {
  name: string;
  kind: MemberKind;
  age: number | null;
  xpTrack: XpTrack;
  email: string | null;
}

export interface NewInvite {
  name: string;
  email: string;
  xpTrack: XpTrack;
}

export interface InviteCreated {
  /** Shown once; only a hash is stored. */
  link: string;
  member: RosterMember;
}

export interface InvitePreview {
  name: string;
  /** Masked, e.g. "k***@gmail.com". */
  email: string;
  household: string;
}

export interface KidDevice {
  id: number;
  label: string;
  kids: string[];
  lastSeenAt: string;
  isThisDevice: boolean;
}

export interface DeviceKidsResponse {
  kids: Array<{ key: string; name: string }>;
}

/* ---------- adult engine: check-in, tasks, review, habits, daily score ---------- */

export const NERVOUS = ['Calm', 'Buzzing', 'Fried'] as const;
export const SLEEP = ['Poor', 'OK', 'Good', 'Great'] as const;
export const PRIORITIES = ['Critical', 'Important', 'Later'] as const;
export const ENERGIES = ['High Brain', 'Low Brain', 'Body-only'] as const;
export const CONTEXTS = ['@Home', '@Work', '@Phone', '@Computer', '@Errands'] as const;
export const END_ENERGY = ['Drained', 'OK', 'Charged'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Energy = (typeof ENERGIES)[number];

export interface Checkin {
  nervous: string;
  sleep: string;
  fuel: string;
  grateful: string;
}

export interface Task {
  id: number;
  task: string;
  priority: Priority;
  energy: Energy;
  context: string;
  estMin: number | null;
  mit: boolean;
  done: boolean;
}

export interface NewTask {
  task: string;
  priority: Priority;
  energy: Energy;
  context: string;
  estMin: number | null;
  mit: boolean;
}

export interface Review {
  got: string;
  derailed: string;
  tomorrow: string;
  rsd: string;
  energyEnd: string;
}

export interface WeeklyHabit {
  id: number;
  name: string;
  /** Mon..Sun of the current week. */
  days: boolean[];
}

export interface DailyScore {
  labels: string[];
  parts: number[];
  total: number;
}

export interface MyDayResponse {
  member: HouseholdMember;
  date: DateStr;
  xp: XpStatus;
  checkin: Checkin | null;
  tasks: Task[];
  review: Review | null;
  habits: WeeklyHabit[];
  daily: DailyScore;
  /** Why tasks are in this order (from the morning check-in), if they were re-ordered. */
  energyNote: string | null;
}

export interface Achievement {
  name: string;
  desc: string;
  xp: number;
  unlocked: boolean;
  date: DateStr | null;
}

/* ---------- brain dump ---------- */

export interface DumpItem {
  id: number;
  note: string;
  capturedOn: DateStr;
  status: 'open' | 'task' | 'done';
  taskId: number | null;
}

export interface DumpResponse {
  open: DumpItem[];
  triaged: DumpItem[];
}

export interface TriageRequest {
  to: 'task' | 'done';
  priority?: Priority;
  energy?: Energy;
  mit?: boolean;
}

/* ---------- battles + red alert ---------- */

export interface Boss {
  name: string;
  desc: string;
}

export interface BattleEntry {
  id: number;
  name: string;
  status: 'active' | 'done' | 'replaced';
  startedOn: DateStr;
  doneOn: DateStr | null;
}

export interface BattlesResponse {
  active: BattleEntry | null;
  bosses: Boss[];
  history: BattleEntry[];
  xp: number;
  cadence: 'weekly' | 'monthly' | 'epic';
}

export interface RedAlertResponse {
  steps: string[];
  recent: Array<{ day: DateStr; trigger: string; stepsDone: number; stepsTotal: number }>;
}

export interface RedAlertRequest {
  trigger: string;
  stepsDone: number;
  note: string;
}

export interface RedAlertDone extends EarnResult {
  message: string;
}

/* ---------- Ask Hana + homework tutor ---------- */

export type ChatMode = 'companion' | 'tutor';

export interface ChatMessage {
  id: number;
  who: 'user' | 'hana';
  text: string;
  at: string;
}

export interface ChatState {
  mode: ChatMode;
  /** Model access is configured (real key, or the local stub). */
  available: boolean;
  history: ChatMessage[];
  /** Actions Hana proposed that are still waiting for your OK. */
  pending: HanaAction[];
}

export interface ChatSendResponse {
  reply: ChatMessage;
  history: ChatMessage[];
  /** What Hana did this turn, and anything waiting for your OK (companion only). */
  actions: HanaAction[];
}

/* ---------- money (read-only) ---------- */

export type MoneyProviderKind = 'plaid' | 'fake' | 'none';

export interface MoneyAccount {
  id: number;
  name: string;
  mask: string;
  type: string;
  subtype: string;
  current: number | null;
  available: number | null;
  institution: string;
}

export interface MoneyTransaction {
  id: number;
  date: DateStr;
  name: string;
  merchant: string;
  /** Plaid convention: positive = money out, negative = money in. */
  amount: number;
  category: string;
  pending: boolean;
  accountName: string;
}

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export interface Recurring {
  merchant: string;
  /** Typical amount (positive). */
  amount: number;
  cadence: Cadence;
  lastDate: DateStr;
  nextDate: DateStr;
  /** Normalized monthly cost (positive). */
  monthly: number;
  count: number;
}

export interface SafeToSpend {
  amount: number;
  checking: number;
  /** Recurring charges expected before `until`. */
  upcoming: Array<{ merchant: string; amount: number; date: DateStr }>;
  /** Next detected paycheck, or 14 days out when none is detected. */
  until: DateStr;
  basis: 'paycheck' | '14-days';
}

export interface MoneyItem {
  id: number;
  institution: string;
  lastSyncedAt: string | null;
  syncError: string;
}

export interface MoneyResponse {
  provider: MoneyProviderKind;
  items: MoneyItem[];
  accounts: MoneyAccount[];
  safeToSpend: SafeToSpend | null;
  subscriptions: Recurring[];
  income: Recurring[];
  transactions: MoneyTransaction[];
}

export interface LinkTokenResponse {
  provider: MoneyProviderKind;
  linkToken: string;
}

export interface ExchangeRequest {
  publicToken: string;
  institution: string;
}
/* ================= build 4: body-style programs ================= */

export const BUILDS = [
  'lean_athletic',
  'v_taper',
  'thick_powerful',
  'shredded',
  'strong_dense',
  'toned_athletic',
  'hourglass',
  'strong_curvy',
  'lean_runner',
] as const;
export type BuildKey = (typeof BUILDS)[number];

export interface BuildInfo {
  key: BuildKey;
  group: 'men' | 'women';
  label: string;
  /** Plain-spoken description of the look. */
  look: string;
  /** Default daily protein from food before shakes (g); user-adjustable. */
  foodProteinDefault: number;
}

export const BUILD_INFO: Record<BuildKey, BuildInfo> = {
  lean_athletic: {
    key: 'lean_athletic',
    group: 'men',
    label: 'Lean Athletic',
    look: 'Visible abs, capped shoulders, a solid chest and arms with a wide back — you look like you play a sport. Leanness is the product, not size.',
    foodProteinDefault: 100,
  },
  v_taper: {
    key: 'v_taper',
    group: 'men',
    label: 'Classic V-Taper',
    look: 'Broad shoulders and lats tapering to a narrow waist, with full chest and arms. The classic "built" silhouette in a T-shirt.',
    foodProteinDefault: 100,
  },
  thick_powerful: {
    key: 'thick_powerful',
    group: 'men',
    label: 'Thick & Powerful',
    look: 'Big, heavy and strong everywhere — thick traps, back and legs. You eat in a surplus and move serious weight on the big lifts.',
    foodProteinDefault: 100,
  },
  shredded: {
    key: 'shredded',
    group: 'men',
    label: 'Shredded',
    look: 'Very lean with sharp detail. You keep lifting heavy while you diet so the muscle stays and the fat goes.',
    foodProteinDefault: 100,
  },
  strong_dense: {
    key: 'strong_dense',
    group: 'men',
    label: 'Strong & Dense',
    look: 'Compact and hard, built from low-rep strength work — strong for your size rather than big for your size.',
    foodProteinDefault: 100,
  },
  toned_athletic: {
    key: 'toned_athletic',
    group: 'women',
    label: 'Toned Athletic',
    look: 'Fit and defined all over with real endurance — full-body strength plus regular cardio. Looks great and can keep up.',
    foodProteinDefault: 80,
  },
  hourglass: {
    key: 'hourglass',
    group: 'women',
    label: 'Hourglass / Glute-Focused',
    look: 'Fuller, rounder glutes and a defined waist. Two to three lower-body days a week built around hip thrusts, squats and RDLs.',
    foodProteinDefault: 80,
  },
  strong_curvy: {
    key: 'strong_curvy',
    group: 'women',
    label: 'Strong & Curvy',
    look: 'Balanced muscle with shape — sculpted shoulders and back over strong legs. Curvy and clearly strong.',
    foodProteinDefault: 80,
  },
  lean_runner: {
    key: 'lean_runner',
    group: 'women',
    label: 'Lean Runner',
    look: 'Light, lean and fast. Running leads, with one or two strength sessions a week to keep muscle and stay injury-proof.',
    foodProteinDefault: 80,
  },
};

export type NutritionMode = 'gaining' | 'cutting' | 'recomp' | 'maintenance';
export type PhaseKind = 'foundation' | 'hypertrophy' | 'strength' | 'cut' | 'maintenance' | 'deload';
export type TrainingLevel = 'beginner' | 'experienced';

/** Protein in g per lb bodyweight per day — same for men and women. */
export const PROTEIN_G_PER_LB: Record<NutritionMode, { min: number; max: number; target: number }> = {
  // 0.73 is the breakpoint; 1.0 is the ceiling (never higher).
  gaining: { min: 0.7, max: 1.0, target: 0.8 },
  // Spec default 1.0–1.1.
  cutting: { min: 0.8, max: 1.2, target: 1.05 },
  recomp: { min: 0.8, max: 1.0, target: 0.9 },
  maintenance: { min: 0.65, max: 0.73, target: 0.7 },
};

/** Per-meal protein: 0.11–0.14 g/lb (≈20–40 g), across 3–5 meals. */
export const PROTEIN_PER_MEAL_G_PER_LB = { min: 0.11, max: 0.14 } as const;
export const SHAKE_PROTEIN_G = 25;

export interface ShakeMath {
  proteinTarget: number;
  foodProtein: number;
  shakes: number;
  /** e.g. "2 shakes/day to hit 180g protein" */
  label: string;
}

/** shakes/day = (bodyweight × phase target − food protein) ÷ 25, rounded, never below 0. */
export function shakesPerDay(bodyweightLb: number, mode: NutritionMode, foodProtein: number): ShakeMath {
  const proteinTarget = Math.round(bodyweightLb * PROTEIN_G_PER_LB[mode].target);
  const shakes = Math.max(0, Math.round((proteinTarget - foodProtein) / SHAKE_PROTEIN_G));
  return {
    proteinTarget,
    foodProtein,
    shakes,
    label: `${shakes} shake${shakes === 1 ? '' : 's'}/day to hit ${proteinTarget}g protein`,
  };
}

export interface ProgramPhase {
  kind: PhaseKind;
  name: string;
  weekStart: number;
  weekEnd: number;
  nutrition: NutritionMode;
  focus: string;
  /** Target weekly bodyweight change as % of bodyweight (+ gain, − loss). */
  weeklyChangePct: number;
}

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface ProgramStatus {
  build: BuildInfo;
  level: TrainingLevel;
  bodyweightLb: number;
  week: number;
  phase: ProgramPhase;
  phases: ProgramPhase[];
  macros: Macros;
  shakes: ShakeMath;
  cardio: string;
  /** Protein planned today from the meal plan (+ shakes) vs target. */
  plannedProtein: number;
}

export interface SetBuildRequest {
  build: BuildKey;
  bodyweightLb: number;
  level: TrainingLevel;
  foodProtein?: number;
}
/* ================= build 4: school, lectures, study library ================= */

export interface ClassInfo {
  id: number;
  name: string;
  teacher: string;
  room: string;
  school: string;
  color: string;
  days: Weekday[];
  startTime: string;
  source: 'manual' | 'classroom';
  lectureCount: number;
  cardCount: number;
}

export interface NewClass {
  name: string;
  teacher?: string;
  room?: string;
  school?: string;
  color?: string;
  days?: Weekday[];
  startTime?: string;
}

export type LectureStatus = 'uploaded' | 'transcribing' | 'structuring' | 'ready' | 'failed';
export type ScaffoldPart = 'summary' | 'key_points';

export interface LectureNotes {
  title: string;
  summary: string;
  sections: Array<{ heading: string; points: string[] }>;
  keyPoints: string[];
  terms: Array<{ term: string; definition: string }>;
}

export interface DetectedAssignment {
  id: number;
  title: string;
  due: DateStr | null;
  homeworkId: number | null;
  dismissed: boolean;
}

export interface LectureSummary {
  id: number;
  classId: number;
  title: string;
  recordedOn: DateStr;
  durationS: number;
  status: LectureStatus;
}

export interface Lecture extends LectureSummary {
  className: string;
  error: string;
  /** null while processing, or while the student still owes a draft (scaffold). */
  notes: LectureNotes | null;
  /** What the student drafts BEFORE seeing the AI notes ('none' = shown right away). */
  scaffold: 'none' | ScaffoldPart;
  revealed: boolean;
  drafts: Partial<Record<ScaffoldPart, string>>;
  assignments: DetectedAssignment[];
  cardCount: number;
}

export interface Flashcard {
  id: number;
  lectureId: number | null;
  front: string;
  back: string;
  explanation: string;
  /** Leitner box 1..5 (5 = known well). */
  box: number;
}

export interface StudyView {
  cls: ClassInfo;
  lectures: LectureSummary[];
  cards: Flashcard[];
  quiz: Array<{ date: DateStr; correct: number; total: number }>;
  accuracy: number | null;
}

export interface UploadLectureResponse {
  lecture: Lecture;
}

export interface Assignment {
  id: number;
  classId: number | null;
  className: string;
  name: string;
  due: DateStr | null;
  priority: 'High' | 'Medium' | 'Low';
  overdue: boolean;
  today: boolean;
}

export interface Exam {
  id: number;
  name: string;
  course: string;
  date: DateStr | null;
  daysLeft: number | null;
  prepCount: number;
}

export interface CampusContact {
  id: number;
  name: string;
  kind: string;
  phone: string;
  email: string;
  notes: string;
  visits: number;
}

export interface SchoolResponse {
  member: HouseholdMember;
  classes: ClassInfo[];
  todayClasses: ClassInfo[];
  assignments: Assignment[];
  exams: Exam[];
  campus: CampusContact[];
  studyToday: number;
  studyWeek: number;
  recordingAcknowledged: boolean;
}

/* ================= E2: identity tools ================= */

export interface IdentityResponse {
  fields: string[];
  anchor: Record<string, string>;
  questions: string[];
  month: string;
  reviews: Array<{ month: string; answers: string[] }>;
  /** Weekly head-of-household survey (this week's, if filled). */
  survey: HouseholdSurvey | null;
  mentalLoad: MentalLoadRow[];
}

export interface HouseholdSurvey {
  weekStart: DateStr;
  presence: number;
  reliability: number;
  emotional: number;
  followThrough: number;
  communication: number;
  moreOf: string;
  improved: string;
  workOn: string;
}

export interface MentalLoadRow {
  id: number;
  category: string;
  load: '' | 'Light' | 'Medium' | 'Heavy';
  owner: string;
  delegate: boolean;
}

/* ================= E3: manual money ================= */

export interface Bill {
  id: number;
  name: string;
  amount: number;
  dueDay: number | null;
  autopay: boolean;
}

export interface IncomeSource {
  id: number;
  source: string;
  amount: number;
}

export interface BillsResponse {
  bills: Bill[];
  income: IncomeSource[];
  totalBills: number;
  totalIncome: number;
  /** Income left after bills (monthly). */
  left: number;
  /** % of bills on autopay. */
  autopilot: number;
  lastCheck: { date: DateStr; anxiety: string; looked: boolean } | null;
  /** Bills due in the next 7 days. */
  dueSoon: Array<{ name: string; amount: number; date: DateStr }>;
}

/* ================= I: kid / teen money ================= */

export type LedgerKind = 'allowance' | 'cash' | 'gift' | 'earned' | 'spend' | 'to_goal' | 'from_goal';

export interface LedgerEntry {
  id: number;
  date: DateStr;
  amount: number;
  kind: LedgerKind;
  category: string;
  note: string;
}

export interface SavingsGoal {
  id: number;
  name: string;
  target: number;
  saved: number;
  pct: number;
  done: boolean;
}

export interface KidMoneyResponse {
  member: HouseholdMember;
  /** Spendable now: everything in, minus spending, minus what's set aside in goals. */
  spendable: number;
  allowance: { amount: number; weekday: Weekday; lastPaid: DateStr | null } | null;
  ledger: LedgerEntry[];
  goals: SavingsGoal[];
  /** Spending by category over the last 30 days. */
  categories: Array<{ category: string; spent: number }>;
  isTeen: boolean;
  /** Teen read-only bank link (parent-completed), when linked. */
  bank: { institution: string; accounts: MoneyAccount[]; recent: MoneyTransaction[] } | null;
  bankLinkAllowed: boolean;
  /** Grown-ups can add money and set the allowance; kids record their own spending. */
  canManage: boolean;
}

/* ================= H: engagement ================= */

export interface Quest {
  id: number;
  code: string;
  title: string;
  progress: number;
  goal: number;
  reward: number;
  claimed: boolean;
  done: boolean;
}

export interface FamilyChallenge {
  title: string;
  progress: number;
  goal: number;
  done: boolean;
  /** Who chipped in (celebration only — no ranking). */
  helpers: string[];
}

export interface WinItem {
  at: string;
  who: string;
  text: string;
  emoji: string;
}

export interface EngagementResponse {
  quests: Quest[];
  challenge: FamilyChallenge | null;
  wins: WinItem[];
  sunday: { isSunday: boolean; done: boolean; highlight: string; weekPoints: Array<{ name: string; points: number }> } | null;
  firstRunDone: boolean;
  role: 'kid' | 'teen' | 'adult' | 'solo' | 'student';
  theme: 'system' | 'light' | 'dark';
  accent: string;
}

export interface PrivateNote {
  id: number;
  body: string;
  at: string;
}

/* ================= F: push notifications ================= */

export interface NotificationPrefs {
  enabled: boolean;
  bills: boolean;
  chores: boolean;
  homework: boolean;
  sendAt: string;
  frequency: 'daily' | 'weekdays' | 'weekly';
  quietStart: string;
  quietEnd: string;
}

export interface NotificationsResponse {
  prefs: NotificationPrefs;
  /** Public VAPID key for the browser's PushManager (null = push not configured on the server). */
  vapidPublicKey: string | null;
  subscriptions: number;
  /** What the next batched nudge would say (preview). */
  preview: { title: string; body: string } | null;
}

/* ================= G: Hana actions ================= */

export interface HanaAction {
  id: number;
  tool: string;
  summary: string;
  /** Destructive actions wait for an in-chat confirmation. */
  destructive: boolean;
  status: 'pending' | 'done' | 'cancelled' | 'failed';
  result: string;
}

export interface ChatTurnResult {
  reply: ChatMessage;
  history: ChatMessage[];
  /** Things Hana did this turn, and anything waiting for your OK. */
  actions: HanaAction[];
}
/* ================= billing + admin ================= */

export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'comped';
/** What the household sees: a lapsed trial shows as trial_ended (the app keeps working). */
export type BillingDisplayStatus = BillingStatus | 'trial_ended';

export interface BillingPlan {
  id: number;
  code: string;
  name: string;
  /** null = price not decided yet. */
  priceCents: number | null;
  currency: string;
  interval: 'month' | 'year';
  active: boolean;
  isDefault: boolean;
}

export interface BillingResponse {
  plan: BillingPlan | null;
  status: BillingDisplayStatus;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  paymentMethod: { brand: string; last4: string; test: boolean } | null;
  /** none = payments not live; stub = test card only, never charges. */
  provider: 'none' | 'stub';
  canManage: boolean;
}

export interface AdminHousehold {
  id: number;
  name: string;
  type: HouseholdType;
  members: number;
  createdAt: string;
  plan: string | null;
  status: BillingDisplayStatus;
  trialEndsAt: string | null;
  monthlyCents: number;
}

export interface AdminDashboard {
  households: AdminHousehold[];
  plans: BillingPlan[];
  totals: {
    households: number;
    trialing: number;
    trialEnded: number;
    active: number;
    pastDue: number;
    canceled: number;
    comped: number;
    trialsEndingThisWeek: number;
    /** Monthly recurring revenue from active households (yearly ÷ 12), in cents. */
    mrrCents: number;
    /** Active households whose plan has no price yet. */
    unpriced: number;
  };
  provider: 'none' | 'stub';
}
