/**
 * Meals: the meal library, each member's per-day plan for the week, and the
 * shared household grocery list with stores, favorites and ZIP. Ported from
 * apiHealthMeals / apiHealthMeal / apiMealWeek* / apiGrocery* /
 * apiGroceryFromWeek — with the script's double-build bug fixed.
 */
import { Router, type Request } from 'express';
import {
  MEAL_SLOTS,
  WEEKDAYS,
  type MealSlot,
  type Fulfillment,
  type GroceryChain,
  type GroceryFavorite,
  type GroceryFromWeekResult,
  type GroceryItem,
  type GroceryState,
  type HouseholdMember,
  type MealDetail,
  type MealListResponse,
  type MealPlanDay,
  type MealPlanEntry,
  type MealPlanResponse,
  type MealSummary,
  type NutritionMode,
  type Weekday,
} from '@myday/shared';
import { pool, tx, type Db } from '../db.js';
import { addDays, isoToWeekday, today, weekStart, weekdayToIso } from '../lib/dates.js';
import { formatQty, mergeIngredientLines, parseIngredient } from '../lib/ingredients.js';
import { bool, HttpError, idParam, str } from '../lib/http.js';
import { self, targetMember } from '../lib/members.js';
import { GROCERY_CHAINS } from '../lib/stores.js';
import { programStatus } from './program.js';

export const mealsRouter = Router();

interface MealRow {
  id: number;
  title: string;
  cuisine: string;
  region: string;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  ingredients: string[];
  steps: string[];
  tips: string[];
  image_url: string | null;
  prep_min: number | null;
  servings: number | null;
  phase_tags: NutritionMode[];
}

/** Every meal has a picture; anything imported without one gets the placeholder. */
const picture = (url: string | null): string => url ?? '/meals/_placeholder.svg';

const toSummary = (r: MealRow): MealSummary => ({
  id: r.id,
  title: r.title,
  cuisine: r.cuisine,
  region: r.region,
  calories: r.calories,
  protein: r.protein,
  imageUrl: picture(r.image_url),
  prepMin: r.prep_min,
  phaseTags: r.phase_tags,
});

/**
 * The library. ?cuisine= filters; ?phase=mine (or a phase name) keeps the meals
 * that suit that nutrition phase, highest protein density first.
 */
mealsRouter.get('/api/meals', async (req, res) => {
  const cuisine = typeof req.query.cuisine === 'string' ? req.query.cuisine : '';
  const region = typeof req.query.region === 'string' ? req.query.region : '';
  const { rows } = await pool.query<MealRow>(
    'SELECT id, title, cuisine, region, calories, protein, image_url, prep_min, phase_tags FROM meals ORDER BY id',
  );
  const cuisines = [...new Set(rows.map((r) => r.cuisine))].sort();
  const countries = cuisines.map((name) => {
    const mine = rows.filter((r) => r.cuisine === name);
    const regions = [...new Set(mine.map((r) => r.region).filter(Boolean))].sort();
    return { name, count: mine.length, regions: regions.map((rg) => ({ name: rg, count: mine.filter((r) => r.region === rg).length })) };
  });
  const me = req.member ? await programStatus(req.member.id) : null;
  const myPhase: NutritionMode | null = me?.phase.nutrition ?? null;
  const q = typeof req.query.phase === 'string' ? req.query.phase : '';
  const phase = q === 'mine' ? myPhase : (['gaining', 'cutting', 'recomp', 'maintenance'] as const).find((p) => p === q) ?? null;
  let list = rows.filter((r) => (!cuisine || r.cuisine === cuisine) && (!region || r.region === region));
  if (phase) {
    list = list
      .filter((r) => r.phase_tags.includes(phase))
      .sort((a, b) => (b.protein ?? 0) / (b.calories || 1) - (a.protein ?? 0) / (a.calories || 1));
  }
  const out: MealListResponse = { meals: list.map(toSummary), cuisines, countries, phase: myPhase };
  res.json(out);
});

