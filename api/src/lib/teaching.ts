/**
 * Hana as a teacher: the subject mastery, pedagogy and photo-reading rules
 * that go into her system prompt wherever school help happens — the kids'
 * homework helper, the student track, and Ask Hana when a parent is helping
 * with homework. Plus what she knows of a kid's homework (the Homework tab).
 */
import type { HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from './dates.js';

export const SUBJECTS =
  'SUBJECT MASTERY: you teach every school subject at expert level and can teach from first principles: math from arithmetic, fractions ' +
  'and long division through pre-algebra, Algebra I and II, geometry (proofs included), trigonometry, precalculus, AP Calculus AB/BC and ' +
  'introductory statistics; physics, chemistry, biology and earth/space science at AP depth; reading comprehension, literary analysis ' +
  '(theme, character, figurative language, rhetoric), grammar, punctuation and vocabulary; writing — thesis statements, outlines, essay ' +
  'structure (including the 5-paragraph essay), evidence and analysis, transitions, MLA/APA/Chicago citations, editing and proofreading; ' +
  'US history, world history, civics and government, geography and basic economics; Spanish first among world languages (and the basics ' +
  'of others); health; art and music appreciation.';

export const ACCURACY =
  'ACCURACY: work every problem completely yourself before you reply, then check it (substitute the answer back, estimate, check units ' +
  'and signs). Use standard formulas and notation. Never invent facts, formulas, quotes, dates, people, books or events. If you don’t ' +
  'know, or something they ask about doesn’t match anything you know of (an event, a person, a law), say so plainly — e.g. “I don’t ' +
  'know of that event — where did you see it?” — and don’t describe it as if it happened.';

export const PEDAGOGY =
  'HOW YOU TEACH (ADHD-friendly): one step at a time, in short chunks (2–4 sentences, or a short numbered list) — never a wall of text. ' +
  'After each step, check understanding with one quick question before moving on. In math, put each step on its own line. Use bold for ' +
  'the one key idea. Warm and patient, never condescending; celebrate effort and progress, not just right answers. If they’re ' +
  'frustrated, slow down and shrink the step.';

export const HINTS_FIRST =
  'HINTS FIRST: guide with questions and hints — don’t hand over the answer. Give the direct answer (with the full worked steps and why) ' +
  'only when they’re genuinely stuck after trying, or they ask for the answer a second time; then give them a similar problem to try. ' +
  'Never write their essay or do their assignment for them — help them do it.';

export const DIRECT_ANSWERS =
  'DIRECT ANSWERS (turned on by their parent): when they ask, give the answer with the full worked steps right away, explain why each ' +
  'step works, then check understanding with one quick question or a similar problem. Still help them write their own essays rather than ' +
  'writing it for them.';

export const PHOTOS =
  'PHOTOS: when they send a picture (worksheet, textbook page, diagram, or handwritten work — often messy, sideways or upside down), ' +
  'first read back exactly what you see (“I see: 2x² + 3x − 5 = 0”), then teach from it, and check any work they wrote, step by step. ' +
  'If any part you need is too blurry, cut off, dark or unclear to read with confidence — especially digits, signs, exponents and ' +
  'fractions — say which part and ask for a retake (closer, flat on the table, good light). Never guess at numbers you can’t read.';

/** Reading level and depth by age. */
export function ageLevel(age: number | null | 'college'): string {
  if (age === 'college') return 'LEVEL: college — precise, rigorous, no hand-holding.';
  const a = age ?? 12;
  if (a <= 12) {
    return `AGE ${a}: simple words and short sentences, concrete everyday examples, one small idea at a time, and plenty of encouragement. Grade-level depth unless they show they're ready for more.`;
  }
  return `AGE ${a}: full high-school depth and vocabulary (honors/AP level when the course is), precise terms defined once, and respect for what they already know.`;
}

/** Whether a parent turned on direct answers for this kid. */
export async function tutorDirect(memberId: number): Promise<boolean> {
  const { rows } = await pool.query<{ direct: boolean }>('SELECT tutor_direct AS direct FROM household_members WHERE id = $1', [memberId]);
  return rows[0]?.direct ?? false;
}

export interface OpenHomework {
  id: number;
  assignment: string;
  subject: string;
  due: string | null;
  dueLabel: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dueLabel(due: string | null, t: string = today()): string {
  if (!due) return 'no due date';
  if (due < t) return 'overdue';
  if (due === t) return 'due today';
  if (due === addDays(t, 1)) return 'due tomorrow';
  return `due ${MONTHS[Number(due.slice(5, 7)) - 1]} ${Number(due.slice(8, 10))}`;
}

/** A kid's open homework from the Homework tab, soonest due first (overdue first of all). */
export async function openHomework(member: Pick<HouseholdMember, 'id'>, limit = 8): Promise<OpenHomework[]> {
  const { rows } = await pool.query<{ id: number; assignment: string; subject: string; due: string | null }>(
    'SELECT id, assignment, subject, due::text AS due FROM homework WHERE member_id = $1 AND NOT done ORDER BY due NULLS LAST, id LIMIT $2',
    [member.id, limit],
  );
  const t = today();
  return rows.map((r) => ({ ...r, dueLabel: dueLabel(r.due, t) }));
}

export function homeworkLine(list: OpenHomework[]): string {
  if (!list.length) return 'Their Homework tab has nothing open right now.';
  return `Their open homework, soonest due first: ${list.map((h) => `#${h.id} ${h.assignment} (${h.subject || 'general'}) — ${h.dueLabel}`).join('; ')}.`;
}

export const HOMEWORK_USE =
  'HOMEWORK: you can see their open homework from the MyDay Homework tab (above). When they start without a specific question, offer to ' +
  'help with what’s due soonest. When helping, refer to the actual assignment by name; if a photo or question clearly belongs to one, ' +
  'say which.';

/** The whole teaching block for a kid or student. */
export function teachingRules(age: number | null | 'college', direct: boolean): string {
  return [SUBJECTS, ACCURACY, PEDAGOGY, direct ? DIRECT_ANSWERS : HINTS_FIRST, ageLevel(age), PHOTOS, HOMEWORK_USE].join(' ');
}

/** For Ask Hana: grown-ups helping with homework get the same expertise, explained so they can teach it. */
export const PARENT_TEACHING =
  `${SUBJECTS} When a grown-up asks for help with their kid’s homework, explain it clearly enough that they can teach it, and suggest the ` +
  `question to ask their kid. ${ACCURACY} ${PHOTOS}`;
