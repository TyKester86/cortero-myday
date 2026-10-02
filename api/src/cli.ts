/**
 * Admin CLI — roster setup and one-time content import from the Kester Family
 * HQ spreadsheet. Export each tab as CSV (File > Download > CSV) and run:
 *
 *   node dist/cli.js member:add --name Ty --kind adult --email you@gmail.com
 *   node dist/cli.js import:chores  "Chore Board.csv"
 *   node dist/cli.js import:workouts "MH Workouts.csv"
 *   node dist/cli.js import:meals   "MH Meals.csv"
 *   node dist/cli.js profile:set --member ty --start 2026-09-28 --calories 2700 ...
 *
 * Column layouts match the sheet tabs exactly as the old script read them.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, mealPhaseTags, mealSlug } from '@myday/shared';
import { asSystem, inHousehold, pool, tx } from './db.js';
import { loadBuildPlan, loadCsvPlan } from './lib/planload.js';
import { logEvent } from './lib/events.js';
import { mergeHouseholds, planMerge } from './lib/householdMove.js';

type Flags = Record<string, string>;

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[i + 1] ?? '';
      i++;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

/** RFC 4180 CSV (quoted fields may contain commas, quotes and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

async function csvRows(file: string | undefined): Promise<string[][]> {
  if (!file) throw new Error('CSV file path required');
  return parseCsv(await readFile(file, 'utf8')).slice(1); // drop header row
}

const cell = (r: string[], i: number): string => (r[i] ?? '').trim();
const num = (v: string): number => {
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
};
const numOrNull = (v: string): number | null => (v.trim() === '' || Number.isNaN(parseFloat(v)) ? null : Math.round(parseFloat(v)));

async function memberIds(): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ id: number; key: string }>('SELECT id, key FROM household_members');
  return new Map(rows.map((r) => [r.key, r.id]));
}

function need(flags: Flags, name: string): string {
  const v = flags[name];
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

const commands: Record<string, (pos: string[], flags: Flags) => Promise<void>> = {
  /** Same key rule as apiHouseholdAdd: lowercase name, spaces removed. */
  async 'member:add'(_pos, f) {
    const name = need(f, 'name').trim().slice(0, 40);
    const kind = f.kind === 'kid' ? 'kid' : 'adult';
    const key = (f.key ?? name).toLowerCase().replace(/\s+/g, '');
    const age = f.age ? Math.max(0, Math.round(Number(f.age))) : null;
    const email = f.email ? f.email.trim().toLowerCase() : null;
    // XP level table: leader | woman | student (the script's adult roles) | kid.
    const tracks = ['leader', 'woman', 'student', 'kid'];
    const track = f.track ?? (kind === 'kid' ? 'kid' : 'leader');
    if (!tracks.includes(track)) throw new Error(`--track must be one of ${tracks.join(', ')}`);
    await pool.query(
      `INSERT INTO household_members (key, name, kind, age, email, xp_track, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM household_members))
       ON CONFLICT (household_id, key) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, xp_track = EXCLUDED.xp_track,
         age = COALESCE(EXCLUDED.age, household_members.age), email = COALESCE(EXCLUDED.email, household_members.email)`,
      [key, name, kind, age, email, track],
    );
    console.log(`member ${key} (${kind}, ${track} levels) saved`);
  },

  async 'member:list'() {
    const { rows } = await pool.query(
      'SELECT key, name, kind, xp_track, age, email, (pin_hash IS NOT NULL) AS has_pin FROM household_members ORDER BY sort_order, id',
    );
    console.table(rows);
  },

  /** Chore Board: Chore, Kid, Mon..Sun (non-empty cell = scheduled), Points. */
  async 'import:chores'(pos) {
    const rows = await csvRows(pos[0]);
    const ids = await memberIds();
    const missing = new Set<string>();
    let n = 0;
    await tx(async (c) => {
      for (const r of rows) {
        const name = cell(r, 0);
        const key = cell(r, 1).toLowerCase();
        if (!name) continue;
        const mid = ids.get(key);
        if (mid === undefined) {
          missing.add(key);
          continue;
        }
        const days: number[] = [];
        for (let d = 0; d < 7; d++) if (cell(r, 2 + d) !== '') days.push(d + 1);
        if (!days.length) continue;
        await c.query(
          `INSERT INTO chores (name, member_id, days, points) VALUES ($1, $2, $3, $4)
           ON CONFLICT (member_id, lower(name)) WHERE active DO UPDATE SET days = EXCLUDED.days, points = EXCLUDED.points`,
          [name, mid, days, Math.max(0, Math.round(num(cell(r, 9))))],
        );
        n++;
      }
    });
    console.log(`imported ${n} chores`);
    if (missing.size) console.warn(`skipped rows for unknown members (add them first): ${[...missing].join(', ')}`);
  },

  /**
   * MH Workouts: PhaseId, Phase, WeekStart, WeekEnd, Person, DayNum, DayName,
   * Exercise, Sets, Reps, Rest, Equipment, Cues, Subs, Focus.
   * Replaces each imported member's plan.
   */
  async 'import:workouts'(pos, f) {
    const rows = await csvRows(pos[0]);
    const ids = await memberIds();
    const byMember = new Map<number, string[][]>();
    for (const r of rows) {
      const key = (f.member ?? cell(r, 4)).toLowerCase();
      const mid = ids.get(key);
      if (mid === undefined) {
        console.warn(`skipping row for unknown member "${key}"`);
        continue;
      }
      byMember.set(mid, [...(byMember.get(mid) ?? []), r]);
    }
    await tx(async (c) => {
      for (const [mid, list] of byMember) {
        await c.query('DELETE FROM workouts WHERE member_id = $1', [mid]);
        let order = 0;
        for (const r of list) {
          await c.query(
            `INSERT INTO workouts (member_id, phase_id, phase_name, week_start, week_end, day_num, day_name,
               exercise, sets, reps, rest, equipment, cues, subs, focus, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              mid, cell(r, 0), cell(r, 1), num(cell(r, 2)), num(cell(r, 3)), num(cell(r, 5)), cell(r, 6),
              cell(r, 7), num(cell(r, 8)), cell(r, 9), cell(r, 10), cell(r, 11), cell(r, 12), cell(r, 13),
              cell(r, 14), order++,
            ],
          );
        }
        console.log(`member ${mid}: ${list.length} workout rows`);
      }
    });
  },

  /** MH Meals: Id, Title, Cuisine, Calories, Protein, Carbs, Fat, Ingredients, Steps (newline-separated). */
  async 'import:meals'(pos) {
    const rows = await csvRows(pos[0]);
    const lines = (v: string): string[] => v.split('\n').map((l) => l.trim()).filter(Boolean);
    await tx(async (c) => {
      for (const r of rows) {
        const id = Math.round(num(cell(r, 0)));
        if (!id || !cell(r, 1)) continue;
        await c.query(
          `INSERT INTO meals (id, title, cuisine, calories, protein, carbs, fat, ingredients, steps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, cuisine = EXCLUDED.cuisine,
             calories = EXCLUDED.calories, protein = EXCLUDED.protein, carbs = EXCLUDED.carbs, fat = EXCLUDED.fat,
             ingredients = EXCLUDED.ingredients, steps = EXCLUDED.steps`,
          [
            id, cell(r, 1), cell(r, 2), numOrNull(cell(r, 3)), numOrNull(cell(r, 4)), numOrNull(cell(r, 5)),
            numOrNull(cell(r, 6)), lines(r[7] ?? ''), lines(r[8] ?? ''),
          ],
        );
      }
      await c.query("SELECT setval(pg_get_serial_sequence('meals', 'id'), GREATEST((SELECT MAX(id) FROM meals), 1))");
    });
    console.log(`imported ${rows.length} meals`);
  },

  /**
   * Load a member's year plan. Either from a build (one command per build):
   *   plan:load --member ty --build v_taper --bodyweight 180 [--level beginner|experienced] [--start 2026-09-28]
   * or from a CSV in the "MH Workouts" sheet layout:
   *   plan:load --member ty --csv "MH Workouts.csv" [--start 2026-09-28]
   */
  async 'plan:load'(_pos, f) {
    const ids = await memberIds();
    const key = need(f, 'member').toLowerCase();
    const mid = ids.get(key);
    if (mid === undefined) throw new Error(`unknown member ${key}`);
    const start = f.start;
    if (f.csv) {
      const rows = (await csvRows(f.csv))
        .filter((r) => !f.person || cell(r, 4).toLowerCase() === f.person.toLowerCase())
        .map((r) => ({
          phaseId: cell(r, 0), phaseName: cell(r, 1), weekStart: num(cell(r, 2)), weekEnd: num(cell(r, 3)),
          dayNum: num(cell(r, 5)), dayName: cell(r, 6), exercise: cell(r, 7), sets: num(cell(r, 8)), reps: cell(r, 9),
          rest: cell(r, 10), equipment: cell(r, 11), cues: cell(r, 12), subs: cell(r, 13), focus: cell(r, 14),
        }));
      const out = await loadCsvPlan(mid, rows, start);
      console.log(`${key}: loaded ${out.rows} plan rows in ${out.phases} phases from CSV`);
      return;
    }
    const build = BUILDS.find((b) => b === f.build);
    if (!build) throw new Error(`--build must be one of ${BUILDS.join(', ')} (or pass --csv)`);
    const out = await loadBuildPlan(mid, {
      build,
      level: f.level === 'experienced' ? 'experienced' : 'beginner',
      bodyweightLb: f.bodyweight ? Number(f.bodyweight) : null,
      foodProtein: f['food-protein'] ? Number(f['food-protein']) : null,
      start,
    });
    console.log(`${key}: ${build} plan loaded — ${out.phases} phases, ${out.rows} rows, 52 weeks`);
  },

  /**
   * The meal library (shared by every household): api/content/meals.csv →
   * meals, with picture, phase tags, servings and prep time. Idempotent;
   * runs on every container start.
   */
  async 'meals:seed'(pos) {
    const file = pos[0] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'meals.csv');
    const rows = await csvRows(file);
    const lines = (v: string): string[] => v.split('\n').map((l) => l.trim()).filter(Boolean);
    await tx(async (c) => {
      for (const r of rows) {
        const id = Math.round(num(cell(r, 0)));
        const title = cell(r, 1);
        if (!id || !title) continue;
        const calories = Math.round(num(cell(r, 3)));
        const protein = Math.round(num(cell(r, 4)));
        const slug = mealSlug(title);
        await c.query(
          `INSERT INTO meals (id, title, cuisine, calories, protein, carbs, fat, ingredients, steps, servings, prep_min, slug, image_url, phase_tags, region)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, cuisine = EXCLUDED.cuisine, calories = EXCLUDED.calories,
             protein = EXCLUDED.protein, carbs = EXCLUDED.carbs, fat = EXCLUDED.fat, ingredients = EXCLUDED.ingredients,
             steps = EXCLUDED.steps, servings = EXCLUDED.servings, prep_min = EXCLUDED.prep_min, slug = EXCLUDED.slug,
             image_url = EXCLUDED.image_url, phase_tags = EXCLUDED.phase_tags, region = EXCLUDED.region`,
          [id, title, cell(r, 2), calories, protein, numOrNull(cell(r, 5)), numOrNull(cell(r, 6)), lines(r[7] ?? ''),
            lines(r[8] ?? ''), numOrNull(cell(r, 9)), numOrNull(cell(r, 10)), slug,
            // A photo when the meal has one (Image column), else its drawn illustration.
            cell(r, 12) ? `/meals/${cell(r, 12)}` : `/meals/${slug}.svg`,
            mealPhaseTags(calories, protein), cell(r, 11)],
        );
      }
      await c.query("SELECT setval(pg_get_serial_sequence('meals', 'id'), GREATEST((SELECT MAX(id) FROM meals), 1))");
    });
    console.log(`meal library: ${rows.length} meals seeded`);
  },

  /** Health profile (was MH_PROFILE / MH_START / MH_TRAIN_WEEKDAYS in the script). */
  async 'profile:set'(_pos, f) {
    const ids = await memberIds();
    const mid = ids.get(need(f, 'member').toLowerCase());
    if (mid === undefined) throw new Error('unknown member');
    const days = (f.days ?? '1,2,4,5').split(',').map(Number);
    await pool.query(
      `INSERT INTO health_profiles (member_id, plan_start, train_weekdays, target_calories, target_protein,
         target_carbs, target_fat, breakfast, shake, cardio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (member_id) DO UPDATE SET plan_start = EXCLUDED.plan_start, train_weekdays = EXCLUDED.train_weekdays,
         target_calories = EXCLUDED.target_calories, target_protein = EXCLUDED.target_protein,
         target_carbs = EXCLUDED.target_carbs, target_fat = EXCLUDED.target_fat, breakfast = EXCLUDED.breakfast,
         shake = EXCLUDED.shake, cardio = EXCLUDED.cardio`,
      [
        mid, need(f, 'start'), days, num(f.calories ?? '0'), num(f.protein ?? '0'), num(f.carbs ?? '0'),
        num(f.fat ?? '0'), f.breakfast ?? '', f.shake ?? '', f.cardio ?? '',
      ],
    );
    console.log('profile saved');
  },
};

/**
 * Every command runs inside one household (row-level security). Pick it with
 * --household <id>; with one household it's used automatically, and on a
 * fresh database one is created ("Our family").
 */
async function resolveHousehold(flags: Flags): Promise<number> {
  return asSystem(async () => {
    if (flags.household) {
      const { rows } = await pool.query<{ id: number }>('SELECT id FROM households WHERE id = $1', [Number(flags.household)]);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`no household ${flags.household}`);
      return id;
    }
    const { rows } = await pool.query<{ id: number }>('SELECT id FROM households ORDER BY id LIMIT 2');
    if (rows.length > 1) throw new Error('several households exist: pass --household <id> (see household:list)');
    if (rows[0]) return rows[0].id;
    const code = Array.from(randomBytes(6), (b) => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
    const { rows: made } = await pool.query<{ id: number }>(
      "INSERT INTO households (name, type, code, billing_status) VALUES ($1, 'family', $2, 'comped') RETURNING id", // operator-created: complimentary
      [flags['household-name'] ?? 'Our family', code],
    );
    const id = made[0]?.id;
    if (id === undefined) throw new Error('household insert returned nothing');
    console.log(`created household ${id} (family code ${code})`);
    return id;
  });
}

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'household:list') {
    await asSystem(async () => {
      const { rows } = await pool.query('SELECT id, name, type, code, created_at FROM households ORDER BY id');
      console.table(rows);
    });
    return;
  }
  // Moving someone out of a duplicate household (e.g. a partner who signed up without the
  // invite) into the right one. Dry run unless --yes.
  //   household:merge-into --from-email partner@x.com --into-email you@x.com [--yes]
  if (cmd === 'household:merge-into') {
    await asSystem(async () => {
      const hhOf = async (email: string): Promise<number> => {
        const { rows } = await pool.query<{ household_id: number }>(
          `SELECT m.household_id FROM users u JOIN household_members m ON m.id = u.member_id WHERE lower(u.email) = $1
           UNION ALL SELECT household_id FROM household_members WHERE lower(email) = $1 AND archived_at IS NULL LIMIT 1`,
          [email.toLowerCase()],
        );
        const id = rows[0]?.household_id;
        if (id === undefined) throw new Error(`no household found for ${email}`);
        return id;
      };
      const from = await hhOf(need(flags, 'from-email'));
      const into = flags['into-household'] ? Number(flags['into-household']) : await hhOf(need(flags, 'into-email'));
      const { preview, map } = await planMerge(from, into);
      console.log(`From:  ${preview.from.name} (#${preview.from.id})`);
      console.log(`Into:  ${preview.into.name} (#${preview.into.id})`);
      for (const m of preview.folding) console.log(`  fold  ${m.name} → existing ${m.into}`);
      for (const m of preview.moving) console.log(`  move  ${m.name} (${m.kind})`);
      for (const [t, n] of Object.entries(preview.rows)) console.log(`  rows  ${t}: ${n}`);
      if (flags.yes === undefined) {
        console.log('\nDry run — nothing changed. Add --yes to do it.');
        return;
      }
      const report = await mergeHouseholds(from, into, map);
      await logEvent('household_merged', { from, into, by: 'cli', moved: report.membersMoved.length, folded: report.membersMerged.length }, null, into);
      console.log(`
Done. Moved ${report.membersMoved.length}, folded ${report.membersMerged.length}; dropped duplicates: ${JSON.stringify(report.dropped)}`);
      const check = await pool.query<{ email: string; household: string }>(
        'SELECT u.email, h.name AS household FROM users u JOIN household_members m ON m.id = u.member_id JOIN households h ON h.id = m.household_id WHERE lower(u.email) = $1',
        [need(flags, 'from-email').toLowerCase()],
      );
      console.log(check.rows.length ? `Verified: ${check.rows[0]?.email} is now in ${check.rows[0]?.household}` : 'Note: that email has no signed-in account yet');
      const gone = await pool.query('SELECT 1 FROM households WHERE id = $1', [from]);
      console.log(gone.rowCount ? 'WARNING: the duplicate household still exists' : `Verified: duplicate household #${from} removed`);
    });
    return;
  }
  const fn = commands[cmd];
  if (!fn) {
    console.log(`commands: household:list, household:merge-into, ${Object.keys(commands).join(', ')}`);
    return;
  }
  // The meal library is shared content; it needs no household.
  if (cmd === 'import:meals' || cmd === 'meals:seed') {
    await asSystem(() => fn(pos, flags));
    return;
  }
  const householdId = await resolveHousehold(flags);
  await inHousehold(householdId, () => fn(pos, flags));
}

main()
  .then(() => pool.end())
  .catch(async (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    await pool.end();
    process.exit(1);
  });