mealsRouter.get('/api/meals/:id', async (req, res) => {
  const { rows } = await pool.query<MealRow>('SELECT * FROM meals WHERE id = $1', [idParam(req.params.id)]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Meal not found');
  const out: MealDetail = { ...toSummary(r), carbs: r.carbs, fat: r.fat, servings: r.servings, ingredients: r.ingredients, steps: r.steps, tips: r.tips ?? [] };
  res.json(out);
});

/* ---------- the week's meal plan (per member, per day) ---------- */

function parseDay(raw: unknown): Weekday | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const w = WEEKDAYS.find((d) => d === raw);
  if (!w) throw new HttpError(400, 'day must be Mon..Sun or null');
  return w;
}

function parseSlot(raw: unknown): MealSlot | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = MEAL_SLOTS.find((x) => x === raw);
  if (!s) throw new HttpError(400, 'slot must be breakfast, lunch, dinner or null');
  return s;
}

async function planFor(member: HouseholdMember, db: Db = pool): Promise<MealPlanResponse> {
  const { rows } = await db.query<{
    id: number;
    meal_id: number;
    title: string;
    cuisine: string;
    calories: number | null;
    protein: number | null;
    day: number | null;
    slot: MealSlot | null;
  }>(
    `SELECT e.id, e.meal_id, m.title, m.cuisine, m.calories, m.protein, e.day, e.slot
       FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id
      WHERE e.member_id = $1
      ORDER BY array_position(ARRAY['breakfast','lunch','dinner']::text[], e.slot) NULLS LAST, e.added_at, e.id`,
    [member.id],
  );
  const meals: MealPlanEntry[] = rows.map((r) => ({
    id: r.id,
    mealId: r.meal_id,
    title: r.title,
    cuisine: r.cuisine,
    calories: r.calories,
    protein: r.protein,
    day: r.day === null ? null : isoToWeekday(r.day),
    slot: r.slot,
  }));
  const t = today();
  const ws = weekStart(t);
  const days: MealPlanDay[] = WEEKDAYS.map((day, i) => {
    const onDay = meals.filter((m) => m.day === day);
    const date = addDays(ws, i);
    return {
      day,
      date,
      isToday: date === t,
      meals: onDay,
      calories: onDay.reduce((s, m) => s + (m.calories ?? 0), 0),
      protein: onDay.reduce((s, m) => s + (m.protein ?? 0), 0),
    };
  });
  return { member, weekStart: ws, days, unassigned: meals.filter((m) => m.day === null), meals };
}

mealsRouter.get('/api/meal-plan', async (req, res) => {
  res.json(await planFor(await targetMember(req)));
});

/** Add a meal to the week, optionally onto a day + slot. The same meal in the same day + slot twice is a no-op. */
mealsRouter.post('/api/meal-plan', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as { mealId?: unknown; day?: unknown; slot?: unknown };
  const mealId = idParam(b.mealId);
  const day = parseDay(b.day);
  const slot = parseSlot(b.slot);
  const { rows } = await pool.query('SELECT 1 FROM meals WHERE id = $1', [mealId]);
  if (!rows.length) throw new HttpError(404, 'Meal not found');
  await pool.query(
    `INSERT INTO meal_plan_entries (member_id, meal_id, day, slot)
     SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM meal_plan_entries
                         WHERE member_id = $1 AND meal_id = $2 AND day IS NOT DISTINCT FROM $3
                           AND slot IS NOT DISTINCT FROM $4)`,
    [member.id, mealId, day === null ? null : weekdayToIso(day), slot],
  );
  res.json(await planFor(member));
});

mealsRouter.patch('/api/meal-plan/:entryId', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as { day?: unknown; slot?: unknown };
  const id = idParam(req.params.entryId);
  // Omitted fields stay as they are.
  if (b.day !== undefined) {
    const day = parseDay(b.day);
    await pool.query('UPDATE meal_plan_entries SET day = $3 WHERE member_id = $1 AND id = $2', [member.id, id, day === null ? null : weekdayToIso(day)]);
  }
  if (b.slot !== undefined) {
    await pool.query('UPDATE meal_plan_entries SET slot = $3 WHERE member_id = $1 AND id = $2', [member.id, id, parseSlot(b.slot)]);
  }
  res.json(await planFor(member));
});

mealsRouter.delete('/api/meal-plan/:entryId', async (req, res) => {
  const member = await targetMember(req);
  await pool.query('DELETE FROM meal_plan_entries WHERE member_id = $1 AND id = $2', [
    member.id,
    idParam(req.params.entryId),
  ]);
  res.json(await planFor(member));
});

