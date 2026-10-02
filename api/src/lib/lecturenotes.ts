/**
 * Transcript → structured study notes that MODEL good note-taking: a short
 * summary, a few headed sections of tight bullet points, key points, terms
 * with definitions, flashcards, and any assignments the teacher mentioned
 * (with real due dates). Never a transcript dump.
 *
 * Real: Claude via the Anthropic SDK with structured output (Zod schema).
 * Stub: a deterministic local structurer (CHAT_STUB=1 or TRANSCRIPTION_STUB=1,
 * never in production) so the pipeline can be proven without keys.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { WEEKDAYS, type DateStr, type LectureNotes } from '@myday/shared';
import { config } from '../config.js';
import { addDays, isoWeekday } from './dates.js';
import { HttpError } from './http.js';

const NotesSchema = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(z.object({ heading: z.string(), points: z.array(z.string()) })),
  keyPoints: z.array(z.string()),
  terms: z.array(z.object({ term: z.string(), definition: z.string() })),
  assignments: z.array(z.object({ title: z.string(), due: z.string().nullable() })),
  flashcards: z.array(z.object({ front: z.string(), back: z.string(), explanation: z.string() })),
});

export type StructuredLecture = LectureNotes & {
  assignments: Array<{ title: string; due: DateStr | null }>;
  flashcards: Array<{ front: string; back: string; explanation: string }>;
};

export interface LectureContext {
  className: string;
  recordedOn: DateStr;
  /** Student age if known (sets the reading level). */
  age: number | null;
}

const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** "Friday" / "next Tuesday" / "tomorrow" → the next such date after the lecture. */
export function resolveDue(phrase: string, recordedOn: DateStr): DateStr | null {
  const p = phrase.toLowerCase();
  if (/\btomorrow\b/.test(p)) return addDays(recordedOn, 1);
  const iso = p.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso?.[1]) return iso[1];
  const idx = DAY_NAMES.findIndex((d) => p.includes(d));
  if (idx < 0) return null;
  const target = idx + 1; // ISO weekday
  // The coming such day (never the same day). "next Tuesday" is read the same way.
  const ahead = (target - isoWeekday(recordedOn) + 7) % 7 || 7;
  return addDays(recordedOn, ahead);
}

/** Deterministic local structurer (stub mode). */
export function stubStructure(transcript: string, ctx: LectureContext): StructuredLecture {
  const sentences = transcript
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const terms: Array<{ term: string; definition: string }> = [];
  for (const s of sentences) {
    const m = s.match(/^([A-Z][A-Za-z-]+(?: [a-z-]+){0,2}) is (?:the |a |an )?(.+?)\.?$/);
    if (m?.[1] && m[2] && !/^(It|This|That|There|Today|Remember)$/.test(m[1])) {
      terms.push({ term: m[1], definition: m[2].replace(/\.$/, '') });
    }
  }
  const topic = transcript.match(/unit on ([a-z ]+?)[.,]/i)?.[1] ?? terms[0]?.term ?? ctx.className;
  const isTask = (s: string): boolean => /\b(homework|assignment|worksheet|project|essay|read pages?)\b/i.test(s);
  const content = sentences.filter((s) => !isTask(s));
  const sections: LectureNotes['sections'] = [];
  for (let i = 0; i < content.length; i += 3) {
    const chunk = content.slice(i, i + 3);
    const head = terms.find((t) => chunk.some((c) => c.startsWith(t.term)))?.term;
    sections.push({ heading: head ? `${head}` : `Part ${sections.length + 1}`, points: chunk.map((c) => c.replace(/\.$/, '')) });
  }
  const assignments: StructuredLecture['assignments'] = [];
  for (const s of sentences.filter(isTask)) {
    for (const clause of s.replace(/\.$/, '').split(/\.\s+|;\s*/)) {
      if (!isTask(clause)) continue;
      const dueM = clause.match(/\b(?:due|before|by)\b(.*)$/i);
      const title = clause
        .replace(/^(for homework|also|and)\s*,?\s*/i, '')
        .replace(/,?\s*\b(due|before|by)\b.*$/i, '')
        .trim();
      if (title) assignments.push({ title: title.charAt(0).toUpperCase() + title.slice(1), due: dueM?.[1] ? resolveDue(dueM[1], ctx.recordedOn) : null });
    }
  }
  const keyPoints = sections.map((s) => s.points[0] ?? '').filter(Boolean).slice(0, 5);
  return {
    title: `${ctx.className}: ${topic.charAt(0).toUpperCase() + topic.slice(1)}`,
    summary: content.slice(0, 2).join(' '),
    sections,
    keyPoints,
    terms,
    assignments,
    flashcards: terms.map((t) => ({
      front: `What is ${t.term.toLowerCase()}?`,
      back: t.definition.charAt(0).toUpperCase() + t.definition.slice(1),
      explanation: `In plain words: ${t.term} is ${t.definition.split(',')[0]}.`,
    })),
  };
}

function system(ctx: LectureContext): string {
  const day = WEEKDAYS[isoWeekday(ctx.recordedOn) - 1];
  const level = ctx.age ? `a ${ctx.age}-year-old student` : 'a student';
  return (
    `You turn a classroom lecture transcript into study notes for ${level} in "${ctx.className}". ` +
    'Model excellent note-taking — the notes are also teaching the student HOW to take notes: ' +
    'a 2–3 sentence summary; 2–6 sections with clear headings and short, organized bullet points in the student’s reading level ' +
    '(never copy the transcript; rewrite, group and compress); 3–6 key points; the important terms with one-line definitions; ' +
    '6–12 flashcards (question on the front, answer on the back, plus a simple one-sentence explanation). ' +
    `The lecture was recorded on ${day} ${ctx.recordedOn}. List every assignment, reading or test the teacher mentioned, ` +
    'with its due date as YYYY-MM-DD when one was given (resolve words like "Friday" relative to the recording date), else null. ' +
    'If something is unclear in the transcript, leave it out rather than guess.'
  );
}

let client: Anthropic | null = null;

export async function structureLecture(transcript: string, ctx: LectureContext): Promise<StructuredLecture> {
  const key = process.env.ANTHROPIC_KEY ?? '';
  const stub = (process.env.CHAT_STUB === '1' || process.env.TRANSCRIPTION_STUB === '1') && !config.production;
  if (!key) {
    if (stub) return stubStructure(transcript, ctx);
    throw new HttpError(503, 'Study notes need the AI key (ANTHROPIC_KEY) on the server');
  }
  client ??= new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
  try {
    const res = await client.messages.parse({
      model: process.env.CHAT_MODEL || 'claude-opus-5-5',
      max_tokens: 16000,
      system: system(ctx),
      messages: [{ role: 'user', content: `Transcript:\n\n${transcript.slice(0, 120_000)}` }],
      output_config: { effort: 'medium', format: zodOutputFormat(NotesSchema) },
    });
    if (res.stop_reason === 'refusal') throw new HttpError(422, 'Notes could not be made from this recording');
    const out = res.parsed_output;
    if (!out) throw new HttpError(502, 'The notes came back incomplete — try again');
    return {
      ...out,
      assignments: out.assignments.map((a) => ({ title: a.title, due: a.due && /^\d{4}-\d{2}-\d{2}$/.test(a.due) ? a.due : null })),
    };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, 'The AI is busy — notes will retry');
    if (e instanceof Anthropic.APIError) {
      console.error('notes: API error', e.status);
      throw new HttpError(502, 'Could not make notes right now');
    }
    throw e;
  }
}
