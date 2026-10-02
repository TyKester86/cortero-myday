/**
 * My Day — the adult engine's daily loop, ported from apiAdultInit /
 * apiAdultCheckin / apiAdultAddTask / apiAdultDoneTask / apiAdultReview /
 * apiAdultAddHabit / apiAdultHabitToggle, with the same XP per action.
 * Always about the signed-in grown-up (never ?member=).
 */
import { Router, type Request } from 'express';
import {
  CONTEXTS,
  END_ENERGY,
  ENERGIES,
  NERVOUS,
  PRIORITIES,
  SLEEP,
  type Checkin,
  type DateStr,
  type EarnResult,
  type Energy,
  type HouseholdMember,
  type MyDayResponse,
  type NewTask,
  type Priority,
  type Review,
  type Task,
  type WeeklyHabit,
} from '@myday/shared';
import { pool, type Db } from '../db.js';
import { addDays, today, weekStart } from '../lib/dates.js';
import { bool, HttpError, idParam, int, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { ADULT_XP, dailyScore, trackOf } from '../lib/adult.js';
import { awardXpOnce, withEarn, xpStatus } from '../lib/xp.js';

export const dayRouter = Router();

function oneOf<T extends string>(list: readonly T[], v: unknown, field: string, allowEmpty = true): T | '' {
  if ((v === undefined || v === null || v === '') && allowEmpty) return '';
  const hit = list.find((x) => x === v);
  if (!hit) throw new HttpError(400, `${field} must be one of ${list.join(', ')}`);
  return hit;
}

interface TaskRow {
  id: number;
  task: string;
  priority: Priority;
  energy: Energy;
  context: string;
  est_min: number | null;
  mit: boolean;
  done: boolean;
}

export const toTask = (r: TaskRow): Task => ({
  id: r.id,
  task: r.task,
  priority: r.priority,
  energy: r.energy,
  context: r.context,
  estMin: r.est_min,
  mit: r.mit,
  done: r.done,
});

export async function insertTask(memberId: number, t: NewTask, day: DateStr, db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO tasks (member_id, day, task, priority, energy, context, est_min, mit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [memberId, day, t.task, t.priority, t.energy, t.context, t.estMin, t.mit],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('task insert returned nothing');
  return id;
}

export function parseNewTask(b: Record<string, unknown>): NewTask {
  return {
    task: str(b.task, 'task', 200, true),
    priority: oneOf(PRIORITIES, b.priority ?? 'Important', 'priority', false) as Priority,
    energy: oneOf(ENERGIES, b.energy ?? 'Low Brain', 'energy', false) as Energy,
    context: oneOf(CONTEXTS, b.context, 'context'),
    estMin: b.estMin === null || b.estMin === undefined || b.estMin === '' ? null : int(b.estMin, 'estMin', 1, 600),
    mit: b.mit === true,
  };
}

/**
 * Energy-aware order, driven by the morning check-in: Fried → low-brain and
 * body-only work first; Calm → deep (high-brain) work first; Buzzing → move
 * first, then thinking. Within the same energy, MITs and priority still lead.
 */
const ENERGY_ORDER: Record<string, Energy[]> = {
  Fried: ['Low Brain', 'Body-only', 'High Brain'],
  Calm: ['High Brain', 'Low Brain', 'Body-only'],
  Buzzing: ['Body-only', 'Low Brain', 'High Brain'],
};
const ENERGY_NOTE: Record<string, string> = {
  Fried: 'Fried today — easy wins first. Deep work can wait until you have more in the tank.',
  Calm: 'Calm brain — deep work first while it lasts.',
  Buzzing: 'Buzzing — burn some energy on body tasks first, then settle into the rest.',
};

export function orderByEnergy(tasks: Task[], nervous: string): Task[] {
  const order = ENERGY_ORDER[nervous];
  if (!order) return tasks;
  const rank = (t: Task): number => order.indexOf(t.energy);
  // Stable sort: the SQL order (MIT, priority, id) is kept within each energy band.
  return [...tasks].sort((a, b) => Number(a.done) - Number(b.done) || rank(a) - rank(b));
}

async function myDay(member: HouseholdMember): Promise<MyDayResponse> {
  const t = today();
  const ws = weekStart(t);
  const track = await trackOf(member.id);
  const ci = (await pool.query<Checkin>('SELECT nervous, sleep, fuel, grateful FROM checkins WHERE member_id = $1 AND day = $2', [member.id, t])).rows[0];
  const { rows: tasks } = await pool.query<TaskRow>(
    `SELECT id, task, priority, energy, context, est_min, mit, done FROM tasks
      WHERE member_id = $1 AND day = $2 ORDER BY done, mit DESC,
            array_position(ARRAY['Critical','Important','Later'], priority), id`,
    [member.id, t],
  );
  const rv = (
    await pool.query<{ got: string; derailed: string; tomorrow: string; rsd: string; energy_end: string }>(
      'SELECT got, derailed, tomorrow, rsd, energy_end FROM reviews WHERE member_id = $1 AND day = $2',
      [member.id, t],
    )
  ).rows[0];
  const { rows: habits } = await pool.query<{ id: number; name: string; days: DateStr[] | null }>(
    `SELECT h.id, h.name,
            array_agg(c.day::text) FILTER (WHERE c.day IS NOT NULL) AS days
       FROM habits h LEFT JOIN habit_checks c ON c.habit_id = h.id AND c.day BETWEEN $2 AND $3
      WHERE h.member_id = $1 AND h.active GROUP BY h.id ORDER BY h.id`,
    [member.id, ws, addDays(ws, 6)],
  );
  const review: Review | null = rv
    ? { got: rv.got, derailed: rv.derailed, tomorrow: rv.tomorrow, rsd: rv.rsd, energyEnd: rv.energy_end }
    : null;
  return {
    member,
    date: t,
    xp: await xpStatus(member.id),
    checkin: ci ?? null,
    tasks: orderByEnergy(tasks.map(toTask), ci?.nervous ?? ''),
    energyNote: ENERGY_NOTE[ci?.nervous ?? ''] ?? null,
    review,
    habits: habits.map(
      (h): WeeklyHabit => ({
        id: h.id,
        name: h.name,
        days: Array.from({ length: 7 }, (_, i) => (h.days ?? []).includes(addDays(ws, i))),
      }),
    ),
    daily: await dailyScore(member.id, track, t),
  };
}

dayRouter.get('/api/day', async (req, res) => {
  res.json(await myDay(requireAdult(req)));
});

type EarnDay = EarnResult & { day: MyDayResponse };

async function earnAndDay(req: Request, fn: (m: HouseholdMember) => Promise<void>): Promise<EarnDay> {
  const me = requireAdult(req);
  const { earn } = await withEarn(me.id, () => fn(me));
  return { ...earn, day: await myDay(me) };
}

/** Morning check-in. XP on the first save of the day only (re-saves just edit). */
dayRouter.put('/api/day/checkin', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const ci: Checkin = {
    nervous: oneOf(NERVOUS, b.nervous, 'nervous'),
    sleep: oneOf(SLEEP, b.sleep, 'sleep'),
    fuel: str(b.fuel, 'fuel', 200),
    grateful: str(b.grateful, 'grateful', 200),
  };
  res.json(
    await earnAndDay(req, async (me) => {
      const t = today();
      const ins = await pool.query<{ fresh: boolean }>(
        `INSERT INTO checkins (member_id, day, nervous, sleep, fuel, grateful) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (member_id, day) DO UPDATE SET nervous = EXCLUDED.nervous, sleep = EXCLUDED.sleep,
           fuel = EXCLUDED.fuel, grateful = EXCLUDED.grateful
         RETURNING (xmax = 0) AS fresh`,
        [me.id, t, ci.nervous, ci.sleep, ci.fuel, ci.grateful],
      );
      if (!ins.rows[0]?.fresh) return;
      await awardXpOnce(me.id, t, ADULT_XP.checkin, 'Morning check-in', `checkin:${t}`);
      if ((await trackOf(me.id)) === 'student') {
        await awardXpOnce(me.id, t, 10, 'Morning Routine Complete', `morning:${t}`);
        if (ci.sleep === 'Great') await awardXpOnce(me.id, t, 10, '7+ Hours Sleep', `sleep:${t}`);
        if (ci.grateful.trim()) await awardXpOnce(me.id, t, 5, 'Gratitude Entry', `gratitude:${t}`);
      }
    }),
  );
});

dayRouter.post('/api/day/tasks', async (req, res) => {
  const me = requireAdult(req);
  await insertTask(me.id, parseNewTask(req.body as Record<string, unknown>), today());
  res.status(201).json(await myDay(me));
});

/** Finish a task: 5 XP (student: 10, or 25 for an MIT). One-way, like the script. */
dayRouter.post('/api/day/tasks/:id/done', async (req, res) => {
  const id = idParam(req.params.id);
  res.json(
    await earnAndDay(req, async (me) => {
      const t = today();
      const { rows } = await pool.query<{ mit: boolean }>(
        'UPDATE tasks SET done = true, done_on = $3 WHERE id = $1 AND member_id = $2 AND NOT done RETURNING mit',
        [id, me.id, t],
      );
      const row = rows[0];
      if (!row) {
        const exists = await pool.query('SELECT 1 FROM tasks WHERE id = $1 AND member_id = $2', [id, me.id]);
        if (!exists.rowCount) throw new HttpError(404, 'Task not found');
        return; // already done
      }
      const student = (await trackOf(me.id)) === 'student';
      const xp = student ? (row.mit ? 25 : 10) : ADULT_XP.task;
      await awardXpOnce(me.id, t, xp, row.mit ? 'Complete an MIT' : 'Task completed', `task:${id}`);
    }),
  );
});

dayRouter.delete('/api/day/tasks/:id', async (req, res) => {
  const me = requireAdult(req);
  const r = await pool.query('DELETE FROM tasks WHERE id = $1 AND member_id = $2 AND NOT done', [idParam(req.params.id), me.id]);
  if (!r.rowCount) throw new HttpError(409, 'Only open tasks can be deleted');
  res.json(await myDay(me));
});

/** Evening review. XP on the first save of the day only. */
dayRouter.put('/api/day/review', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const rv: Review = {
    got: str(b.got, 'got', 500),
    derailed: str(b.derailed, 'derailed', 500),
    tomorrow: str(b.tomorrow, 'tomorrow', 200),
    rsd: oneOf(['Yes', 'No'] as const, b.rsd, 'rsd'),
    energyEnd: oneOf(END_ENERGY, b.energyEnd, 'energyEnd'),
  };
  res.json(
    await earnAndDay(req, async (me) => {
      const t = today();
      const ins = await pool.query<{ fresh: boolean }>(
        `INSERT INTO reviews (member_id, day, got, derailed, tomorrow, rsd, energy_end) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (member_id, day) DO UPDATE SET got = EXCLUDED.got, derailed = EXCLUDED.derailed,
           tomorrow = EXCLUDED.tomorrow, rsd = EXCLUDED.rsd, energy_end = EXCLUDED.energy_end
         RETURNING (xmax = 0) AS fresh`,
        [me.id, t, rv.got, rv.derailed, rv.tomorrow, rv.rsd, rv.energyEnd],
      );
      if (!ins.rows[0]?.fresh) return;
      await awardXpOnce(me.id, t, ADULT_XP.review, 'Evening review', `review:${t}`);
      if ((await trackOf(me.id)) === 'student') await awardXpOnce(me.id, t, 10, 'Evening Routine Complete', `evening:${t}`);
    }),
  );
});

