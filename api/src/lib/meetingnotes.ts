/**
 * Meeting transcript → structured notes: a suggested title, a summary, key
 * decisions, action items (with the person's name when one was said, and a due
 * date when one was given) and follow-ups / open questions.
 *
 * Real: Claude with structured output (same pattern as lecture notes).
 * Stub (CHAT_STUB / TRANSCRIPTION_STUB, never in production): simple rules,
 * so the whole flow is testable offline.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { WEEKDAYS, type DateStr, type MeetingNotes } from '@myday/shared';
import { config } from '../config.js';
import { isoWeekday } from './dates.js';
import { HttpError } from './http.js';
import { resolveDue } from './lecturenotes.js';

const NotesSchema = z.object({
  title: z.string(),
  summary: z.string(),
  decisions: z.array(z.string()),
  actionItems: z.array(z.object({ task: z.string(), owner: z.string().nullable(), due: z.string().nullable() })),
  followUps: z.array(z.string()),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Offline proof: sentences that commit someone to something become action items. */
export function stubMeetingNotes(transcript: string, recordedOn: DateStr): MeetingNotes {
  const sentences = transcript.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const actionItems: MeetingNotes['actionItems'] = [];
  const decisions: string[] = [];
  const followUps: string[] = [];
  for (const s of sentences) {
    const owner = s.match(/^([A-Z][a-z]+) (?:will|is going to|needs to|should)\b/)?.[1] ?? null;
    if (owner || /\b(action item|to do|we need to|I will|I'll)\b/i.test(s)) {
      const due = resolveDue(s.match(/\b(by|before|on|due)\s+([A-Za-z]+day|tomorrow|next week)\b/i)?.[2] ?? '', recordedOn);
      actionItems.push({ task: s.replace(/^([A-Z][a-z]+) (will|is going to|needs to|should)\s+/, '').replace(/[.!]$/, ''), owner, due, taskId: null });
    } else if (/\b(we decided|we agreed|decision|let's go with)\b/i.test(s)) decisions.push(s);
    else if (s.endsWith('?') || /\b(open question|follow up|not sure|find out)\b/i.test(s)) followUps.push(s);
  }
  const first = sentences[0] ?? 'Meeting';
  return {
    title: first.replace(/[.!?]$/, '').split(/\s+/).slice(0, 7).join(' '),
    summary: sentences.slice(0, 2).join(' ') || 'A short meeting.',
    decisions,
    actionItems,
    followUps,
  };
}

const system = (recordedOn: DateStr): string =>
  `You turn a meeting transcript into clear notes for the person who recorded it. The meeting was on ${WEEKDAYS[isoWeekday(recordedOn) - 1]} ${recordedOn}. ` +
  'Write: a short, specific title (under 8 words, no date); a 2–3 sentence summary; the decisions that were actually made; ' +
  'every action item as one doable task starting with a verb, with the owner’s first name if one was said (else null) and the due date as YYYY-MM-DD ' +
  'when one was given (resolve "Friday", "next week" relative to the meeting date), else null; and follow-ups / open questions. ' +
  'Never invent decisions, owners or dates that are not in the transcript. If the transcript has no real meeting content, return empty lists and say so in the summary.';

let client: Anthropic | null = null;

export async function meetingNotes(transcript: string, recordedOn: DateStr): Promise<MeetingNotes> {
  const key = process.env.ANTHROPIC_KEY ?? '';
  const stub = (process.env.CHAT_STUB === '1' || process.env.TRANSCRIPTION_STUB === '1') && !config.production;
  if (!key) {
    if (stub) return stubMeetingNotes(transcript, recordedOn);
    throw new HttpError(503, 'Meeting notes need the AI key (ANTHROPIC_KEY) on the server');
  }
  client ??= new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
  try {
    const res = await client.messages.parse({
      model: process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 8000,
      system: system(recordedOn),
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript.slice(0, 120_000)}` }],
      output_config: { effort: 'medium', format: zodOutputFormat(NotesSchema) },
    });
    if (res.stop_reason === 'refusal') throw new HttpError(422, 'Notes could not be made from this recording');
    const out = res.parsed_output;
    if (!out) throw new HttpError(502, 'The notes came back incomplete — try again');
    return {
      title: out.title.slice(0, 120),
      summary: out.summary,
      decisions: out.decisions.slice(0, 20),
      actionItems: out.actionItems.slice(0, 30).map((a) => ({ task: a.task.slice(0, 200), owner: a.owner?.slice(0, 40) || null, due: a.due && DATE.test(a.due) ? a.due : null, taskId: null })),
      followUps: out.followUps.slice(0, 20),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy — try again in a minute');
    if (e instanceof Anthropic.APIError) {
      console.error('meeting notes: API error', e.status, (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? '');
      throw new HttpError(502, 'Could not make notes right now — your recording is kept; try again');
    }
    throw e;
  }
}
