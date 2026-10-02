/**
 * Meals: the meal library, each member's week of meals, and the shared
 * household grocery list. Ported from apiHealthMeals / apiHealthMeal /
 * apiMealWeek* / apiGrocery* / apiGroceryFromWeek.
 */
import { Router } from 'express';
import type {
  GroceryFromWeekResult,
  GroceryItem,
  GroceryState,
  HouseholdMember,
  MealDetail,
  MealListResponse,
  MealPlanResponse,
  MealSummary,
  Weekday,
} from '@myday/shared';
import { WEEKDAYS } from '@myday/shared';
import { pool, tx, type Db } from '../db.js';
import { isoToWeekday, weekdayToIso } from '../lib/dates.js';
import { mergeIngredientLines, parseIngredient, formatQty } from '../lib/ingredients.js';
import { bool, HttpError, idParam, str } from '../lib/http.js';
import { self, targetMember } from '../lib/members.js';

export const mealsRouter = Router();

interface MealRow {
  id: number;
  title: string;
  cuisine: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  ingredients: string[];
  steps: string[];
}

mealsRouter.get('/api/meals', async (req, res) => {
  const cuisine = typeof req.query.cuisine === 'string' ? req.query.cuisine : '';
  const { rows } = await pool.query<MealRow>('SELECT id, title, cuisine, calories, protein FROM meals ORDER BY id');
  const cuisines = [...new Set(rows.map((r) => r.cuisine))].sort();
  const meals: MealSummary[] = rows
    .filter((r) => !cuisine || r.cuisine === cuisine)
    .map((r) => ({ id: r.id, title: r.title, cuisine: r.cuisine, calories: r.calories, protein: r.protein }));
  const out: MealListResponse = { meals, cuisines };
  res.json(out);
});

mealsRouter.get('/api/meals/:id', async (req, res) => {
  const { rows } = await pool.query<MealRow>('SELECT * FROM meals WHERE id = $1', [idParam(req.params.id)]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Meal not found');
  const out: MealDetail = { ...r };
  res.json(out);
});

/* ---------- the week's meal plan (per member) ---------- */

async function planFor(member: HouseholdMember, db: Db = pool): Promise<MealPlanResponse> {
  const { rows } = await db.query<{ meal_id: number; title: string; cuisine: string; day: number | null }>(
    `SELECT e.meal_id, m.title, m.cuisine, e.day
       FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id
      WHERE e.member_id = $1 ORDER BY e.added_at, e.id`,
    [member.id],
  );
  return {
    member,
    meals: rows.map((r) => ({
      mealId: r.meal_id,
      title: r.title,
      cuisine: r.cuisine,
      day: r.day === null ? null : isoToWeekday(r.day),
    })),
  };
}

mealsRouter.get('/api/meal-plan', async (req, res) => {
  res.json(await planFor(await targetMember(req)));
});

mealsRouter.post('/api/meal-plan', async (req, res) => {
  const member = await targetMember(req);
  const mealId = idParam((req.body as { mealId?: unknown }).mealId);
  const { rows } = await pool.query('SELECT 1 FROM meals WHERE id = $1', [mealId]);
  if (!rows.length) throw new HttpError(404, 'Meal not found');
  await pool.query(
    'INSERT INTO meal_plan_entries (member_id, meal_id) VALUES ($1, $2) ON CONFLICT (member_id, meal_id) DO NOTHING',
    [member.id, mealId],
  );
  res.json(await planFor(member));
});

mealsRouter.patch('/api/meal-plan/:mealId', async (req, res) => {
  const member = await targetMember(req);
  const raw = (req.body as { day?: unknown }).day;
  let day: Weekday | null = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    const w = WEEKDAYS.find((d) => d === raw);
    if (!w) throw new HttpError(400, 'day must be Mon..Sun or null');
    day = w;
  }
  await pool.query('UPDATE meal_plan_entries SET day = $3 WHERE member_id = $1 AND meal_id = $2', [
    member.id,
    idParam(req.params.mealId),
    day === null ? null : weekdayToIso(day),
  ]);
  res.json(await planFor(member));
});

mealsRouter.delete('/api/meal-plan/:mealId', async (req, res) => {
  const member = await targetMember(req);
  await pool.query('DELETE FROM meal_plan_entries WHERE member_id = $1 AND meal_id = $2', [
    member.id,
    idParam(req.params.mealId),
  ]);
  res.json(await planFor(member));
});

mealsRouter.delete('/api/meal-plan', async (req, res) => {
  const member = await targetMember(req);
  await pool.query('DELETE FROM meal_plan_entries WHERE member_id = $1', [member.id]);
  res.json(await planFor(member));
});

/* ---------- household grocery list ---------- */