mealsRouter.delete('/api/meal-plan', async (req, res) => {
  const member = await targetMember(req);
  await pool.query('DELETE FROM meal_plan_entries WHERE member_id = $1', [member.id]);
  res.json(await planFor(member));
});

/* ---------- household grocery list + stores ---------- */

async function grocery(req: Request, db: Db = pool): Promise<GroceryState> {
  const me = self(req);
  const { rows: items } = await db.query<{ id: number; item: string; qty: string; done: boolean; added_by: string }>(
    'SELECT id, item, qty, done, added_by FROM grocery_items ORDER BY id',
  );
  const { rows: staples } = await db.query<{ id: number; item: string }>('SELECT id, item FROM grocery_staples ORDER BY id');
  const { rows: zip } = await db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'household_zip'");
  const { rows: custom } = await db.query<{ name: string; shop_url: string }>(
    'SELECT name, shop_url FROM custom_stores ORDER BY id',
  );
  const { rows: favs } = await db.query<{ store: string; fulfillment: Fulfillment; signed_in: boolean }>(
    'SELECT store, fulfillment, signed_in FROM grocery_favorites WHERE member_id = $1 ORDER BY id',
    [me.id],
  );
  const chains: GroceryChain[] = [
    ...GROCERY_CHAINS.map((c) => ({ ...c, custom: false })),
    ...custom.map(
      (c): GroceryChain => ({
        name: c.name,
        shopUrl: c.shop_url,
        orderUrl: c.shop_url,
        acctUrl: c.shop_url,
        pickup: 'check',
        delivery: 'check',
        note: 'Your store',
        custom: true,
      }),
    ),
  ];
  return {
    items: items.map((r): GroceryItem => ({ id: r.id, item: r.item, qty: r.qty, done: r.done, addedBy: r.added_by })),
    staples,
    zip: zip[0]?.value ?? '',
    chains,
    favorites: favs.map((f): GroceryFavorite => ({ store: f.store, fulfillment: f.fulfillment, signedIn: f.signed_in })),
  };
}

mealsRouter.get('/api/grocery', async (req, res) => {
  res.json(await grocery(req));
});

mealsRouter.post('/api/grocery', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  await pool.query('INSERT INTO grocery_items (item, qty, added_by) VALUES ($1, $2, $3)', [
    str(b.item, 'item', 80, true),
    str(b.qty, 'qty', 20),
    self(req).key,
  ]);
  res.json(await grocery(req));
});

mealsRouter.patch('/api/grocery/items/:id', async (req, res) => {
  const done = bool((req.body as { done?: unknown }).done, 'done');
  await pool.query('UPDATE grocery_items SET done = $2 WHERE id = $1', [idParam(req.params.id), done]);
  res.json(await grocery(req));
});

mealsRouter.delete('/api/grocery/items/:id', async (req, res) => {
  await pool.query('DELETE FROM grocery_items WHERE id = $1', [idParam(req.params.id)]);
  res.json(await grocery(req));
});

mealsRouter.post('/api/grocery/clear-done', async (req, res) => {
  await pool.query('DELETE FROM grocery_items WHERE done');
  res.json(await grocery(req));
});

mealsRouter.post('/api/grocery/staples', async (req, res) => {
  const item = str((req.body as { item?: unknown }).item, 'item', 80, true);
  await pool.query('INSERT INTO grocery_staples (item) VALUES ($1) ON CONFLICT (household_id, lower(item)) DO NOTHING', [item]);
  res.json(await grocery(req));
});

mealsRouter.delete('/api/grocery/staples/:id', async (req, res) => {
  await pool.query('DELETE FROM grocery_staples WHERE id = $1', [idParam(req.params.id)]);
  res.json(await grocery(req));
});

/** Household ZIP (apiGrocerySetZip): digits only, exactly 5. */
mealsRouter.put('/api/grocery/zip', async (req, res) => {
  const zip = String((req.body as { zip?: unknown }).zip ?? '').replace(/\D/g, '').slice(0, 5);
  if (zip.length !== 5) throw new HttpError(400, 'Enter a 5-digit ZIP');
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('household_zip', $1)
     ON CONFLICT (household_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [zip],
  );
  res.json(await grocery(req));
});

