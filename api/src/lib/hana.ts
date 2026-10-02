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
import { ENERGIES, PRIORITIES, type HanaAction, type HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { profileFor, plannedSession } from '../routes/health.js';
import type { ToolKit } from './ai.js';
import { addDays, today } from './dates.js';
import { logEvent } from './events.js';
import { HttpError } from './http.js';
import { listMembers } from './members.js';

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

async function ownTask(me: HouseholdMember, id: number): Promise<string> {
  const { rows } = await pool.query<{ task: string }>('SELECT task FROM tasks WHERE id = $1 AND member_id = $2', [id, me.id]);
  const t = rows[0];
  if (!t) throw new HttpError(404, `There is no task #${id} on your list`);
  return t.task;
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
  if ((x = m.match(/^add homework for (\w+):\s*(.+?)(?: due (\d{4}-\d{2}-\d{2}))?$/i))) {
    return [{ name: 'add_homework', input: { kid_name: x[1], assignment: x[2], subject: '', due: x[3] ?? null } }];
  }
  return [];
}

/** The tools for one chat turn, recording every action taken or proposed. */
export function hanaKit(me: HouseholdMember, taken: HanaAction[]): ToolKit {
  return {
    tools: HANA_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.json, strict: true })),
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
