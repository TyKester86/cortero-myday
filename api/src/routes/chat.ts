/**
 * Ask Hana (companion, grown-ups) and the homework tutor (kids + the student
 * track). Ported from apiChatHistory / apiChatSend / chatDayContext_ /
 * chatSystem_: same prompts, same context, same reply lengths. History is
 * stored server-side and the model sees the last 10 turns.
 */
import { Router, type Request } from 'express';
import type { ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction, HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { today } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { decideAction, hanaKit, pendingActions } from '../lib/hana.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { chatModel, type ChatTurn } from '../lib/ai.js';
import { dailyScore, trackOf } from '../lib/adult.js';
import { activeDates, computeStreak } from '../lib/streak.js';
import { isoToWeekday } from '../lib/dates.js';
import { lectureMaterial } from './lectures.js';

export const chatRouter = Router();

const chatLimit = rateLimiter(30, 60 * 60_000); // per member per hour

async function modeFor(req: Request): Promise<{ me: HouseholdMember; mode: ChatMode }> {
  const me = self(req);
  const mode = req.params.mode;
  if (mode !== 'companion' && mode !== 'tutor') throw new HttpError(404, 'No such chat');
  if (me.kind === 'kid' && mode !== 'tutor') throw new HttpError(403, 'Kids get the homework tutor');
  if (me.kind === 'adult' && mode === 'tutor' && (await trackOf(me.id)) !== 'student') {
    throw new HttpError(403, 'The tutor is for kids and students');
  }
  return { me, mode };
}

interface MsgRow {
  id: number;
  who: 'user' | 'hana';
  text: string;
  created_at: Date;
}

const toMsg = (r: MsgRow): ChatMessage => ({ id: r.id, who: r.who, text: r.text, at: r.created_at.toISOString() });

async function history(memberId: number, mode: ChatMode, limit = 40): Promise<ChatMessage[]> {
  const { rows } = await pool.query<MsgRow>(
    `SELECT id, who, text, created_at FROM chat_messages WHERE member_id = $1 AND mode = $2 ORDER BY id DESC LIMIT $3`,
    [memberId, mode, limit],
  );
  return rows.reverse().map(toMsg);
}

/** chatDayContext_: what Hana can see. */
async function dayContext(me: HouseholdMember, mode: ChatMode): Promise<string> {
  const t = today();
  const bits: string[] = [];
  if (mode === 'tutor' && me.kind === 'kid') {
    const { rows } = await pool.query<{ assignment: string; subject: string }>(
      'SELECT assignment, subject FROM homework WHERE member_id = $1 AND NOT done ORDER BY due NULLS LAST, id LIMIT 6',
      [me.id],
    );
    if (rows.length) bits.push(rows.map((r) => `${r.assignment} (${r.subject || 'general'})`).join('; '));
    return bits.join('. ');
  }
  const { rows: open } = await pool.query<{ id: number; task: string }>(
    'SELECT id, task FROM tasks WHERE member_id = $1 AND day = $2 AND NOT done ORDER BY id LIMIT 12',
    [me.id, t],
  );
  if (mode === 'tutor') {
    if (open.length) bits.push(open.map((r) => r.task).join('; '));
    return bits.join('. ');
  }
  const track = await trackOf(me.id);
  const score = await dailyScore(me.id, track, t);
  bits.push(`Today score ${score.total}/100`);
  const streak = computeStreak(await activeDates(me.id), t);
  if (streak.current) bits.push(`streak ${streak.current} days`);
  if (open.length) bits.push(`Open tasks today: ${open.map((r) => `#${r.id} ${r.task}`).join('; ')}`);
  const { rows: bills } = await pool.query<{ id: number; name: string; amount: string }>('SELECT id, name, amount FROM bills WHERE member_id = $1 ORDER BY id LIMIT 20', [me.id]);
  if (bills.length) bits.push(`Tracked bills: ${bills.map((b) => `#${b.id} ${b.name} $${Number(b.amount)}`).join('; ')}`);
  const kids = (await pool.query<{ name: string }>("SELECT name FROM household_members WHERE kind = 'kid' AND archived_at IS NULL ORDER BY sort_order")).rows;
  if (kids.length) bits.push(`Kids in the household: ${kids.map((k) => k.name).join(', ')}`);
  // The shared grocery list + this week's meals, so anyone can ask about them.
  const { rows: groc } = await pool.query<{ item: string }>('SELECT item FROM grocery_items WHERE NOT done ORDER BY id LIMIT 12');
  if (groc.length) bits.push(`Shared grocery list still to get: ${groc.map((g) => g.item).join('; ')}`);
  const { rows: meals } = await pool.query<{ title: string; day: number | null }>(
    `SELECT m.title, e.day FROM meal_plan_entries e JOIN meals m ON m.id = e.meal_id
      WHERE e.member_id = $1 ORDER BY e.day NULLS LAST, e.id LIMIT 10`,
    [me.id],
  );
  if (meals.length) {
    bits.push(`This week’s meals: ${meals.map((m) => (m.day ? `${isoToWeekday(m.day)}: ` : '') + m.title).join('; ')}`);
  }
  return bits.join('. ');
}

/** chatSystem_, verbatim apart from the name/age coming from the roster. */
async function systemPrompt(me: HouseholdMember, mode: ChatMode, ctx: string): Promise<string> {
  const day = today();
  if (mode === 'tutor' && me.kind === 'kid') {
    const age = me.age ?? 12;
    return (
      `You are a friendly homework tutor for ${me.name}, age ${age}, inside the MyDay family app. ` +
      'YOUR #1 RULE: never give the final answer directly. Never do their homework for them. Instead: ask one guiding ' +
      'question at a time, break problems into tiny steps, give hints, and celebrate effort and good thinking. If they ask ' +
      'you to just give the answer, calmly decline ("That is my one rule — I help you figure it out.") and ask a ' +
      `guiding question. Keep replies under 100 words, warm, at a ${age}-year-old reading level. Today is ${day}. ` +
      (ctx ? `Their open homework: ${ctx}. ` : '') +
      'If they are frustrated, be extra encouraging - effort counts here.'
    );
  }
  if (mode === 'tutor') {
    return (
      `You are a Socratic tutor for college student ${me.name} inside the MyDay app (built on the ConquerADHD book system). ` +
      'Never hand over finished work: no complete essays, no direct answers to graded problems, no doing assignments for them. ' +
      'Instead: probe understanding with sharp questions, suggest study strategies (SQ3R, retrieval practice, spaced repetition, ' +
      'office hours), help them plan their approach, and review THEIR work when they share it. Be direct, college-level, no fluff. ' +
      `Keep replies focused (under 150 words unless they ask for depth). Today is ${day}. ` +
      (ctx ? `Their open assignments: ${ctx}.` : '')
    );
  }
  const role = { leader: 'Family Leader', woman: 'Heart of Home', student: 'Student', kid: 'Kid' }[await trackOf(me.id)];
  return (
    'You are Hana, the warm, sharp AI companion inside the MyDay family app (built on the ConquerADHD book system). ' +
    `You are talking to ${me.name} (${role}). Today is ${day}. ` +
    (ctx ? `What you can see of their day: ${ctx}. ` : '') +
    'Be brief (under 120 words unless they ask for more), concrete, encouraging. ADHD-friendly: one clear next step, no ' +
    'lectures, no shame. Reference their day when useful. Never invent data you were not given. ' +
    'You can act in MyDay with your tools (tasks, groceries, notes, homework, workouts, bills) — when they ask you to do ' +
    'something, do it rather than telling them how. Deleting or clearing anything only happens after they tap Confirm, so ' +
    'never say a delete is done until it is.'
  );
}

chatRouter.get('/api/chat/:mode', async (req, res) => {
  const { me, mode } = await modeFor(req);
  const out: ChatState = {
    mode,
    available: chatModel() !== null,
    history: await history(me.id, mode),
    pending: mode === 'companion' ? await pendingActions(me.id) : [],
  };
  res.json(out);
});

chatRouter.post('/api/chat/:mode', async (req, res) => {
  const { me, mode } = await modeFor(req);
  const body = req.body as { message?: unknown; lectureId?: unknown };
  const msg = str(body.message, 'message', 2000, true);
  const model = chatModel();
  if (!model) throw new HttpError(503, 'Ask Hana needs a grown-up to finish setting it up');
  if (!chatLimit(String(me.id))) throw new HttpError(429, "That's a lot of questions — take a breather and try again soon");

  const prior = await history(me.id, mode, 10);
  await pool.query("INSERT INTO chat_messages (member_id, mode, who, text) VALUES ($1, $2, 'user', $3)", [me.id, mode, msg]);
  const turns: ChatTurn[] = prior.map((m) => ({ role: m.who === 'hana' ? 'assistant' : 'user', content: m.text.slice(0, 1000) }));
  turns.push({ role: 'user', content: msg });
  // The API wants the first turn from the user.
  while (turns[0]?.role === 'assistant') turns.shift();

  let system = await systemPrompt(me, mode, await dayContext(me, mode));
  // B3: the tutor can quiz from one of the student's own lectures.
  if (mode === 'tutor' && body.lectureId !== undefined && body.lectureId !== null) {
    const material = await lectureMaterial(me.id, idParam(body.lectureId));
    if (material) {
      system +=
        ' QUIZ MODE: quiz them on this lecture from their class, one question at a time, waiting for their answer; ' +
        `explain simply when they miss, and never just list the answers. Lecture material: ${material}`;
    }
  }
  const actions: HanaAction[] = [];
  const text =
    mode === 'companion'
      ? await model.act(system, turns, hanaKit(me, actions), 600)
      : await model.reply(system, turns, mode === 'tutor' ? 450 : 600);
  await logEvent('hana_asked', { mode, actions: actions.length }, me.id);
  const { rows } = await pool.query<MsgRow>(
    "INSERT INTO chat_messages (member_id, mode, who, text) VALUES ($1, $2, 'hana', $3) RETURNING id, who, text, created_at",
    [me.id, mode, text],
  );
  const reply = rows[0];
  if (!reply) throw new Error('reply insert returned nothing');
  const out: ChatSendResponse = { reply: toMsg(reply), history: await history(me.id, mode), actions };
  res.json(out);
});

/** Confirm or cancel an action Hana proposed; her note about it lands in the chat. */
for (const verb of ['confirm', 'cancel'] as const) {
  chatRouter.post(`/api/hana/actions/:id/${verb}`, async (req, res) => {
    const me = self(req);
    if (me.kind !== 'adult') throw new HttpError(403, 'Hana actions are for grown-ups');
    const action = await decideAction(me, idParam(req.params.id), verb === 'confirm');
    const note = action.status === 'done' ? `Done: ${action.result}` : action.status === 'failed' ? `That didn't work: ${action.result}` : 'Okay — I left it alone.';
    await pool.query("INSERT INTO chat_messages (member_id, mode, who, text) VALUES ($1, 'companion', 'hana', $2)", [me.id, note]);
    res.json({ action, history: await history(me.id, 'companion'), pending: await pendingActions(me.id) });
  });
}
