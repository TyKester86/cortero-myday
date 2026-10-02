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
}

export interface ChatSendResponse {
  reply: ChatMessage;
  history: ChatMessage[];
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