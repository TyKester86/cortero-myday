/**
 * Hana as the action interface: the MyDay tools she can call from chat.
 *
 * Safe, easily-undone actions (add a task, add groceries, capture a note,
 * add homework, move today's workout, add a bill, finish a task) run right
 * away. Destructive ones (delete a task, clear checked groceries, remove a
 * bill) are only PROPOSED: they wait in hana_actions until the person taps
 * Confirm in the chat. Every action is logged as an event.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { z } from 'zod';
import { CAL_REPEATS, ENERGIES, PRIORITIES, WEEKDAYS, type DateStr, type HanaAction, type HouseholdMember, type Weekday } from '@myday/shared';
import { pool } from '../db.js';
import { profileFor, plannedSession } from '../routes/health.js';
import { datesOf } from './recur.js';
import { CABINS, checkQuery, searchFlights } from './flights.js';
import { config } from '../config.js';
import { createErrand } from '../routes/errands.js';
import { kidsOverview } from '../routes/family.js';
import { fillKrogerCart, sendToInstacart } from '../routes/grocers.js';
import type { ToolKit } from './ai.js';
import { addDays, localToInstant, today, weekdayToIso } from './dates.js';
import { logEvent } from './events.js';
import { HttpError } from './http.js';
import { listMembers } from './members.js';
import { hanaStats, statsLine } from './hanaStats.js';

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  destructive: boolean;
  schema: S;
  json: BetaTool['input_schema'];
  summary: (input: z.infer<S>) => string;
  run: (me: HouseholdMember, input: z.infer<S>) => Promise<string>;
}

const def = <S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> => d;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

async function ownTask(me: HouseholdMember, id: number): Promise<string> {
  const { rows } = await pool.query<{ task: string }>('SELECT task FROM tasks WHERE id = $1 AND member_id = $2', [id, me.id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, `There is no task #${id} on your list`);
  return t.task;
}

/** One recurring chore for anyone in the household (kids and grown-ups alike). */
async function addChore(i: { person: string; chore: string; days: readonly string[]; points: number }): Promise<string> {
  const members = await listMembers();
  const who = members.find((m) => m.name.toLowerCase() === i.person.trim().toLowerCase());
  if (!who) throw new HttpError(404, `There’s no household member named ${i.person} (the household is ${members.map((m) => m.name).join(', ')})`);
  try {
    await pool.query('INSERT INTO chores (name, member_id, days, points, created_on) VALUES ($1, $2, $3, $4, $5)', [
      i.chore,
      who.id,
      [...new Set(i.days)].map((d) => weekdayToIso(d as Weekday)),
      i.points,
      today(),
    ]);
  } catch (e) {
    if ((e as { code?: unknown }).code === '23505') throw new HttpError(409, `${who.name} already has a chore called ${i.chore}`);
    throw e;
  }
  return `${who.name} now has “${i.chore}” on ${i.days.join(' ')} for ${i.points} points.`;
}

