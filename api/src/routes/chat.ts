/**
 * Ask Hana (companion, grown-ups) and the homework tutor (kids + the student
 * track). Ported from apiChatHistory / apiChatSend / chatDayContext_ /
 * chatSystem_: same prompts, same context, same reply lengths. History is
 * stored server-side and the model sees the last 10 turns.
 */
import { Router, type Request } from 'express';
import type { BetaContentBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { CalRepeat, ChatAttachment, ChatMessage, ChatMode, ChatSendResponse, ChatState, HanaAction, HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { datesOf } from '../lib/recur.js';
import { logEvent } from '../lib/events.js';
import { decideAction, hanaKit, pendingActions } from '../lib/hana.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { checkHanaDaily } from '../lib/limits.js';
import { requireAiConsent } from './account.js';
import { chatModel, turnText, type ChatTurn } from '../lib/ai.js';
import { trackOf } from '../lib/adult.js';
import { homeworkLine, openHomework, PARENT_TEACHING, teachingRules, tutorDirect } from '../lib/teaching.js';
import { hanaStats, REWRITE_SYSTEM, STATS_RULE, statsLine, stripWrongStats, wrongStats, type HanaStats } from '../lib/hanaStats.js';
import { isoToWeekday } from '../lib/dates.js';
import { libraryBrief } from '../lib/library.js';
import { attachmentInfo, loadAttachments, type LoadedAttachment } from './chatFiles.js';
import { lectureMaterial } from './lectures.js';

export const chatRouter = Router();

const chatLimit = rateLimiter(Number(process.env.CHAT_PER_HOUR) || 30, 60 * 60_000); // per member per hour

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
  attachment_ids: number[];
}

const MSG_COLS = 'id, who, text, created_at, failed, client_id, attachment_ids';
const toMsg = (r: MsgRow, files: Map<number, ChatAttachment> = new Map()): ChatMessage => ({
  id: r.id,
  who: r.who,
  text: r.text,
  at: r.created_at.toISOString(),
  failed: r.failed,
  clientId: r.client_id,
  attachments: r.attachment_ids.map((id) => files.get(id)).filter((a): a is ChatAttachment => !!a),
});

async function history(memberId: number, mode: ChatMode, limit = 40): Promise<ChatMessage[]> {
  const { rows } = await pool.query<MsgRow>(`SELECT ${MSG_COLS} FROM chat_messages WHERE member_id = $1 AND mode = $2 ORDER BY id DESC LIMIT $3`, [memberId, mode, limit]);
  const files = await attachmentInfo(memberId, rows.flatMap((r) => r.attachment_ids));
  return rows.reverse().map((r) => toMsg(r, files));
}

/** A message with attachments → content blocks Hana can see: images, PDFs, text files, then the words. */
function withAttachments(text: string, files: LoadedAttachment[]): ChatTurn['content'] {
  if (!files.length) return text;
  const blocks: BetaContentBlockParam[] = [];
  for (const f of files) {
    if (f.mime.startsWith('image/')) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: f.mime as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif', data: f.data.toString('base64') } });
    } else if (f.mime === 'application/pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') }, title: f.name });
    } else {
      blocks.push({ type: 'text', text: `Attached file “${f.name}”:\n${f.data.toString('utf8').slice(0, 60_000)}` });
    }
  }
  blocks.push({ type: 'text', text: text || '(No message — please look at what I attached.)' });
  return blocks;
}

