import { lazy, type ReactNode } from 'react';
import HomeChores from './chores/HomeChores';
const ManageChores = lazy(() => import('./chores/ManageChores'));
const Homework = lazy(() => import('./homework/Homework'));
const Rewards = lazy(() => import('./rewards/Rewards'));
const Score = lazy(() => import('./score/Score'));
const HealthToday = lazy(() => import('./health/HealthToday'));
// Community (grown-ups 18+ only — never a kid route).
const Village = lazy(() => import('./community/Community').then((m) => ({ default: m.Village })));
const VillageThreadPage = lazy(() => import('./community/Community').then((m) => ({ default: m.VillageThreadPage })));
const Feed = lazy(() => import('./community/Community').then((m) => ({ default: m.Feed })));
const PersonPage = lazy(() => import('./community/Community').then((m) => ({ default: m.PersonPage })));
const CommunityModeration = lazy(() => import('./community/Community').then((m) => ({ default: m.CommunityModeration })));
const HealthPlan = lazy(() => import('./health/HealthPlan'));
const Meals = lazy(() => import('./meals/Meals'));
const MealPlan = lazy(() => import('./meals/MealPlan'));
const MealDetail = lazy(() => import('./meals/MealDetail'));
const Grocery = lazy(() => import('./meals/Grocery'));
const WeeklyPlan = lazy(() => import('./weekly/WeeklyPlan'));
const MyDay = lazy(() => import('./day/MyDay'));
const Money = lazy(() => import('./money/Money'));
const Battles = lazy(() => import('./battles/Battles'));
const RedAlert = lazy(() => import('./battles/RedAlert'));
const BrainDump = lazy(() => import('./dump/BrainDump'));
const Family = lazy(() => import('./family/Family'));
const Household = lazy(() => import('./household/Household'));
const Chat = lazy(() => import('./chat/Chat'));
const School = lazy(() => import('./school/School'));
import Recorder from './school/Recorder';
const Lecture = lazy(() => import('./school/Lecture'));
const Lectures = lazy(() => import('./school/Lectures'));
import { Navigate } from 'react-router';
const Study = lazy(() => import('./school/Study'));
const ClassroomMode = lazy(() => import('./school/ClassroomMode'));
const Identity = lazy(() => import('./identity/Identity'));
const Bills = lazy(() => import('./money/Bills'));
const KidMoney = lazy(() => import('./kidmoney/KidMoney'));
const Wins = lazy(() => import('./engagement/Wins'));
const Focus = lazy(() => import('./engagement/Focus'));
const Private = lazy(() => import('./engagement/Private'));
import Settings from './settings/Settings';
const Records = lazy(() => import('./records/Records'));
const CommandCenter = lazy(() => import('./desk/CommandCenter'));
import Setup from '../Onboarding';
import Home from './desk/Home';
const Billing = lazy(() => import('./billing/Billing'));
import Admin from './billing/Admin';
const Invest = lazy(() => import('./invest/Invest'));
import Circles, { Circle, Moderation } from './circles/Circles';
import Care from './care/Care';
import MeHub from './desk/MeHub';
import type { ModuleKey } from '@myday/shared';

/** Who sees a route. 'tutor' = kids plus grown-ups on the student track. */
export type Audience = 'all' | 'adult' | 'kid' | 'tutor' | 'admin';

/**
 * Module registry: one entry per route. Each module owns a folder under
 * modules/ and its rows here; the shell (App.tsx) needs no changes.
 */
export type NavGroup = 'today' | 'me' | 'family' | 'home' | 'money' | 'school' | 'connect' | 'account';
export const NAV_GROUPS: Array<{ key: NavGroup; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'me', label: 'Me' },
  { key: 'family', label: 'Family' },
  { key: 'home', label: 'Home' },
  { key: 'money', label: 'Money' },
  { key: 'school', label: 'School' },
  { key: 'connect', label: 'Help & people' },
  { key: 'account', label: 'Account' },
];

