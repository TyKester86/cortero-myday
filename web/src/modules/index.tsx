import type { ReactNode } from 'react';
import HomeChores from './chores/HomeChores';
import ManageChores from './chores/ManageChores';
import Homework from './homework/Homework';
import Rewards from './rewards/Rewards';
import Score from './score/Score';
import HealthToday from './health/HealthToday';
import HealthPlan from './health/HealthPlan';
import Meals from './meals/Meals';
import MealPlan from './meals/MealPlan';
import MealDetail from './meals/MealDetail';
import Grocery from './meals/Grocery';
import WeeklyPlan from './weekly/WeeklyPlan';
import MyDay from './day/MyDay';
import Money from './money/Money';
import Battles from './battles/Battles';
import RedAlert from './battles/RedAlert';
import BrainDump from './dump/BrainDump';
import Family from './family/Family';
import Household from './household/Household';
import Chat from './chat/Chat';
import School from './school/School';
import Recorder from './school/Recorder';
import Lecture from './school/Lecture';
import Study from './school/Study';
import ClassroomMode from './school/ClassroomMode';
import Identity from './identity/Identity';
import Bills from './money/Bills';
import KidMoney from './kidmoney/KidMoney';
import Wins from './engagement/Wins';
import Focus from './engagement/Focus';
import Private from './engagement/Private';
import Settings from './settings/Settings';
import Records from './records/Records';
import CommandCenter from './desk/CommandCenter';
import Setup from '../Onboarding';
import Home from './desk/Home';
import Billing from './billing/Billing';
import Admin from './billing/Admin';
import Invest from './invest/Invest';
import Circles, { Circle, Moderation } from './circles/Circles';

/** Who sees a route. 'tutor' = kids plus grown-ups on the student track. */
export type Audience = 'all' | 'adult' | 'kid' | 'tutor' | 'admin';

/**
 * Module registry: one entry per route. Each module owns a folder under
 * modules/ and its rows here; the shell (App.tsx) needs no changes.
 */
export interface ModuleRoute {
  path: string;
  element: ReactNode;
  audience: Audience;
  /** Kids younger than this don't see the route at all (e.g. Circles: 13+). */
  minKidAge?: number;
  /** Shown in navigation when set: in the bottom bar for the listed audiences, otherwise in the ☰ menu. */
  nav?: { label: string; icon: string; tabFor?: Array<'kid' | 'adult'> };
}

export const MODULES: ModuleRoute[] = [
  { path: '/', element: <Home />, audience: 'all', nav: { label: 'Today', icon: '✅', tabFor: ['kid', 'adult'] } },
  { path: '/chores', element: <HomeChores />, audience: 'all' },
  { path: '/day', element: <MyDay />, audience: 'adult', nav: { label: 'My day', icon: '🌅', tabFor: ['adult'] } },
  { path: '/family', element: <Family />, audience: 'adult', nav: { label: 'Family', icon: '💛', tabFor: ['adult'] } },
  { path: '/money', element: <Money />, audience: 'adult', nav: { label: 'Money', icon: '💵', tabFor: ['adult'] } },
  { path: '/hana', element: <Chat mode="companion" />, audience: 'adult', nav: { label: 'Ask Hana', icon: '💬', tabFor: ['adult'] } },
  { path: '/homework', element: <Homework />, audience: 'all', nav: { label: 'Homework', icon: '📚', tabFor: ['kid'] } },
  { path: '/tutor', element: <Chat mode="tutor" />, audience: 'tutor', nav: { label: 'Helper', icon: '🧑‍🏫', tabFor: ['kid'] } },
  { path: '/rewards', element: <Rewards />, audience: 'all', nav: { label: 'Rewards', icon: '🎁', tabFor: ['kid'] } },
  { path: '/score', element: <Score />, audience: 'all', nav: { label: 'Score', icon: '⭐', tabFor: ['kid'] } },
  { path: '/health', element: <HealthToday />, audience: 'all', nav: { label: 'Health', icon: '💪' } },
  { path: '/health/plan', element: <HealthPlan />, audience: 'all' },
  { path: '/meals', element: <Meals />, audience: 'all', nav: { label: 'Meals', icon: '🍽' } },
  { path: '/meals/plan', element: <MealPlan />, audience: 'all' },
  { path: '/meals/grocery', element: <Grocery />, audience: 'all' },
  { path: '/meals/:id', element: <MealDetail />, audience: 'all' },
  { path: '/weekly', element: <WeeklyPlan />, audience: 'all', nav: { label: 'Weekly plan', icon: '🗓' } },
  { path: '/dump', element: <BrainDump />, audience: 'all', nav: { label: 'Brain dump', icon: '🧠' } },
  { path: '/battles', element: <Battles />, audience: 'adult', nav: { label: 'Boss battles', icon: '⚔️' } },
  { path: '/red-alert', element: <RedAlert />, audience: 'adult', nav: { label: 'Red Alert', icon: '🚨' } },
  { path: '/chores/manage', element: <ManageChores />, audience: 'adult', nav: { label: 'Manage chores', icon: '🧹' } },
  { path: '/household', element: <Household />, audience: 'adult', nav: { label: 'Household', icon: '🏠' } },
  { path: '/school', element: <School />, audience: 'all', nav: { label: 'School', icon: '🎒' } },
  { path: '/record', element: <Recorder />, audience: 'all' },
  { path: '/lectures/:id', element: <Lecture />, audience: 'all' },
  { path: '/study/:classId', element: <Study />, audience: 'all' },
  { path: '/classroom-mode', element: <ClassroomMode />, audience: 'all' },
  { path: '/wins', element: <Wins />, audience: 'all', nav: { label: 'Family wins', icon: '🏆' } },
  { path: '/my-money', element: <KidMoney />, audience: 'all', nav: { label: 'Kid money', icon: '🐷' } },
  { path: '/focus', element: <Focus />, audience: 'kid', nav: { label: 'Focus timer', icon: '⏱' } },
  { path: '/private', element: <Private />, audience: 'kid', nav: { label: 'My space', icon: '🔒' } },
  { path: '/bills', element: <Bills />, audience: 'adult', nav: { label: 'Bills & income', icon: '🧾' } },
  { path: '/identity', element: <Identity />, audience: 'adult', nav: { label: 'Identity', icon: '🪞' } },
  { path: '/records', element: <Records />, audience: 'adult', nav: { label: 'Records', icon: '🗂' } },
  { path: '/command', element: <CommandCenter />, audience: 'adult', nav: { label: 'Command center', icon: '🖥' } },
  { path: '/setup', element: <Setup />, audience: 'adult' },
  { path: '/invest', element: <Invest />, audience: 'adult', nav: { label: 'Investments', icon: '📈' } },
  { path: '/circles', element: <Circles />, audience: 'all', minKidAge: 13, nav: { label: 'Circles', icon: '🫂' } },
  { path: '/circles/moderation', element: <Moderation />, audience: 'adult' },
  { path: '/circles/:id', element: <Circle />, audience: 'all', minKidAge: 13 },
  { path: '/billing', element: <Billing />, audience: 'adult', nav: { label: 'Billing', icon: '💳' } },
  { path: '/admin', element: <Admin />, audience: 'admin', nav: { label: 'Admin', icon: '🛠' } },
  { path: '/settings', element: <Settings />, audience: 'all', nav: { label: 'Settings', icon: '⚙️' } },
  // Old link from build 2; kid PINs now live on the Household page.
  { path: '/kids', element: <Household />, audience: 'adult' },
];