async function storeExists(name: string): Promise<boolean> {
  if (GROCERY_CHAINS.some((c) => c.name === name)) return true;
  const { rows } = await pool.query('SELECT 1 FROM custom_stores WHERE name = $1', [name]);
  return rows.length > 0;
}

/** Favorite / unfavorite a store (apiGroceryFav). Favorites are per person. */
mealsRouter.post('/api/grocery/favorites', async (req, res) => {
  const me = self(req);
  const b = req.body as Record<string, unknown>;
  const store = str(b.store, 'store', 60, true);
  if (bool(b.favorite, 'favorite')) {
    if (!(await storeExists(store))) throw new HttpError(404, 'Unknown store');
    await pool.query(
      'INSERT INTO grocery_favorites (member_id, store) VALUES ($1, $2) ON CONFLICT (member_id, store) DO NOTHING',
      [me.id, store],
    );
  } else {
    await pool.query('DELETE FROM grocery_favorites WHERE member_id = $1 AND store = $2', [me.id, store]);
  }
  res.json(await grocery(req));
});

/** Fulfillment method + "signed in" flag on a favorite (apiGroceryFf / apiGroceryAcct). */
mealsRouter.patch('/api/grocery/favorites', async (req, res) => {
  const me = self(req);
  const b = req.body as Record<string, unknown>;
  const store = str(b.store, 'store', 60, true);
  if (b.fulfillment !== undefined) {
    const f = b.fulfillment;
    // Same rule as the script: anything else means in-store.
    const ff: Fulfillment = f === 'pickup' || f === 'delivery' ? f : 'instore';
    await pool.query(
      'UPDATE grocery_favorites SET fulfillment = $3, updated_at = now() WHERE member_id = $1 AND store = $2',
      [me.id, store, ff],
    );
  }
  if (b.signedIn !== undefined) {
    await pool.query(
      'UPDATE grocery_favorites SET signed_in = $3, updated_at = now() WHERE member_id = $1 AND store = $2',
      [me.id, store, bool(b.signedIn, 'signedIn')],
    );
  }
  res.json(await grocery(req));
});

/** Household's own store (apiCustomStoreAdd): unique name, valid http(s) URL. */
mealsRouter.post('/api/grocery/stores', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const name = str(b.name, 'name', 60, true);
  let url = str(b.url, 'url', 200, true);
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, 'That store link is not a valid web address');
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) {
    throw new HttpError(400, 'That store link is not a valid web address');
  }
  if (GROCERY_CHAINS.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(409, 'That store is already on the list');
  }
  const r = await pool.query(
    'INSERT INTO custom_stores (name, shop_url) VALUES ($1, $2) ON CONFLICT (household_id, lower(name)) DO NOTHING',
    [name, parsed.toString()],
  );
  if (!r.rowCount) throw new HttpError(409, 'That store is already on the list');
  res.status(201).json(await grocery(req));
});

mealsRouter.delete('/api/grocery/stores/:name', async (req, res) => {
  const name = String(req.params.name);
  await tx(async (c) => {
    await c.query('DELETE FROM custom_stores WHERE lower(name) = lower($1)', [name]);
    await c.query('DELETE FROM grocery_favorites WHERE lower(store) = lower($1)', [name]);
  });
  res.json(await grocery(req));
});

/**
 * Build the grocery list from a member's week of meals.
 *
 * Same merge rules as apiGroceryFromWeek (quantities merge across meals and
 * into open rows of the same ingredient + unit; unparseable lines dedupe by
 * text; staples are topped up) — but each row remembers how much of it came
 * from the plan (plan_qty). Rebuilding REPLACES that share instead of adding
 * to it, so building twice never doubles anything (the script turned 4 lb
 * into 7 lb). Rows that only existed for meals since removed are dropped.
 */