async function grocery(db: Db = pool): Promise<GroceryState> {
  const { rows: items } = await db.query<{ id: number; item: string; qty: string; done: boolean; added_by: string }>(
    'SELECT id, item, qty, done, added_by FROM grocery_items ORDER BY id',
  );
  const { rows: staples } = await db.query<{ id: number; item: string }>(
    'SELECT id, item FROM grocery_staples ORDER BY id',
  );
  return {
    items: items.map((r): GroceryItem => ({ id: r.id, item: r.item, qty: r.qty, done: r.done, addedBy: r.added_by })),
    staples,
  };
}

mealsRouter.get('/api/grocery', async (_req, res) => {
  res.json(await grocery());
});

mealsRouter.post('/api/grocery', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  await pool.query('INSERT INTO grocery_items (item, qty, added_by) VALUES ($1, $2, $3)', [
    str(b.item, 'item', 80, true),
    str(b.qty, 'qty', 20),
    self(req).key,
  ]);
  res.json(await grocery());
});

mealsRouter.patch('/api/grocery/:id', async (req, res) => {
  const done = bool((req.body as { done?: unknown }).done, 'done');
  await pool.query('UPDATE grocery_items SET done = $2 WHERE id = $1', [idParam(req.params.id), done]);
  res.json(await grocery());
});

mealsRouter.delete('/api/grocery/:id', async (req, res) => {
  await pool.query('DELETE FROM grocery_items WHERE id = $1', [idParam(req.params.id)]);
  res.json(await grocery());
});

mealsRouter.post('/api/grocery/clear-done', async (_req, res) => {
  await pool.query('DELETE FROM grocery_items WHERE done');
  res.json(await grocery());
});

mealsRouter.post('/api/grocery/staples', async (req, res) => {
  const item = str((req.body as { item?: unknown }).item, 'item', 80, true);
  await pool.query('INSERT INTO grocery_staples (item) VALUES ($1) ON CONFLICT (lower(item)) DO NOTHING', [item]);
  res.json(await grocery());
});

mealsRouter.delete('/api/grocery/staples/:id', async (req, res) => {
  await pool.query('DELETE FROM grocery_staples WHERE id = $1', [idParam(req.params.id)]);
  res.json(await grocery());
});

/**
 * Build the grocery list from a member's week of meals: merge quantities
 * across meals, merge into open list rows with the same ingredient, skip
 * exact duplicates, then top up staples. Same algorithm as apiGroceryFromWeek.
 */
mealsRouter.post('/api/grocery/from-week', async (req, res) => {
  const member = await targetMember(req);
  const result = await tx(async (c): Promise<Omit<GroceryFromWeekResult, 'grocery'>> => {
    const { rows: meals } = await c.query<{ ingredients: string[] }>(
      `SELECT m.ingredients FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id
        WHERE e.member_id = $1 ORDER BY e.added_at, e.id`,
      [member.id],
    );
    const raw = meals.flatMap((m) => m.ingredients.map((l) => l.trim()).filter(Boolean));
    const merged = mergeIngredientLines(raw);

    const { rows: list } = await c.query<{ id: number; item: string; done: boolean }>(
      'SELECT id, item, done FROM grocery_items ORDER BY id FOR UPDATE',
    );
    const have = new Set<string>();
    const open = new Map<string, { id: number; item: string }>();
    for (const r of list) {
      const it = r.item.trim();
      if (!it) continue;
      have.add(it.toLowerCase());
      if (!r.done) {
        const k = parseIngredient(it).key;
        if (!open.has(k)) open.set(k, { id: r.id, item: it });
      }
    }

    let added = 0;
    let skipped = 0;
    let mergedN = 0;
    for (const text of merged) {
      if (have.has(text.toLowerCase())) {
        skipped++;
        continue;
      }
      const nw = parseIngredient(text);
      const row = open.get(nw.key);
      if (row) {
        const cur = parseIngredient(row.item);
        if (cur.qty !== null && nw.qty !== null && cur.unit === nw.unit) {
          const combo = `${formatQty(cur.qty + nw.qty)}${cur.unit ? ` ${cur.unit}` : ''} ${cur.name}`;
          await c.query('UPDATE grocery_items SET item = $2 WHERE id = $1', [row.id, combo]);
          row.item = combo;
          have.add(combo.toLowerCase());
          mergedN++;
          continue;
        }
      }
      await c.query("INSERT INTO grocery_items (item, added_by) VALUES ($1, 'household')", [text]);
      have.add(text.toLowerCase());
      added++;
    }

    const { rows: staples } = await c.query<{ item: string }>('SELECT item FROM grocery_staples ORDER BY id');
    let sAdded = 0;
    for (const s of staples) {
      if (have.has(s.item.toLowerCase())) continue;
      await c.query("INSERT INTO grocery_items (item, added_by) VALUES ($1, 'household')", [s.item]);
      have.add(s.item.toLowerCase());
      sAdded++;
    }
    return { added, merged: mergedN, skipped, staples: sAdded, meals: meals.length };
  });
  const out: GroceryFromWeekResult = { ...result, grocery: await grocery() };
  res.json(out);
});