/* ---------- the weekly habit tracker (1–2 habits is the workbook's advice; max 5) ---------- */

dayRouter.post('/api/day/habits', async (req, res) => {
  const me = requireAdult(req);
  const name = str((req.body as { name?: unknown }).name, 'name', 120, true);
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM habits WHERE member_id = $1 AND active', [me.id]);
  if ((rows[0]?.n ?? 0) >= 5) throw new HttpError(409, 'Five habits max — fewer sticks better');
  await pool.query('INSERT INTO habits (member_id, name) VALUES ($1, $2)', [me.id, name]);
  res.status(201).json(await myDay(me));
});

/** Tick / untick one day of this week. Ticking pays 3 XP once per habit-day. */
dayRouter.post('/api/day/habits/:id/toggle', async (req, res) => {
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const dayIdx = int(b.dayIdx, 'dayIdx', 0, 6);
  const done = bool(b.done, 'done');
  res.json(
    await earnAndDay(req, async (me) => {
      const owns = await pool.query('SELECT 1 FROM habits WHERE id = $1 AND member_id = $2 AND active', [id, me.id]);
      if (!owns.rowCount) throw new HttpError(404, 'Habit not found');
      const day = addDays(weekStart(today()), dayIdx);
      if (day > today()) throw new HttpError(400, "Can't tick a day that hasn't happened yet");
      const key = `habit:${id}:${day}`;
      if (done) {
        await pool.query('INSERT INTO habit_checks (habit_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, day]);
        await awardXpOnce(me.id, day, ADULT_XP.habit, 'Habit day', key);
      } else {
        await pool.query('DELETE FROM habit_checks WHERE habit_id = $1 AND day = $2', [id, day]);
        await pool.query('DELETE FROM xp_events WHERE member_id = $1 AND once_key = $2', [me.id, key]);
      }
    }),
  );
});

dayRouter.delete('/api/day/habits/:id', async (req, res) => {
  const me = requireAdult(req);
  await pool.query('UPDATE habits SET active = false WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id]);
  res.json(await myDay(me));
});