export const HANA_TOOLS = [
  def({
    name: 'add_task',
    description: "Add a task to the person's list for today. Use the energy it needs: High Brain (deep focus), Low Brain (easy), Body-only (physical).",
    destructive: false,
    schema: z.object({ task: z.string().min(1).max(200), priority: z.enum(PRIORITIES), energy: z.enum(ENERGIES) }),
    json: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task, short and concrete' },
        priority: { type: 'string', enum: [...PRIORITIES] },
        energy: { type: 'string', enum: [...ENERGIES] },
      },
      required: ['task', 'priority', 'energy'],
      additionalProperties: false,
    },
    summary: (i) => `Add task “${i.task}”`,
    run: async (me, i) => {
      const { rows } = await pool.query<{ id: number }>(
        "INSERT INTO tasks (member_id, day, task, priority, energy) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [me.id, today(), i.task, i.priority, i.energy],
      );
      return `Added task #${rows[0]?.id ?? '?'} “${i.task}” for today.`;
    },
  }),
  def({
    name: 'complete_task',
    description: 'Mark one of today\'s tasks done, by its #id from the context.',
    destructive: false,
    schema: z.object({ task_id: z.number().int().positive() }),
    json: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'], additionalProperties: false },
    summary: (i) => `Finish task #${i.task_id}`,
    run: async (me, i) => {
      const name = await ownTask(me, i.task_id);
      await pool.query('UPDATE tasks SET done = true, done_on = $3 WHERE id = $1 AND member_id = $2', [i.task_id, me.id, today()]);
      return `Marked “${name}” done.`;
    },
  }),
  def({
    name: 'add_grocery_items',
    description: 'Add items to the shared household grocery list.',
    destructive: false,
    schema: z.object({ items: z.array(z.string().min(1).max(80)).min(1).max(30) }),
    json: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } }, required: ['items'], additionalProperties: false },
    summary: (i) => `Add ${i.items.join(', ')} to groceries`,
    run: async (me, i) => {
      for (const item of i.items) await pool.query('INSERT INTO grocery_items (item, added_by) VALUES ($1, $2)', [item.trim(), me.key]);
      return `Added ${i.items.length} item${i.items.length === 1 ? '' : 's'} to the grocery list: ${i.items.join(', ')}.`;
    },
  }),
  def({
    name: 'capture_note',
    description: 'Capture a thought or reminder in the brain dump to sort later.',
    destructive: false,
    schema: z.object({ note: z.string().min(1).max(500) }),
    json: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false },
    summary: (i) => `Capture “${i.note}”`,
    run: async (me, i) => {
      await pool.query('INSERT INTO dump_items (member_id, captured_on, note) VALUES ($1, $2, $3)', [me.id, today(), i.note]);
      return `Captured in your brain dump: “${i.note}”.`;
    },
  }),
  def({
    name: 'add_homework',
    description: "Add a homework assignment for one of the household's kids, by first name. due is YYYY-MM-DD or null.",
    destructive: false,
    schema: z.object({ kid_name: z.string().min(1).max(40), assignment: z.string().min(1).max(200), subject: z.string().max(40), due: z.string().regex(DATE).nullable() }),
    json: {
      type: 'object',
      properties: {
        kid_name: { type: 'string' },
        assignment: { type: 'string' },
        subject: { type: 'string' },
        due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null if no due date' },
      },
      required: ['kid_name', 'assignment', 'subject', 'due'],
      additionalProperties: false,
    },
    summary: (i) => `Add homework for ${i.kid_name}: ${i.assignment}`,
    run: async (_me, i) => {
      const kid = (await listMembers()).find((m) => m.kind === 'kid' && m.name.toLowerCase() === i.kid_name.trim().toLowerCase());
      if (!kid) throw new HttpError(404, `There's no kid named ${i.kid_name} in this household`);
      await pool.query('INSERT INTO homework (member_id, assignment, subject, due) VALUES ($1, $2, $3, $4)', [kid.id, i.assignment, i.subject, i.due]);
      return `Added “${i.assignment}” to ${kid.name}'s homework${i.due ? ` (due ${i.due})` : ''}.`;
    },
  }),
  def({
    name: 'move_workout',
    description: "Move today's planned workout to tomorrow or to a given date (YYYY-MM-DD).",
    destructive: false,
    schema: z.object({ to: z.string() }),
    json: { type: 'object', properties: { to: { type: 'string', description: '"tomorrow" or YYYY-MM-DD' } }, required: ['to'], additionalProperties: false },
    summary: (i) => `Move today's workout to ${i.to}`,
    run: async (me, i) => {
      const t = today();
      const to = i.to === 'tomorrow' ? addDays(t, 1) : DATE.test(i.to) ? i.to : null;
      if (!to || to <= t) throw new HttpError(400, 'Workouts move to tomorrow or a later date');
      const { session } = await plannedSession(me.id, await profileFor(me.id), t);
      if (!session) throw new HttpError(409, 'There is no workout planned today');
      await pool.query(
        `INSERT INTO workout_moves (member_id, from_day, to_day) VALUES ($1, $2, $3)
         ON CONFLICT (member_id, from_day) DO UPDATE SET to_day = EXCLUDED.to_day, created_at = now()`,
        [me.id, t, to],
      );
      return `Moved today's ${session.dayName} workout to ${to}.`;
    },
  }),
  def({
    name: 'add_bill',
    description: 'Track a monthly bill. due_day is the day of the month (1–31) or null.',
    destructive: false,
    schema: z.object({ name: z.string().min(1).max(60), amount: z.number().min(0).max(1_000_000), due_day: z.number().int().min(1).max(31).nullable(), autopay: z.boolean() }),
    json: {
      type: 'object',
      properties: { name: { type: 'string' }, amount: { type: 'number' }, due_day: { type: ['integer', 'null'] }, autopay: { type: 'boolean' } },
      required: ['name', 'amount', 'due_day', 'autopay'],
      additionalProperties: false,
    },
    summary: (i) => `Track bill ${i.name} ($${i.amount})`,
    run: async (me, i) => {
      await pool.query('INSERT INTO bills (member_id, name, amount, due_day, autopay) VALUES ($1, $2, $3, $4, $5)', [me.id, i.name, i.amount, i.due_day, i.autopay]);
      return `Now tracking ${i.name}: $${i.amount}${i.due_day ? ` due on the ${i.due_day}` : ''}${i.autopay ? ' (autopay)' : ''}.`;
    },
  }),
  def({
    name: 'add_calendar_event',
    description:
      'Put an event on the shared household calendar. date is YYYY-MM-DD; start_time/end_time are HH:MM (24h) or null for all day. ' +
      'for_people is a list of first names from the household ([] = everyone). repeat is none|daily|weekly|monthly|yearly. ' +
      'remind_minutes sends a push that many minutes before (timed events only) or null.',
    destructive: false,
    schema: z.object({
      title: z.string().min(1).max(120),
      date: z.string().regex(DATE),
      start_time: z.string().regex(TIME).nullable(),
      end_time: z.string().regex(TIME).nullable(),
      for_people: z.array(z.string().max(40)).max(20),
      repeat: z.enum(CAL_REPEATS),
      remind_minutes: z.number().int().min(0).max(10080).nullable(),
      location: z.string().max(200),
    }),
    json: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: ['string', 'null'], description: 'HH:MM 24h, or null for all day' },
        end_time: { type: ['string', 'null'] },
        for_people: { type: 'array', items: { type: 'string' } },
        repeat: { type: 'string', enum: [...CAL_REPEATS] },
        remind_minutes: { type: ['integer', 'null'] },
        location: { type: 'string' },
      },
      required: ['title', 'date', 'start_time', 'end_time', 'for_people', 'repeat', 'remind_minutes', 'location'],
      additionalProperties: false,
    },
    summary: (i) => `Add “${i.title}” to the calendar on ${i.date}${i.start_time ? ` at ${i.start_time}` : ''}`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'Only grown-ups add calendar events');
      const members = await listMembers();
      const people = i.for_people.map((n) => {
        const m = members.find((x) => x.name.toLowerCase() === n.trim().toLowerCase());
        if (!m) throw new HttpError(404, `There's no ${n} in this household`);
        return m.id;
      });
      if (i.start_time && i.end_time && i.end_time <= i.start_time) throw new HttpError(400, 'The end time is before the start');
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO calendar_events (title, location, starts_on, start_time, end_time, repeat, remind_minutes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [i.title, i.location, i.date, i.start_time, i.start_time ? i.end_time : null, i.repeat, i.start_time ? i.remind_minutes : null, me.id],
      );
      const id = rows[0]?.id ?? 0;
      for (const p of [...new Set(people)]) await pool.query('INSERT INTO calendar_event_people (event_id, member_id) VALUES ($1, $2)', [id, p]);
      const who = people.length ? ` for ${members.filter((m) => people.includes(m.id)).map((m) => m.name).join(', ')}` : '';
      return `Added “${i.title}” to the calendar on ${i.date}${i.start_time ? ` at ${i.start_time}` : ' (all day)'}${who}${i.repeat !== 'none' ? `, repeating ${i.repeat}` : ''}.`;
    },
  }),
  def({
    name: 'get_calendar',
    description: 'Read the household calendar: what is on it from a date (YYYY-MM-DD, or null for today) for the next N days (1–31).',
    destructive: false,
    schema: z.object({ from: z.string().regex(DATE).nullable(), days: z.number().int().min(1).max(31) }),
    json: {
      type: 'object',
      properties: { from: { type: ['string', 'null'] }, days: { type: 'integer' } },
      required: ['from', 'days'],
      additionalProperties: false,
    },
    summary: (i) => `Look at the calendar (${i.days} day${i.days === 1 ? '' : 's'})`,
    run: async (me, i) => {
      const from = i.from ?? today();
      const to = addDays(from, i.days - 1);
      const { rows } = await pool.query<{ id: number; title: string; starts_on: string; start_time: string | null; repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'; repeat_until: string | null; adults_only: boolean; people: string[] | null }>(
        `SELECT e.id, e.title, e.starts_on::text AS starts_on, e.start_time::text AS start_time, e.repeat, e.repeat_until::text AS repeat_until, e.adults_only,
                (SELECT array_agg(m.name) FROM calendar_event_people p JOIN household_members m ON m.id = p.member_id WHERE p.event_id = e.id) AS people
           FROM calendar_events e`,
      );
      const lines: string[] = [];
      for (const r of rows) {
        if (r.adults_only && me.kind !== 'adult') continue;
        for (const d of datesOf(r, from, to)) lines.push(`${d}${r.start_time ? ` ${r.start_time.slice(0, 5)}` : ' (all day)'} ${r.title}${r.people?.length ? ` — ${r.people.join(', ')}` : ''}`);
      }
      lines.sort();
      return lines.length ? `Calendar ${from} to ${to}:\n${lines.join('\n')}` : `Nothing on the calendar from ${from} to ${to}.`;
    },
  }),
  def({
    name: 'set_reminder',
    description: 'Remind this person with a push notification at a time: date YYYY-MM-DD and time HH:MM (24h, household time). Use for "remind me at 5 to…".',
    destructive: false,
    schema: z.object({ text: z.string().min(1).max(200), date: z.string().regex(DATE), time: z.string().regex(TIME) }),
    json: {
      type: 'object',
      properties: { text: { type: 'string', description: 'What to remind them about' }, date: { type: 'string' }, time: { type: 'string', description: 'HH:MM 24h' } },
      required: ['text', 'date', 'time'],
      additionalProperties: false,
    },
    summary: (i) => `Remind you “${i.text}” on ${i.date} at ${i.time}`,
    run: async (me, i) => {
      const at = localToInstant(i.date, i.time);
      if (at.getTime() < Date.now() - 60_000) throw new HttpError(400, 'That time has already passed');
      await pool.query('INSERT INTO hana_reminders (member_id, text, remind_at) VALUES ($1, $2, $3)', [me.id, i.text, at]);
      return `Okay — I'll send you a reminder “${i.text}” on ${i.date} at ${i.time}.`;
    },
  }),
  def({
    name: 'remember',
    description: 'Save something about this person to remember in future chats (a preference, a routine, a fact they told you). Keep it short.',
    destructive: false,
    schema: z.object({ fact: z.string().min(1).max(300) }),
    json: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'], additionalProperties: false },
    summary: (i) => `Remember: ${i.fact}`,
    run: async (me, i) => {
      const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM hana_memories WHERE member_id = $1', [me.id]);
      if ((rows[0]?.n ?? 0) >= 100) throw new HttpError(409, 'I already remember 100 things — remove a few on the Ask Hana page first');
      await pool.query('INSERT INTO hana_memories (member_id, fact) VALUES ($1, $2)', [me.id, i.fact]);
      return `Got it — I'll remember that.`;
    },
  }),
  def({
    name: 'plan_meal',
    description: "Add a meal from the MyDay recipe library to this person's week, by (part of) its name; day is Mon..Sun or null for no day yet.",
    destructive: false,
    schema: z.object({ meal: z.string().min(2).max(120), day: z.enum(WEEKDAYS).nullable() }),
    json: {
      type: 'object',
      properties: { meal: { type: 'string' }, day: { anyOf: [{ type: 'string', enum: [...WEEKDAYS] }, { type: 'null' }] } },
      required: ['meal', 'day'],
      additionalProperties: false,
    },
    summary: (i) => `Plan ${i.meal}${i.day ? ` on ${i.day}` : ''}`,
    run: async (me, i) => {
      const { rows } = await pool.query<{ id: number; title: string }>(
        `SELECT id, title FROM meals WHERE title ILIKE '%' || $1 || '%' ORDER BY (lower(title) = lower($1)) DESC, length(title), id LIMIT 1`,
        [i.meal.trim()],
      );
      const meal = rows[0];
      if (!meal) throw new HttpError(404, `I couldn't find “${i.meal}” in the recipe library`);
      const day = i.day ? weekdayToIso(i.day as Weekday) : null;
      await pool.query(
        `INSERT INTO meal_plan_entries (member_id, meal_id, day, slot) SELECT $1, $2, $3, NULL
          WHERE NOT EXISTS (SELECT 1 FROM meal_plan_entries WHERE member_id = $1 AND meal_id = $2 AND day IS NOT DISTINCT FROM $3)`,
        [me.id, meal.id, day],
      );
      return `Added ${meal.title} to your week${i.day ? ` on ${i.day}` : ''}. Its ingredients go on the grocery list when you build it.`;
    },
  }),
  def({
    name: 'send_groceries',
    description: "Send the household's open grocery list to a store: 'instacart' builds an Instacart shopping list (they pick a store and check out there); 'kroger' fills this person's own Kroger cart for pickup at their chosen store. They always check out and pay on the store's site — never say an order was placed.",
    destructive: true,
    schema: z.object({ to: z.enum(['instacart', 'kroger']) }),
    json: { type: 'object', properties: { to: { type: 'string', enum: ['instacart', 'kroger'] } }, required: ['to'], additionalProperties: false },
    summary: (i) => (i.to === 'kroger' ? 'Put the grocery list in your Kroger cart' : 'Send the grocery list to Instacart'),
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      const r = i.to === 'kroger' ? await fillKrogerCart(me.id) : await sendToInstacart('Our grocery list (MyDay)');
      const store = i.to === 'kroger' ? 'your Kroger cart' : 'an Instacart list';
      const missed = r.notFound.length ? ` I couldn’t find: ${r.notFound.join(', ')}.` : '';
      return `Put ${r.added.length} item${r.added.length === 1 ? '' : 's'} in ${store}.${missed} Check out here: ${r.url}`;
    },
  }),
  def({
    name: 'find_flights',
    description:
      'Search flights and give booking links (you never book or pay — they book on the airline, Google Flights or Kayak). ' +
      'from/to are 3-letter IATA airport or city codes (Atlanta = ATL, New York = NYC, Los Angeles = LAX). depart/return are YYYY-MM-DD ' +
      '(return null = one way). adults 1–9. cabin economy|premium_economy|business|first. If the city or dates are unclear, ask first.',
    destructive: false,
    schema: z.object({
      from: z.string().regex(/^[A-Za-z]{3}$/),
      to: z.string().regex(/^[A-Za-z]{3}$/),
      depart: z.string().regex(DATE),
      return: z.string().regex(DATE).nullable(),
      adults: z.number().int().min(1).max(9),
      cabin: z.enum(CABINS),
    }),
    json: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        depart: { type: 'string' },
        return: { type: ['string', 'null'] },
        adults: { type: 'integer' },
        cabin: { type: 'string', enum: [...CABINS] },
      },
      required: ['from', 'to', 'depart', 'return', 'adults', 'cabin'],
      additionalProperties: false,
    },
    summary: (i) => `Find flights ${i.from.toUpperCase()} → ${i.to.toUpperCase()} on ${i.depart}${i.return ? `, back ${i.return}` : ''}`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      const q = { ...i, from: i.from.toUpperCase(), to: i.to.toUpperCase(), depart: i.depart as DateStr, return: (i.return ?? null) as DateStr | null };
      checkQuery(q, today());
      const r = await searchFlights(q);
      const found = r.offers.length
        ? `Cheapest I found: ${r.offers.map((o, n) => `${n + 1}) ${o.airline} ${o.price}${q.adults > 1 ? ' total' : ''} — ${o.legs.join('; ')}`).join(' ')}.`
        : 'I can’t see live prices from here, so here are the searches ready to go.';
      return `${found} Compare and book: Google Flights ${r.links.googleFlights} · Kayak ${r.links.kayak} (prices change fast — booking happens on their site).`;
    },
  }),
  def({
    name: 'run_errand',
    description:
      "Do something on a website for this person in a real browser, signed in with their saved login: reorder from a store, check an order, " +
      "book a table, renew something. site is a saved login's name (e.g. 'Walmart') or a website (e.g. 'walmart.com'). goal says exactly " +
      'what to do, including any limits ("under $50", "pickup Saturday"). It runs in the background; anything that spends money waits for their OK ' +
      "in Hana's errands, and they get a notification.",
    destructive: true,
    schema: z.object({ site: z.string().min(2).max(120), goal: z.string().min(4).max(500) }),
    json: { type: 'object', properties: { site: { type: 'string' }, goal: { type: 'string' } }, required: ['site', 'goal'], additionalProperties: false },
    summary: (i) => `Go to ${i.site} and ${i.goal.replace(/^./, (c) => c.toLowerCase())}`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      await createErrand(me.id, i.goal, { name: i.site });
      return `I’m on it in the browser. I’ll ask before anything is bought, and you can watch along in Hana’s errands: ${config.publicUrl}/errands`;
    },
  }),
  def({
    name: 'add_chore',
    description:
      'Give anyone in the household — a kid or a grown-up — one recurring chore: their first name, chore name, days (Mon..Sun), points (0–100). For more than one chore, use add_chores.',
    destructive: false,
    schema: z.object({ person: z.string().min(1).max(40), chore: z.string().min(1).max(80), days: z.array(z.enum(WEEKDAYS)).min(1).max(7), points: z.number().int().min(0).max(100) }),
    json: {
      type: 'object',
      properties: { person: { type: 'string' }, chore: { type: 'string' }, days: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] } }, points: { type: 'integer' } },
      required: ['person', 'chore', 'days', 'points'],
      additionalProperties: false,
    },
    summary: (i) => `Give ${i.person} the chore “${i.chore}” (${i.days.join(' ')})`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'Only grown-ups assign chores');
      return addChore(i);
    },
  }),
  def({
    name: 'add_chores',
    description:
      'Add many recurring chores in one go (a pasted chore list, “add them all”): each with the person’s first name (anyone in the household, kid or grown-up), chore name, days (Mon..Sun) and points (0–100). Every item is added on its own; the result says exactly which were added and which weren’t, and why.',
    destructive: false,
    schema: z.object({
      chores: z
        .array(z.object({ person: z.string().min(1).max(40), chore: z.string().min(1).max(80), days: z.array(z.enum(WEEKDAYS)).min(1).max(7), points: z.number().int().min(0).max(100) }))
        .min(1)
        .max(80),
    }),
    json: {
      type: 'object',
      properties: {
        chores: {
          type: 'array',
          items: {
            type: 'object',
            properties: { person: { type: 'string' }, chore: { type: 'string' }, days: { type: 'array', items: { type: 'string', enum: [...WEEKDAYS] } }, points: { type: 'integer' } },
            required: ['person', 'chore', 'days', 'points'],
            additionalProperties: false,
          },
        },
      },
      required: ['chores'],
      additionalProperties: false,
    },
    summary: (i) => `Add ${i.chores.length} chore${i.chores.length === 1 ? '' : 's'}`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'Only grown-ups assign chores');
      const added: string[] = [];
      const notAdded: string[] = [];
      for (const c of i.chores) {
        try {
          await addChore(c);
          added.push(`${c.person}: ${c.chore}`);
        } catch (e) {
          notAdded.push(`${c.person}: ${c.chore} — ${e instanceof HttpError ? e.message : 'failed'}`);
        }
      }
      return [
        `Added ${added.length} of ${i.chores.length} chores.`,
        added.length ? `Added: ${added.join('; ')}.` : '',
        notAdded.length ? `Not added (${notAdded.length}): ${notAdded.join('; ')}.` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  }),
  def({
    name: 'set_homework_help',
    description:
      "How Hana helps a kid with homework: 'hints' (guide with questions and hints first — the default) or 'direct' (give the answer with the full worked steps). kid_name null = every kid. Grown-ups only.",
    destructive: false,
    schema: z.object({ kid_name: z.string().min(1).max(40).nullable(), style: z.enum(['hints', 'direct']) }),
    json: {
      type: 'object',
      properties: { kid_name: { anyOf: [{ type: 'string' }, { type: 'null' }] }, style: { type: 'string', enum: ['hints', 'direct'] } },
      required: ['kid_name', 'style'],
      additionalProperties: false,
    },
    summary: (i) => `Homework help for ${i.kid_name ?? 'every kid'}: ${i.style === 'direct' ? 'direct answers' : 'hints first'}`,
    run: async (me, i) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      const kids = (await listMembers()).filter((m) => m.kind === 'kid' && (i.kid_name === null || m.name.toLowerCase() === i.kid_name.trim().toLowerCase()));
      if (!kids.length) throw new HttpError(404, i.kid_name ? `There's no kid named ${i.kid_name} in this household` : 'There are no kids on the roster');
      await pool.query('UPDATE household_members SET tutor_direct = $2 WHERE id = ANY($1)', [kids.map((k) => k.id), i.style === 'direct']);
      await logEvent('tutor_style_changed', { kids: kids.length, direct: i.style === 'direct' }, me.id);
      const who = kids.map((k) => k.name).join(' and ');
      return i.style === 'direct'
        ? `Done — I'll give ${who} direct answers with the worked steps when they ask.`
        : `Done — I'll guide ${who} with hints first and give the answer only when they're stuck or ask twice.`;
    },
  }),
  def({
    name: 'my_stats',
    description:
      "This person's own live numbers from MyDay: today's score (and what it's made of), current and longest streak, XP and level, tasks done/open today. Call it before stating any of these numbers if the conversation has gone on a while.",
    destructive: false,
    schema: z.object({}),
    json: { type: 'object', properties: {}, required: [], additionalProperties: false },
    summary: () => 'Check your numbers',
    run: async (me) => statsLine(await hanaStats(me)),
  }),
  def({
    name: 'kids_overview',
    description: "How the household's kids are doing today: chores done, points, homework open/overdue, reward requests, last sign-in.",
    destructive: false,
    schema: z.object({}),
    json: { type: 'object', properties: {}, required: [], additionalProperties: false },
    summary: () => 'Check on the kids',
    run: async (me) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      const kids = await kidsOverview();
      if (!kids.length) return 'There are no kids on the roster.';
      return kids
        .map((k) => `${k.member.name}: chores ${k.choresDone}/${k.choresToday}, ${k.pointsToday} points today, ${k.bank} to spend, ${k.openHomework} homework open${k.overdueHomework ? ` (${k.overdueHomework} past due)` : ''}${k.pendingRewards ? `, ${k.pendingRewards} reward request(s)` : ''}`)
        .join('\n');
    },
  }),
  def({
    name: 'money_summary',
    description: "A read-only money picture: linked account balances (if a bank is linked), this person's tracked bills and which are due in the next 7 days, and recent spending.",
    destructive: false,
    schema: z.object({}),
    json: { type: 'object', properties: {}, required: [], additionalProperties: false },
    summary: () => 'Look at the money picture',
    run: async (me) => {
      if (me.kind !== 'adult') throw new HttpError(403, 'That’s for grown-ups');
      const out: string[] = [];
      const { rows: acc } = await pool.query<{ name: string; mask: string; current: string | null; available: string | null }>('SELECT name, mask, current, available FROM money_accounts ORDER BY id LIMIT 12');
      if (acc.length) out.push(`Accounts: ${acc.map((a) => `${a.name}${a.mask ? ` …${a.mask}` : ''} $${Number(a.available ?? a.current ?? 0).toFixed(2)}`).join('; ')}`);
      else out.push('No bank linked yet.');
      const { rows: bills } = await pool.query<{ name: string; amount: string; due_day: number | null; autopay: boolean }>('SELECT name, amount, due_day, autopay FROM bills WHERE member_id = $1 ORDER BY due_day NULLS LAST', [me.id]);
      const t = today();
      const soon = new Set([0, 1, 2, 3, 4, 5, 6].map((n) => Number(addDays(t, n).slice(8))));
      if (bills.length) {
        out.push(`Bills: ${bills.map((b) => `${b.name} $${Number(b.amount)}${b.due_day ? ` (day ${b.due_day})` : ''}${b.autopay ? ' autopay' : ''}`).join('; ')}`);
        const due = bills.filter((b) => b.due_day && soon.has(b.due_day) && !b.autopay);
        out.push(due.length ? `Due in the next 7 days (not autopay): ${due.map((b) => b.name).join(', ')}` : 'Nothing due in the next 7 days that isn’t on autopay.');
      }
      const { rows: sp } = await pool.query<{ total: string | null }>("SELECT SUM(amount) AS total FROM money_transactions WHERE amount > 0 AND day > $1", [addDays(t, -30)]);
      if (sp[0]?.total) out.push(`Spent in the last 30 days: $${Number(sp[0].total).toFixed(2)}`);
      return out.join('\n');
    },
  }),
  // ---------- destructive: proposed, then confirmed in the chat ----------
  def({
    name: 'delete_task',
    description: "Delete one of today's tasks by #id. Needs the person's confirmation in the app; it is not done until they tap Confirm.",
    destructive: true,
    schema: z.object({ task_id: z.number().int().positive() }),
    json: { type: 'object', properties: { task_id: { type: 'integer' } }, required: ['task_id'], additionalProperties: false },
    summary: (i) => `Delete task #${i.task_id}`,
    run: async (me, i) => {
      const name = await ownTask(me, i.task_id);
      await pool.query('DELETE FROM tasks WHERE id = $1 AND member_id = $2', [i.task_id, me.id]);
      return `Deleted “${name}”.`;
    },
  }),
  def({
    name: 'clear_checked_groceries',
    description: 'Remove every checked-off item from the shared grocery list. Needs confirmation in the app.',
    destructive: true,
    schema: z.object({}),
    json: { type: 'object', properties: {}, additionalProperties: false },
    summary: () => 'Clear checked-off groceries',
    run: async () => {
      const r = await pool.query('DELETE FROM grocery_items WHERE done');
      return `Cleared ${r.rowCount ?? 0} checked-off grocery item(s).`;
    },
  }),
  def({
    name: 'remove_bill',
    description: 'Stop tracking a bill, by its #id from the context. Needs confirmation in the app.',
    destructive: true,
    schema: z.object({ bill_id: z.number().int().positive() }),
    json: { type: 'object', properties: { bill_id: { type: 'integer' } }, required: ['bill_id'], additionalProperties: false },
    summary: (i) => `Stop tracking bill #${i.bill_id}`,
    run: async (me, i) => {
      const r = await pool.query<{ name: string }>('DELETE FROM bills WHERE id = $1 AND member_id = $2 RETURNING name', [i.bill_id, me.id]);
      if (!r.rows[0]) throw new HttpError(404, `There is no bill #${i.bill_id}`);
      return `Stopped tracking ${r.rows[0].name}.`;
    },
  }),
  def({
    name: 'forget',
    description: 'Forget one thing you remembered about this person, by memory id (from the list you can see).',
    destructive: true,
    schema: z.object({ memory_id: z.number().int() }),
    json: { type: 'object', properties: { memory_id: { type: 'integer' } }, required: ['memory_id'], additionalProperties: false },
    summary: (i) => `Forget memory #${i.memory_id}`,
    run: async (me, i) => {
      const r = await pool.query<{ fact: string }>('DELETE FROM hana_memories WHERE id = $1 AND member_id = $2 RETURNING fact', [i.memory_id, me.id]);
      if (!r.rows[0]) throw new HttpError(404, `There is no memory #${i.memory_id}`);
      return `Forgotten: “${r.rows[0].fact}”.`;
    },
  }),
] as const;

