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
import KidAccess from './kids/KidAccess';

/**
 * Module registry: one entry per route. Later builds (Money, Battles, Brain
 * Dump, Family, Household, Ask Hana, Red Alert, Kids' School, the kid app)
 * each add their own folder under modules/ and their routes here — nothing
 * else in the shell changes.
 */
export interface ModuleRoute {
  path: string;
  element: ReactNode;
  /** 'tab' = bottom bar, 'menu' = header menu. Omit for sub-pages. */
  nav?: { label: string; icon: string; place: 'tab' | 'menu' };
  adultOnly?: boolean;
}

export const MODULES: ModuleRoute[] = [
  { path: '/', element: <HomeChores />, nav: { label: 'Today', icon: '✅', place: 'tab' } },
  { path: '/homework', element: <Homework />, nav: { label: 'Homework', icon: '📚', place: 'tab' } },
  { path: '/rewards', element: <Rewards />, nav: { label: 'Rewards', icon: '🎁', place: 'tab' } },
  { path: '/score', element: <Score />, nav: { label: 'Score', icon: '⭐', place: 'tab' } },
  { path: '/health', element: <HealthToday />, nav: { label: 'Health', icon: '💪', place: 'tab' } },
  { path: '/health/plan', element: <HealthPlan /> },
  { path: '/meals', element: <Meals />, nav: { label: 'Meals', icon: '🍽', place: 'tab' } },
  { path: '/meals/plan', element: <MealPlan /> },
  { path: '/meals/grocery', element: <Grocery /> },
  { path: '/meals/:id', element: <MealDetail /> },
  { path: '/weekly', element: <WeeklyPlan />, nav: { label: 'Weekly plan', icon: '🗓', place: 'menu' } },
  { path: '/chores/manage', element: <ManageChores />, nav: { label: 'Manage chores', icon: '🧹', place: 'menu' }, adultOnly: true },
  { path: '/kids', element: <KidAccess />, nav: { label: 'Kid sign-in', icon: '🔑', place: 'menu' }, adultOnly: true },
];