export interface ModuleRoute {
  path: string;
  element: ReactNode;
  audience: Audience;
  /** Kids younger than this don't see the route at all (e.g. Circles: 13+). */
  minKidAge?: number;
  /** Optional part a household can turn off (Settings → What's in your MyDay). */
  module?: ModuleKey;
  /** A grown-up's view of the kids' things: hidden when the household has no kids. */
  kidsOnly?: boolean;
  /** Family life (kids and/or a partner): hidden for a solo grown-up until a kid or a second signed-in grown-up joins. */
  familyOnly?: boolean;
  /** Where it sits in the menu for a solo grown-up (instead of nav.group). */
  soloGroup?: NavGroup;
  /**
   * Navigation: bottom-bar tab for the listed audiences (with an optional
   * shorter tab label); otherwise listed under its group in the menu. `icon`
   * is a NavIcon key (components/NavIcon).
   */
  nav?: { label: string; icon: string; group: NavGroup; tabFor?: Array<'kid' | 'adult'>; tabLabel?: string; kidLabel?: string };
}

export const MODULES: ModuleRoute[] = [
  { path: '/', element: <Home />, audience: 'all', nav: { label: 'Today', icon: 'today', group: 'today', tabFor: ['kid', 'adult'] } },
  { path: '/chores', element: <HomeChores />, audience: 'all' },
  // Grown-ups: Today · Plan · Family · Money · Me. Kids: Today · Homework · Helper · Rewards · Score.
  { path: '/weekly', element: <WeeklyPlan />, audience: 'all', nav: { label: 'Plan', icon: 'weekly-plan', group: 'home', tabFor: ['adult'] } },
  { path: '/family', element: <Family />, audience: 'adult', familyOnly: true, nav: { label: 'Family', icon: 'family', group: 'family', tabFor: ['adult'] } },
  { path: '/money', element: <Money />, audience: 'adult', module: 'money', nav: { label: 'Money', icon: 'money', group: 'money', tabFor: ['adult'] } },
  { path: '/me', element: <MeHub />, audience: 'adult', nav: { label: 'Me', icon: 'everything', group: 'me', tabFor: ['adult'] } },
  { path: '/homework', element: <Homework />, audience: 'all', kidsOnly: true, nav: { label: 'Homework', icon: 'homework', group: 'family', tabFor: ['kid'] } },
  { path: '/tutor', element: <Chat mode="tutor" />, audience: 'tutor', nav: { label: 'Homework helper', icon: 'helper', group: 'school', tabFor: ['kid'], tabLabel: 'Helper' } },
  { path: '/rewards', element: <Rewards />, audience: 'all', kidsOnly: true, nav: { label: 'Rewards', icon: 'rewards', group: 'family', tabFor: ['kid'] } },
  { path: '/score', element: <Score />, audience: 'all', nav: { label: 'My progress', icon: 'my-progress', group: 'me', tabFor: ['kid'], tabLabel: 'Score' } },
  { path: '/day', element: <MyDay />, audience: 'adult', nav: { label: 'My day', icon: 'my-day', group: 'me' } },
  { path: '/hana', element: <Chat mode="companion" />, audience: 'adult', module: 'hana', nav: { label: 'Ask Hana', icon: 'hana', group: 'connect' } },
  { path: '/health', element: <HealthToday />, audience: 'all', module: 'health', nav: { label: 'Health', icon: 'health', group: 'me' } },
  { path: '/health/plan', element: <HealthPlan />, audience: 'all', module: 'health' },
  { path: '/meals', element: <Meals />, audience: 'all', module: 'meals', nav: { label: 'Meals', icon: 'meals', group: 'home' } },
  { path: '/meals/plan', element: <MealPlan />, audience: 'all', module: 'meals' },
  { path: '/meals/grocery', element: <Grocery />, audience: 'all', module: 'meals', nav: { label: 'Grocery list', icon: 'grocery-list', group: 'home' } },
  { path: '/meals/:id', element: <MealDetail />, audience: 'all', module: 'meals' },
  // Old/guessed link: the weekly calendar lives at /weekly.
  { path: '/plan', element: <Navigate to="/weekly" replace />, audience: 'all' },
  { path: '/dump', element: <BrainDump />, audience: 'all', module: 'dump', nav: { label: 'Brain dump', icon: 'brain-dump', group: 'me' } },
  { path: '/battles', element: <Battles />, audience: 'adult', module: 'challenges', nav: { label: 'Challenges', icon: 'challenges', group: 'me' } },
  { path: '/red-alert', element: <RedAlert />, audience: 'adult', module: 'challenges' },
  { path: '/chores/manage', element: <ManageChores />, audience: 'adult', familyOnly: true, nav: { label: 'Chores', icon: 'chores', group: 'family' } },
  { path: '/household', element: <Household />, audience: 'adult', soloGroup: 'account', nav: { label: 'Household', icon: 'household', group: 'family' } },
  { path: '/school', element: <School />, audience: 'all', module: 'school', nav: { label: 'School', icon: 'school', group: 'school' } },
  { path: '/lectures', element: <Lectures />, audience: 'all', module: 'school', nav: { label: 'Lectures', icon: 'lectures', group: 'school' } },
  { path: '/record', element: <Recorder />, audience: 'all', module: 'school' },
  { path: '/lectures/:id', element: <Lecture />, audience: 'all', module: 'school' },
  { path: '/study/:classId', element: <Study />, audience: 'all', module: 'school' },
  { path: '/classroom-mode', element: <ClassroomMode />, audience: 'all', module: 'school' },
  { path: '/wins', element: <Wins />, audience: 'all', familyOnly: true, nav: { label: 'Family wins', icon: 'family-wins', group: 'family' } },
  { path: '/my-money', element: <KidMoney />, audience: 'all', kidsOnly: true, nav: { label: 'Kid money', icon: 'piggy', group: 'family', kidLabel: 'My money' } },
  { path: '/focus', element: <Focus />, audience: 'all', module: 'focus', nav: { label: 'Focus timer', icon: 'focus-timer', group: 'me' } },
  { path: '/private', element: <Private />, audience: 'kid', nav: { label: 'My space', icon: 'lock', group: 'me' } },
  { path: '/bills', element: <Bills />, audience: 'adult', module: 'money', nav: { label: 'Bills & income', icon: 'bills-income', group: 'money' } },
  { path: '/identity', element: <Identity />, audience: 'adult', module: 'identity', nav: { label: 'Identity', icon: 'identity', group: 'me' } },
  { path: '/records', element: <Records />, audience: 'adult', module: 'records', nav: { label: 'Records', icon: 'records', group: 'me' } },
  // The desktop morning/evening view now lives inside Today; the old link still works.
  { path: '/command', element: <CommandCenter />, audience: 'adult' },
  { path: '/setup', element: <Setup />, audience: 'adult' },
  { path: '/invest', element: <Invest />, audience: 'adult', module: 'invest', nav: { label: 'Investments', icon: 'investments', group: 'money' } },
  { path: '/circles', element: <Circles />, audience: 'all', minKidAge: 13, module: 'circles', nav: { label: 'Circles', icon: 'circles', group: 'connect' } },
  { path: '/circles/moderation', element: <Moderation />, audience: 'adult' },
  { path: '/circles/:id', element: <Circle />, audience: 'all', minKidAge: 13, module: 'circles' },
  { path: '/village', element: <Village />, audience: 'adult', nav: { label: 'The Village', icon: 'village', group: 'connect' } },
  { path: '/village/:id', element: <VillageThreadPage />, audience: 'adult' },
  { path: '/feed', element: <Feed />, audience: 'adult', nav: { label: 'The Feed', icon: 'feed', group: 'connect' } },
  { path: '/people/:id', element: <PersonPage />, audience: 'adult' },
  { path: '/community/moderation', element: <CommunityModeration />, audience: 'admin' },
  { path: '/care', element: <Care />, audience: 'adult', module: 'care', nav: { label: 'Care team', icon: 'care', group: 'connect' } },
  { path: '/billing', element: <Billing />, audience: 'adult', nav: { label: 'Billing', icon: 'card', group: 'account' } },
  { path: '/admin', element: <Admin />, audience: 'admin', nav: { label: 'Admin', icon: 'admin', group: 'account' } },
  { path: '/settings', element: <Settings />, audience: 'all', nav: { label: 'Settings', icon: 'settings', group: 'account' } },
  // Old link from build 2; kid PINs now live on the Household page.
  { path: '/kids', element: <Household />, audience: 'adult' },
];