/** chatDayContext_: what Hana can see. */
async function dayContext(me: HouseholdMember, mode: ChatMode, stats: HanaStats | null): Promise<string> {
  const t = today();
  const bits: string[] = [];
  // A kid's open homework from the Homework tab, soonest due first.
  if (mode === 'tutor' && me.kind === 'kid') return homeworkLine(await openHomework(me));
  const { rows: open } = await pool.query<{ id: number; task: string }>(
    'SELECT id, task FROM tasks WHERE member_id = $1 AND day = $2 AND NOT done ORDER BY id LIMIT 12',
    [me.id, t],
  );
  if (mode === 'tutor') {
    if (open.length) bits.push(open.map((r) => r.task).join('; '));
    return bits.join('. ');
  }
  if (stats) bits.push(statsLine(stats));
  if (open.length) bits.push(`Open tasks today: ${open.map((r) => `#${r.id} ${r.task}`).join('; ')}`);
  const { rows: bills } = await pool.query<{ id: number; name: string; amount: string }>('SELECT id, name, amount FROM bills WHERE member_id = $1 ORDER BY id LIMIT 20', [me.id]);
  if (bills.length) bits.push(`Tracked bills: ${bills.map((b) => `#${b.id} ${b.name} $${Number(b.amount)}`).join('; ')}`);
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
    return (
      `You are Hana, the warm, patient tutor inside the MyDay family app, helping ${me.name} (age ${me.age ?? 12}) with school. Today is ${day}. ` +
      `${ctx} ${teachingRules(me.age, await tutorDirect(me.id))} ` +
      'Keep every reply short: usually under 120 words. A worked solution can run longer, but with one step per line.'
    );
  }
  if (mode === 'tutor') {
    return (
      `You are Hana, a Socratic tutor for college student ${me.name} inside the MyDay app (built on the ConquerADHD book system). Today is ${day}. ` +
      'Never hand over finished work: no complete essays, no direct answers to graded problems, no doing assignments for them. ' +
      'Instead: probe understanding with sharp questions, suggest study strategies (SQ3R, retrieval practice, spaced repetition, ' +
      'office hours), help them plan their approach, and review THEIR work when they share it. Be direct, college-level, no fluff. ' +
      `Keep replies focused (under 150 words unless they ask for depth). ${ctx ? `Their open tasks today: ${ctx}. ` : ''}` +
      teachingRules('college', false)
    );
  }
  const role = { leader: 'Family Leader', woman: 'Heart of Home', student: 'Student', kid: 'Kid' }[await trackOf(me.id)];
  return (
    'You are Hana, the warm, sharp AI companion inside the MyDay family app (built on the ConquerADHD book system). ' +
    `You are talking to ${me.name} (${role}). Today is ${day}. ` +
    (ctx ? `What you can see of their day: ${ctx}. ` : '') +
    'Be brief (under 120 words unless they ask for more), concrete, encouraging. ADHD-friendly: one clear next step, no ' +
    'lectures, no shame. Reference their day when useful. Never invent data you were not given. ' +
    `${PARENT_TEACHING} ` +
    `${STATS_RULE} ` +
    'You are their personal assistant and can act in MyDay with your tools: tasks, groceries, notes, homework, workouts, bills, ' +
    'the shared household calendar (add and read events), push reminders at a time ("remind me at 5 to…"), planning meals from ' +
    'the recipe library, kids’ chores, how the kids are doing, a read-only money picture, sending the grocery list to Instacart or their Kroger cart, searching flights with booking links, and errands on websites in a real browser with their saved logins (run_errand: reorder, check an order, book a table) — anything that spends money waits for their OK, so never say something was bought or booked until the errand says it was. When they ask you to do something, ' +
    'do it rather than telling them how. WORKING MEMORY: whenever they tell you something worth knowing next time — names and ages of ' +
    'people in their life, preferences, routines, what they’re working on or worried about, ongoing topics, context about their kids or work ' +
    '("I’m vegetarian", "soccer is every Tuesday", "my boss is Dana", "we’re potty training Evan") — save it right away with remember, ' +
    'one short fact per call, without asking, and don’t save something you already remember. Use what you remember naturally in later answers. ' +
    'Never save passwords, card or account numbers, or other secrets. They can see and edit everything you remember on the Ask Hana page. ' +
    'Times are the household’s local time. Deleting, ' +
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
    nextUp: mode === 'tutor' && me.kind === 'kid' ? ((await openHomework(me, 1))[0] ?? null) : null,
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
  const body = req.body as { message?: unknown; lectureId?: unknown; clientId?: unknown; attachmentIds?: unknown; retryId?: unknown };
  const wanted = Array.isArray(body.attachmentIds) ? [...new Set(body.attachmentIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))] : [];
  if (wanted.length > 4) throw new HttpError(400, 'Up to 4 attachments per message');
  const msg = str(body.message, 'message', 2000, wanted.length === 0);
  const clientId = typeof body.clientId === 'string' && /^[\w-]{8,64}$/.test(body.clientId) ? body.clientId : null;
  // Under 13: a parent turns the homework helper on first (it sends the child's words to an AI provider).
  if (mode === 'tutor') await requireAiConsent(me);
  await checkHanaDaily(req.householdId ?? 0, me.kind === 'adult' ? 'adult' : 'kid');
  const model = chatModel();
  if (!model) throw new HttpError(503, 'Ask Hana needs a grown-up to finish setting it up');
  if (!chatLimit(String(me.id))) throw new HttpError(429, "That's a lot of questions — take a breather and try again soon");

  // One row per message: a retry (same clientId) reuses it instead of saving a copy.
  let rowId: number;
  // Retry of an older message that has no client id yet (sent before ids existed): it takes this one, so it's retried in place.
  if (clientId && body.retryId !== undefined && body.retryId !== null) {
    await pool.query("UPDATE chat_messages SET client_id = $4 WHERE id = $1 AND member_id = $2 AND mode = $3 AND who = 'user' AND failed AND client_id IS NULL", [
      idParam(body.retryId), me.id, mode, clientId,
    ]);
  }
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
  let attached: number[];
  if (existing) {
    rowId = existing.id;
    await pool.query('UPDATE chat_messages SET failed = false WHERE id = $1', [rowId]);
    attached = (await pool.query<{ attachment_ids: number[] }>('SELECT attachment_ids FROM chat_messages WHERE id = $1', [rowId])).rows[0]?.attachment_ids ?? [];
  } else {
    // Only the person's own attachments, and only ones not already sent with another message.
    const { rows: own } = wanted.length
      ? await pool.query<{ id: number }>(
          `SELECT a.id FROM chat_attachments a WHERE a.member_id = $1 AND a.id = ANY($2::int[])
             AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.member_id = $1 AND a.id = ANY(m.attachment_ids))`,
          [me.id, wanted],
        )
      : { rows: [] as Array<{ id: number }> };
    if (own.length !== wanted.length) throw new HttpError(400, 'Attach the file again — that one isn’t available');
    attached = wanted;
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO chat_messages (member_id, mode, who, text, client_id, attachment_ids) VALUES ($1, $2, 'user', $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id",
      [me.id, mode, msg, clientId, attached],
    );
    if (!ins.rows[0]) throw new HttpError(409, 'Hana is still answering that one');
    rowId = ins.rows[0].id;
  }
  // What Hana sees: the conversation before this message (the last 16), without ones she couldn't answer.
  const { rows: priorRows } = await pool.query<MsgRow>(
    `SELECT ${MSG_COLS} FROM chat_messages WHERE member_id = $1 AND mode = $2 AND id < $3 AND NOT failed ORDER BY id DESC LIMIT 16`,
    [me.id, mode, rowId],
  );
  const earlierFiles = await attachmentInfo(me.id, priorRows.flatMap((r) => r.attachment_ids));
  const { rows: notes } = priorRows.length
    ? await pool.query<{ id: number; tool_notes: string | null }>('SELECT id, tool_notes FROM chat_messages WHERE id = ANY($1::int[])', [priorRows.map((r) => r.id)])
    : { rows: [] as Array<{ id: number; tool_notes: string | null }> };
  const noteOf = new Map(notes.map((n) => [n.id, n.tool_notes]));
  const turns: ChatTurn[] = priorRows.reverse().map((m) => ({
    role: m.who === 'hana' ? 'assistant' : 'user',
    // Whole messages (a pasted list is up to 2000 characters), and what Hana's tools actually did in her earlier
    // replies — so she knows what she already did instead of second-guessing it.
    content:
      `${m.text.slice(0, 2000)}${m.attachment_ids.length ? ` [attached earlier: ${m.attachment_ids.map((id) => earlierFiles.get(id)?.name ?? 'a file').join(', ')}]` : ''}${
        m.who === 'hana' && noteOf.get(m.id) ? `\n\n[What my tools did in this reply: ${noteOf.get(m.id)}]` : ''
      }`.trim() || '(attachment)',
  }));
  turns.push({ role: 'user', content: withAttachments(msg, await loadAttachments(me.id, attached)) });
  // The API wants the first turn from the user.
  while (turns[0]?.role === 'assistant') turns.shift();

  // Live numbers (never the model's): in the prompt, and checked against the reply below.
  const stats = mode === 'companion' ? await hanaStats(me) : null;
  let system = await systemPrompt(me, mode, await dayContext(me, mode, stats));
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
  if (mode === 'companion') system += libraryInstructions(msg, turns.slice(0, -1).filter((t) => t.role === 'user').map(turnText));
  const actions: HanaAction[] = [];
  const started = Date.now();
  let text: string;
  try {
    text =
      mode === 'companion'
        ? await model.act(system, turns, hanaKit(me, actions), 4000)
        : await model.reply(system, turns, 1000, { effort: 'medium' });
  } catch (e) {
    // Kept, marked: the screen shows it with Retry (and a retry reuses this row).
    await pool.query('UPDATE chat_messages SET failed = true WHERE id = $1', [rowId]);
    console.error(`chat: send ${mode} member=${me.id} model=${model.kind === 'claude' ? process.env.CHAT_MODEL || 'claude-opus-5-5' : 'stub'} ms=${Date.now() - started} error=${e instanceof HttpError ? e.status : 'exception'}`);
    throw e;
  }
  console.log(`chat: send ${mode} member=${me.id} model=${model.kind === 'claude' ? process.env.CHAT_MODEL || 'claude-opus-5-5' : 'stub'} ms=${Date.now() - started} ok actions=${actions.length}`);
  // Personal numbers in the reply must be the real ones (before or after this turn's actions): else fix them before anyone sees it.
  if (stats) {
    const snaps = actions.length ? [stats, await hanaStats(me)] : [stats];
    const bad = wrongStats(text, snaps);
    if (bad.length) {
      console.warn(`chat: corrected unverified stats member=${me.id} ${bad.map((b) => b.kind).join(',')}`);
      const now = snaps[snaps.length - 1] as HanaStats;
      const fixed = await model.reply(REWRITE_SYSTEM(now, stats), [{ role: 'user', content: text }], 700).catch(() => '');
      text = fixed && !wrongStats(fixed, snaps).length ? fixed : stripWrongStats(text, now, snaps);
    }
  }
  await logEvent('hana_asked', { mode, actions: actions.length }, me.id);
  // What the tools did, kept with the reply for later turns (not shown in the chat).
  const toolNotes = actions.length ? actions.map((a) => `${a.summary} → ${a.status}${a.result ? `: ${a.result.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`).join(' | ').slice(0, 4000) : null;
  const { rows } = await pool.query<MsgRow>(
    `INSERT INTO chat_messages (member_id, mode, who, text, tool_notes) VALUES ($1, $2, 'hana', $3, $4) RETURNING ${MSG_COLS}`,
    [me.id, mode, text, toolNotes],
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