type AnyTool = ToolDef<z.ZodType>;
const byName = (name: string): AnyTool | undefined => (HANA_TOOLS as readonly AnyTool[]).find((t) => t.name === name);

interface ActionRow {
  id: number;
  tool: string;
  summary: string;
  status: HanaAction['status'];
  result: string;
}

export const toAction = (r: ActionRow): HanaAction => ({
  id: r.id,
  tool: r.tool,
  summary: r.summary,
  destructive: byName(r.tool)?.destructive ?? false,
  status: r.status,
  result: r.result,
});

export async function pendingActions(memberId: number): Promise<HanaAction[]> {
  const { rows } = await pool.query<ActionRow>(
    "SELECT id, tool, summary, status, result FROM hana_actions WHERE member_id = $1 AND status = 'pending' AND created_at > now() - interval '1 day' ORDER BY id",
    [memberId],
  );
  return rows.map(toAction);
}

/** Deterministic intents for the local stub (CHAT_STUB=1). Real Claude picks tools itself. */
export function stubPlan(message: string): Array<{ name: string; input: unknown }> {
  const m = message.trim();
  let x: RegExpMatchArray | null;
  if ((x = m.match(/^(?:please\s+)?add (?:a )?task:?\s+(.+)$/i))) return [{ name: 'add_task', input: { task: x[1], priority: 'Important', energy: 'Low Brain' } }];
  if ((x = m.match(/^(?:please\s+)?add (.+?) to (?:the )?grocer(?:y|ies)(?: list)?\.?$/i))) {
    return [{ name: 'add_grocery_items', input: { items: (x[1] ?? '').split(/,\s*|\s+and\s+/i).map((s) => s.trim()).filter(Boolean) } }];
  }
  if ((x = m.match(/^(?:delete|remove) task #?(\d+)/i))) return [{ name: 'delete_task', input: { task_id: Number(x[1]) } }];
  if ((x = m.match(/^(?:complete|finish|done with) task #?(\d+)/i))) return [{ name: 'complete_task', input: { task_id: Number(x[1]) } }];
  if (/^move (?:my )?workout to tomorrow/i.test(m)) return [{ name: 'move_workout', input: { to: 'tomorrow' } }];
  if (/^clear (?:the )?(?:checked|done)(?:[- ]off)? groceries/i.test(m)) return [{ name: 'clear_checked_groceries', input: {} }];
  if ((x = m.match(/^(?:note|remember):?\s+(.+)$/i))) return [{ name: 'capture_note', input: { note: x[1] } }];
  if ((x = m.match(/^remind me (?:on (\d{4}-\d{2}-\d{2}) )?at (\d{1,2}):(\d{2}) to (.+)$/i))) {
    return [{ name: 'set_reminder', input: { text: x[4], date: x[1] ?? today(), time: `${String(x[2]).padStart(2, '0')}:${x[3]}` } }];
  }
  if ((x = m.match(/^put (.+?) on the calendar (?:on )?(\d{4}-\d{2}-\d{2})(?: at (\d{2}:\d{2}))?(?: for (\w+))?$/i))) {
    return [{ name: 'add_calendar_event', input: { title: x[1], date: x[2], start_time: x[3] ?? null, end_time: null, for_people: x[4] ? [x[4]] : [], repeat: 'none', remind_minutes: null, location: '' } }];
  }
  if (/^what['’]?s on (?:the )?calendar/i.test(m)) return [{ name: 'get_calendar', input: { from: null, days: 7 } }];
  if ((x = m.match(/^always remember:?\s+(.+)$/i))) return [{ name: 'remember', input: { fact: x[1] } }];
  if ((x = m.match(/^forget memory #?(\d+)/i))) return [{ name: 'forget', input: { memory_id: Number(x[1]) } }];
  if ((x = m.match(/^plan (.+?)(?: on (Mon|Tue|Wed|Thu|Fri|Sat|Sun))?$/i))) return [{ name: 'plan_meal', input: { meal: x[1], day: x[2] ? x[2].slice(0, 1).toUpperCase() + x[2].slice(1, 3).toLowerCase() : null } }];
  if ((x = m.match(/^give (\w+) the chore (.+?) on ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[ ,]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)(?: for (\d+) points)?$/i))) {
    return [{ name: 'add_chore', input: { person: x[1], chore: x[2], days: (x[3] ?? '').split(/[ ,]+/).map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3).toLowerCase()), points: Number(x[4] ?? 10) } }];
  }
  // "add them all:" then one chore per line: "Name: chore (Mon Wed, 10)"
  if (/^add them all:?\s*\n/i.test(m)) {
    const chores = m
      .split('\n')
      .slice(1)
      .map((l) => l.match(/^\s*(\w+):\s*(.+?)\s*\(((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:[ ,]+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*),\s*(\d+)\)\s*$/i))
      .filter((y): y is RegExpMatchArray => !!y)
      .map((y) => ({ person: y[1], chore: y[2], days: (y[3] ?? '').split(/[ ,]+/).map((d) => d.slice(0, 1).toUpperCase() + d.slice(1, 3).toLowerCase()), points: Number(y[4]) }));
    if (chores.length) return [{ name: 'add_chores', input: { chores } }];
  }
  if ((x = m.match(/^(?:order|send) the groceries(?: (?:to|from|on) (instacart|kroger))?/i))) return [{ name: 'send_groceries', input: { to: (x[1] ?? 'instacart').toLowerCase() } }];
  if ((x = m.match(/^find flights from ([a-z]{3}) to ([a-z]{3}) on (\d{4}-\d{2}-\d{2})(?: returning (\d{4}-\d{2}-\d{2}))?(?: for (\d) adults?)?/i))) {
    return [{ name: 'find_flights', input: { from: x[1], to: x[2], depart: x[3], return: x[4] ?? null, adults: Number(x[5] ?? 1), cabin: 'economy' } }];
  }
  if ((x = m.match(/^errand on ([^:]{2,60}):\s*(.{4,})$/i))) return [{ name: 'run_errand', input: { site: x[1], goal: x[2] } }];
  if (/^how are the kids/i.test(m)) return [{ name: 'kids_overview', input: {} }];
  if ((x = m.match(/^(direct|hints)(?: answers| first)?(?: for (\w+))?$/i))) return [{ name: 'set_homework_help', input: { kid_name: x[2] ?? null, style: (x[1] ?? '').toLowerCase() } }];
  if (/^what['’]?s my (?:score|streak|xp|level)/i.test(m)) return [{ name: 'my_stats', input: {} }];
  if (/^how['’]?s (?:my|our) money/i.test(m)) return [{ name: 'money_summary', input: {} }];
  if ((x = m.match(/^add homework for (\w+):\s*(.+?)(?: due (\d{4}-\d{2}-\d{2}))?$/i))) {
    return [{ name: 'add_homework', input: { kid_name: x[1], assignment: x[2], subject: '', due: x[3] ?? null } }];
  }
  return [];
}

/**
 * The API allows at most 20 strict tools per request (a 21st makes every chat
 * fail with a 400). Strict mode goes to the tools where exact arguments matter
 * most — confirm-first ones, then ones with arguments; the rest are still
 * checked by their zod schema before they run.
 */
export const MAX_STRICT_TOOLS = 20;
export function hanaToolDefs(): BetaTool[] {
  const rank = (t: AnyTool): number => (t.destructive ? 0 : Object.keys((t.json as { properties?: object }).properties ?? {}).length ? 1 : 2);
  const strict = new Set([...(HANA_TOOLS as readonly AnyTool[])].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_STRICT_TOOLS).map((t) => t.name));
  return HANA_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.json, ...(strict.has(t.name) ? { strict: true } : {}) }));
}

/** The tools for one chat turn, recording every action taken or proposed. */
export function hanaKit(me: HouseholdMember, taken: HanaAction[]): ToolKit {
  return {
    tools: hanaToolDefs(),
    stubPlan,
    exec: async (name, input) => {
      const tool = byName(name);
      if (!tool) throw new HttpError(400, `Unknown action ${name}`);
      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) throw new HttpError(400, `That ${name} request was incomplete`);
      const summary = tool.summary(parsed.data);
      if (tool.destructive) {
        const { rows } = await pool.query<ActionRow>(
          'INSERT INTO hana_actions (member_id, tool, input, summary) VALUES ($1, $2, $3, $4) RETURNING id, tool, summary, status, result',
          [me.id, name, JSON.stringify(parsed.data), summary],
        );
        if (rows[0]) taken.push(toAction(rows[0]));
        await logEvent('hana_action', { tool: name, status: 'pending' }, me.id);
        return `Not done yet: "${summary}" needs the person's OK. A Confirm button is now showing in the chat — tell them to tap it. Do not say it is done.`;
      }
      let result: string;
      let status: HanaAction['status'] = 'done';
      try {
        result = await tool.run(me, parsed.data);
      } catch (e) {
        status = 'failed';
        result = e instanceof HttpError ? e.message : 'That action failed';
        if (!(e instanceof HttpError)) console.error('hana action failed', name, e);
      }
      const { rows } = await pool.query<ActionRow>(
        'INSERT INTO hana_actions (member_id, tool, input, summary, status, result) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, tool, summary, status, result',
        [me.id, name, JSON.stringify(parsed.data), summary, status, result],
      );
      if (rows[0]) taken.push(toAction(rows[0]));
      await logEvent('hana_action', { tool: name, status }, me.id);
      if (status === 'failed') throw new HttpError(400, result);
      return result;
    },
  };
}

/** The person tapped Confirm (or Cancel) on a proposed action. */
export async function decideAction(me: HouseholdMember, id: number, confirm: boolean): Promise<HanaAction> {
  const { rows } = await pool.query<ActionRow & { input: unknown }>(
    "SELECT id, tool, summary, status, result, input FROM hana_actions WHERE id = $1 AND member_id = $2",
    [id, me.id],
  );
  const a = rows[0];
  if (!a) throw new HttpError(404, 'No such action');
  if (a.status !== 'pending') throw new HttpError(409, `That action was already ${a.status}`);
  const tool = byName(a.tool);
  if (!tool) throw new HttpError(400, 'Unknown action');
  let status: HanaAction['status'] = 'cancelled';
  let result = 'Cancelled — nothing changed.';
  if (confirm) {
    try {
      result = await tool.run(me, tool.schema.parse(a.input));
      status = 'done';
    } catch (e) {
      status = 'failed';
      result = e instanceof HttpError ? e.message : 'That action failed';
    }
  }
  const upd = await pool.query<ActionRow>(
    "UPDATE hana_actions SET status = $2, result = $3 WHERE id = $1 AND status = 'pending' RETURNING id, tool, summary, status, result",
    [id, status, result],
  );
  const row = upd.rows[0];
  if (!row) throw new HttpError(409, 'That action was already decided');
  await logEvent('hana_action_confirmed', { tool: a.tool, status }, me.id);
  return toAction(row);
}