mealsRouter.post('/api/grocery/from-week', async (req, res) => {
  const member = await targetMember(req);
  const result = await tx(async (c): Promise<Omit<GroceryFromWeekResult, 'grocery'>> => {
    const { rows: meals } = await c.query<{ ingredients: string[] }>(
      `SELECT m.ingredients FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id
        WHERE e.member_id = $1 ORDER BY e.added_at, e.id`,
      [member.id],
    );
    const needs = mergeIngredientLines(meals.flatMap((m) => m.ingredients.map((l) => l.trim()).filter(Boolean)));

    const { rows: list } = await c.query<{ id: number; item: string; done: boolean; plan_qty: string | null }>(
      'SELECT id, item, done, plan_qty FROM grocery_items ORDER BY id FOR UPDATE',
    );
    const rows = list.map((r) => ({
      ...r,
      planQty: r.plan_qty === null ? null : Number(r.plan_qty),
      parsed: parseIngredient(r.item),
    }));
    const textOf = (s: string): string => s.trim().toLowerCase();

    let added = 0;
    let merged = 0;
    let skipped = 0;
    const neededKeys = new Set<string>();

    for (const text of needs) {
      const need = parseIngredient(text);
      neededKeys.add(need.key);

      if (need.qty === null) {
        // Unquantified ("Salt to taste"): dedupe by text, like the script.
        if (rows.some((r) => textOf(r.item) === textOf(text))) skipped++;
        else {
          await c.query("INSERT INTO grocery_items (item, added_by) VALUES ($1, 'household')", [text]);
          rows.push({ id: 0, item: text, done: false, plan_qty: null, planQty: null, parsed: need });
          added++;
        }
        continue;
      }

      // Exactly this text already typed by hand (no plan share): leave it, like the script.
      if (rows.some((r) => r.planQty === null && textOf(r.item) === textOf(text))) {
        skipped++;
        continue;
      }

      const open = rows.find(
        (r) => !r.done && r.parsed.key === need.key && r.parsed.qty !== null && r.parsed.unit === need.unit,
      );
      if (open && open.parsed.qty !== null) {
        const manual = Math.max(0, open.parsed.qty - (open.planQty ?? 0));
        const total = manual + need.qty;
        if (open.planQty !== null && Math.abs(open.planQty - need.qty) < 0.001) {
          skipped++; // already reflects this plan — the double-build case
          continue;
        }
        const combo = `${formatQty(total)}${open.parsed.unit ? ` ${open.parsed.unit}` : ''} ${open.parsed.name}`;
        await c.query('UPDATE grocery_items SET item = $2, plan_qty = $3 WHERE id = $1', [open.id, combo, need.qty]);
        open.item = combo;
        open.planQty = need.qty;
        open.parsed = parseIngredient(combo);
        merged++;
        continue;
      }

      // Already bought (checked off) for this plan: don't re-add.
      const needQty = need.qty;
      const bought = rows.find((r) => r.done && r.parsed.key === need.key && r.planQty !== null && r.planQty >= needQty - 0.001);
      if (bought) {
        skipped++;
        continue;
      }

      await c.query("INSERT INTO grocery_items (item, added_by, plan_qty) VALUES ($1, 'household', $2)", [text, need.qty]);
      rows.push({ id: 0, item: text, done: false, plan_qty: String(need.qty), planQty: need.qty, parsed: need });
      added++;
    }

    // Open rows whose plan share no longer matches any planned meal.
    let removed = 0;
    for (const r of rows) {
      if (r.id === 0 || r.done || r.planQty === null || neededKeys.has(r.parsed.key)) continue;
      const manual = r.parsed.qty === null ? 0 : r.parsed.qty - r.planQty;
      if (manual > 0.001) {
        const back = `${formatQty(manual)}${r.parsed.unit ? ` ${r.parsed.unit}` : ''} ${r.parsed.name}`;
        await c.query('UPDATE grocery_items SET item = $2, plan_qty = NULL WHERE id = $1', [r.id, back]);
      } else {
        await c.query('DELETE FROM grocery_items WHERE id = $1', [r.id]);
      }
      removed++;
    }

    const { rows: staples } = await c.query<{ item: string }>('SELECT item FROM grocery_staples ORDER BY id');
    let sAdded = 0;
    for (const s of staples) {
      if (rows.some((r) => textOf(r.item) === textOf(s.item))) continue;
      await c.query("INSERT INTO grocery_items (item, added_by) VALUES ($1, 'household')", [s.item]);
      rows.push({ id: 0, item: s.item, done: false, plan_qty: null, planQty: null, parsed: parseIngredient(s.item) });
      sAdded++;
    }
    return { added, merged, skipped, removed, staples: sAdded, meals: meals.length };
  });
  const out: GroceryFromWeekResult = { ...result, grocery: await grocery(req) };
  res.json(out);
});
