/**
 * Ask Hana (companion, grown-ups) and the homework tutor (kids + the student
 * track). Ported from apiChatHistory / apiChatSend / chatDayContext_ /
 * chatSystem_: same prompts, same context, same reply lengths. History is
 * stored server-side and the model sees the last 10 turns.
 */
import { Router, type Request } from 'express';
import type { CalRepeat, ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction, HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { datesOf } from '../lib/recur.js';
import { logEvent } from '../lib/events.js';
import { decideAction, hanaKit, pendingActions } from '../lib/hana.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { checkAiMonthly } from '../lib/limits.js';
import { requireAiConsent } from './account.js';
import { chatModel, type ChatTurn } from '../lib/ai.js';
import { dailyScore, trackOf } from '../lib/adult.js';
import { activeDates, computeStreak } from '../lib/streak.js';
import { isoToWeekday } from '../lib/dates.js';
import { libraryBrief } from '../lib/library.js';
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
  failed: boolean;
  client_id: string | null;
}

const toMsg = (r: MsgRow): ChatMessage => ({ id: r.id, who: r.who, text: r.text, at: r.created_at.toISOString(), failed: r.failed, clientId: r.client_id });

async function history(memberId: number, mode: ChatMode, limit = 40): Promise<ChatMessage[]> {
  const { rows } = await pool.query<MsgRow>(
    `SELECT id, who, text, created_at, failed, client_id FROM chat_messages WHERE member_id = $1 AND mode = $2 ORDER BY id DESC LIMIT $3`,
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
  // The household calendar, today and tomorrow.
  const { rows: ev } = await pool.query<{ title: string; starts_on: string; start_time: string | null; repeat: CalRepeat; repeat_until: string | null; adults_only: boolean }>(
    'SELECT title, starts_on::text AS starts_on, start_time::text AS start_time, repeat, repeat_until::text AS repeat_until, adults_only FROM calendar_events',
  );
  const cal: string[] = [];
  for (const e of ev) for (const d of datesOf(e, t, addDays(t, 1))) cal.push(`${d === t ? 'today' : 'tomorrow'}${e.start_time ? ` ${e.start_time.slice(0, 5)}` : ''} ${e.title}`);
  if (cal.length) bits.push(`On the household calendar: ${cal.sort().join('; ')}`);
  // What they asked Hana to remember, and reminders still to come.
  const { rows: mem } = await pool.query<{ id: number; fact: string }>('SELECT id, fact FROM hana_memories WHERE member_id = $1 ORDER BY id LIMIT 100', [me.id]);
  if (mem.length) bits.push(`Things you remember about ${me.name} (memory ids): ${mem.map((m) => `#${m.id} ${m.fact}`).join('; ')}`);
  const { rows: rem } = await pool.query<{ text: string; remind_at: Date }>('SELECT text, remind_at FROM hana_reminders WHERE member_id = $1 AND sent_at IS NULL ORDER BY remind_at LIMIT 10', [me.id]);
  if (rem.length) bits.push(`Reminders you set for them: ${rem.map((r) => `${r.text} (${r.remind_at.toISOString()})`).join('; ')}`);
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
    'You are their personal assistant and can act in MyDay with your tools: tasks, groceries, notes, homework, workouts, bills, ' +
    'the shared household calendar (add and read events), push reminders at a time ("remind me at 5 to…"), planning meals from ' +
    'the recipe library, kids’ chores, how the kids are doing, a read-only money picture, sending the grocery list to Instacart or their Kroger cart, searching flights with booking links, and errands on websites in a real browser with their saved logins (run_errand: reorder, check an order, book a table) — anything that spends money waits for their OK, so never say something was bought or booked until the errand says it was. When they ask you to do something, ' +
    'do it rather than telling them how. When they tell you a lasting preference or fact about themselves or their family ' +
    '("I’m vegetarian", "soccer is every Tuesday"), save it with remember. Times are the household’s local time. Deleting, ' +
    'clearing or forgetting anything only happens after they tap Confirm, so never say it is done until it is.'
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

/**
 * Hana's library rules (Ask Hana): on ADHD/ADD questions she reads the book,
 * then the medical reference, then her general knowledge — in that order —
 * cites in plain words, never invents a source, says when she doesn't know,
 * and never diagnoses or prescribes.
 */
export function libraryInstructions(message: string, earlier: string[] = []): string {
  const brief = libraryBrief(message, earlier);
  return (
    '\n\nHANA’S LIBRARY. For any question about ADHD or ADD (symptoms, diagnosis, medication, treatment, diet, sleep, exercise, school, work, relationships, emotions): ' +
    'answer from the library passages below in this order — the book "Conquer ADHD Everyday" by T. Hunter first, then the medical reference, and only then your general knowledge to fill a gap (say plainly when you do). ' +
    'Cite in plain words, e.g. "In Chapter 4 of Conquer ADHD Everyday…" or "Per the CDC’s ADHD treatment guidance (updated June 2026)…". ' +
    'Only cite a source that appears in the passages below — never invent a book chapter, study, statistic, quote or link. ' +
    'If the library doesn’t cover it and you aren’t sure, say so plainly ("That isn’t in my library, and I don’t know of solid evidence either way") instead of guessing. ' +
    'Never diagnose anyone, and never tell anyone to start, stop, skip or change a medication or dose — that’s for their prescriber; you can suggest questions to ask them. ' +
    'Never contradict the community safety rules. ' +
    'Passages are looked up fresh for each message, so an earlier answer in this conversation may rest on passages that aren’t shown now: never retract, apologize for or “correct” an earlier answer’s citations just because its passage isn’t shown below — correct something only if a passage below actually contradicts it. ' +
    'When an answer touches anything medical (symptoms, diagnosis, medication, supplements, sleep problems, therapy), end it with one short plain line: "I’m not a doctor — please talk with yours about this."' +
    (brief ? `\n\n${brief}` : '\n\n(No library passages matched this message. If it is an ADHD question, say what you do and don’t know.)')
  );
}

chatRouter.post('/api/chat/:mode', async (req, res) => {
  const { me, mode } = await modeFor(req);
  const body = req.body as { message?: unknown; lectureId?: unknown; clientId?: unknown };
  const msg = str(body.message, 'message', 2000, true);
  const clientId = typeof body.clientId === 'string' && /^[\w-]{8,64}$/.test(body.clientId) ? body.clientId : null;
  // Under 13: a parent turns the homework helper on first (it sends the child's words to an AI provider).
  if (mode === 'tutor') await requireAiConsent(me);
  await checkAiMonthly();
  const model = chatModel();
  if (!model) throw new HttpError(503, 'Ask Hana needs a grown-up to finish setting it up');
  if (!chatLimit(String(me.id))) throw new HttpError(429, "That's a lot of questions — take a breather and try again soon");

  // One row per message: a retry (same clientId) reuses it instead of saving a copy.
  let rowId: number;
  const existing = clientId
    ? (await pool.query<{ id: number; failed: boolean }>("SELECT id, failed FROM chat_messages WHERE member_id = $1 AND mode = $2 AND client_id = $3 AND who = 'user'", [me.id, mode, clientId])).rows[0]
    : undefined;
  if (existing && !existing.failed) {
    // Already answered (or still being answered): never twice.
    const answered = (await pool.query("SELECT 1 FROM chat_messages WHERE member_id = $1 AND mode = $2 AND id > $3 AND who = 'hana' LIMIT 1", [me.id, mode, existing.id])).rowCount;
    if (!answered) throw new HttpError(409, 'Hana is still answering that one');
    const out: ChatSendResponse = { reply: null, history: await history(me.id, mode), actions: [] };
    res.json(out);
    return;
  }
  if (existing) {
    rowId = existing.id;
    await pool.query('UPDATE chat_messages SET failed = false WHERE id = $1', [rowId]);
  } else {
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO chat_messages (member_id, mode, who, text, client_id) VALUES ($1, $2, 'user', $3, $4) ON CONFLICT DO NOTHING RETURNING id",
      [me.id, mode, msg, clientId],
    );
    if (!ins.rows[0]) throw new HttpError(409, 'Hana is still answering that one');
    rowId = ins.rows[0].id;
  }
  // What Hana sees: the conversation before this message, without ones she couldn't answer.
  const { rows: priorRows } = await pool.query<MsgRow>(
    'SELECT id, who, text, created_at, failed, client_id FROM chat_messages WHERE member_id = $1 AND mode = $2 AND id < $3 AND NOT failed ORDER BY id DESC LIMIT 10',
    [me.id, mode, rowId],
  );
  const turns: ChatTurn[] = priorRows.reverse().map((m) => ({ role: m.who === 'hana' ? 'assistant' : 'user', content: m.text.slice(0, 1000) }));
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
  // Hana's library (book → medical reference → general knowledge) for ADHD questions.
  if (mode === 'companion') system += libraryInstructions(msg, turns.filter((t) => t.role === 'user').map((t) => t.content));
  const actions: HanaAction[] = [];
  const started = Date.now();
  let text: string;
  try {
    text =
      mode === 'companion'
        ? await model.act(system, turns, hanaKit(me, actions), 600)
        : await model.reply(system, turns, mode === 'tutor' ? 450 : 600);
  } catch (e) {
    // Kept, marked: the screen shows it with Retry (and a retry reuses this row).
    await pool.query('UPDATE chat_messages SET failed = true WHERE id = $1', [rowId]);
    console.error(`chat: send ${mode} member=${me.id} model=${model.kind === 'claude' ? process.env.CHAT_MODEL || 'claude-opus-5-5' : 'stub'} ms=${Date.now() - started} error=${e instanceof HttpError ? e.status : 'exception'}`);
    throw e;
  }
  console.log(`chat: send ${mode} member=${me.id} model=${model.kind === 'claude' ? process.env.CHAT_MODEL || 'claude-opus-5-5' : 'stub'} ms=${Date.now() - started} ok actions=${actions.length}`);
  await logEvent('hana_asked', { mode, actions: actions.length }, me.id);
  const { rows } = await pool.query<MsgRow>(
    "INSERT INTO chat_messages (member_id, mode, who, text) VALUES ($1, $2, 'hana', $3) RETURNING id, who, text, created_at, failed, client_id",
    [me.id, mode, text],
  );
  const reply = rows[0];
  if (!reply) throw new Error('reply insert returned nothing');
  const out: ChatSendResponse = { reply: toMsg(reply), history: await history(me.id, mode), actions };
  res.json(out);
});

/** Delete one message from your own conversation with Hana. */
chatRouter.delete('/api/chat/:mode/messages/:id', async (req, res) => {
  const { me, mode } = await modeFor(req);
  const { rowCount } = await pool.query('DELETE FROM chat_messages WHERE id = $1 AND member_id = $2 AND mode = $3', [idParam(req.params.id), me.id, mode]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ history: await history(me.id, mode) });
});

/** Clear your whole conversation with Hana (what she remembers is separate, on the same page). */
chatRouter.delete('/api/chat/:mode', async (req, res) => {
  const { me, mode } = await modeFor(req);
  await pool.query('DELETE FROM chat_messages WHERE member_id = $1 AND mode = $2', [me.id, mode]);
  res.json({ history: [] });
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
