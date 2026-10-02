import type { ReactNode } from 'react';
import HomeChores from './chores/HomeChores';
import ManageChores from './chores/ManageChores';
import Score from './score/Score';
import HealthToday from './health/HealthToday';
import HealthPlan from './health/HealthPlan';
import Meals from './meals/Meals';
import MealDetail from './meals/MealDetail';
import Grocery from './meals/Grocery';
import WeeklyPlan from './weekly/WeeklyPlan';

/**
 * Module registry: one entry per route. Later builds (Money, Battles, Brain
 * Dump, Family, Household, Ask Hana, Red Alert, Kids' School, the kid app)
 * each add their own folder under modules/ and their routes here — nothing
 * else in the shell changes.
 */
export interface ModuleRoute {
  path: string;
  element: ReactNode;
  /** Shown in the nav bar when set. */
  nav?: { label: string; icon: string };
  adultOnly?: boolean;
}

export const MODULES: ModuleRoute[] = [
  { path: '/', element: <HomeChores />, nav: { label: 'Today', icon: '✅' } },
  { path: '/chores/manage', element: <ManageChores />, nav: { label: 'Chores', icon: '🧹' }, adultOnly: true },
  { path: '/score', element: <Score />, nav: { label: 'Score', icon: '⭐' } },
  { path: '/health', element: <HealthToday />, nav: { label: 'Health', icon: '💪' } },
  { path: '/health/plan', element: <HealthPlan /> },
  { path: '/meals', element: <Meals />, nav: { label: 'Meals', icon: '🍽' } },
  { path: '/meals/grocery', element: <Grocery /> },
  { path: '/meals/:id', element: <MealDetail /> },
  { path: '/weekly', element: <WeeklyPlan />, nav: { label: 'Week', icon: '🗓' } },
];
