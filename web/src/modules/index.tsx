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

/** Who sees a route. 'tutor' = kids plus grown-ups on the student track. */
export type Audience = 'all' | 'adult' | 'kid' | 'tutor';

/**
 * Module registry: one entry per route. Each module owns a folder under
 * modules/ and its rows here; the shell (App.tsx) needs no changes.
 */
export interface ModuleRoute {
  path: string;
  element: ReactNode;
  audience: Audience;
  /** Shown in navigation when set: in the bottom bar for the listed audiences, otherwise in the ☰ menu. */
  nav?: { label: string; icon: string; tabFor?: Array<'kid' | 'adult'> };
}

export const MODULES: ModuleRoute[] = [
  { path: '/', element: <HomeChores />, audience: 'all', nav: { label: 'Today', icon: '✅', tabFor: ['kid', 'adult'] } },
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
  // Old link from build 2; kid PINs now live on the Household page.
  { path: '/kids', element: <Household />, audience: 'adult' },
];
