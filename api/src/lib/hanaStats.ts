/**
 * Hana's personal numbers — score, streak, XP, level, task counts — come only
 * from live queries here, never from the model. Every chat turn gets them as a
 * VERIFIED STATS line (zeros included, so there's nothing to "fill in"), the
 * my_stats tool re-reads them mid-conversation, and every reply is checked:
 * a number she states about the person that doesn't match is corrected before
 * the reply is saved or shown.
 */
import type { HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { dailyScore, trackOf } from './adult.js';
import { today } from './dates.js';
import { activeDates, computeStreak } from './streak.js';
import { xpStatus } from './xp.js';

export interface HanaStats {
  score: number;
  scoreParts: Array<{ label: string; points: number }>;
  streak: number;
  longestStreak: number;
  xp: number;
  level: number;
  levelTitle: string;
  nextLevelAt: number | null;
  tasksDone: number;
  tasksOpen: number;
}

export async function hanaStats(me: HouseholdMember): Promise<HanaStats> {
  const t = today();
  const track = await trackOf(me.id);
  const score = await dailyScore(me.id, track, t);
  const streak = computeStreak(await activeDates(me.id), t);
  const xp = await xpStatus(me.id);
  const { rows } = await pool.query<{ done: number; open: number }>(
    'SELECT COUNT(*) FILTER (WHERE done)::int AS done, COUNT(*) FILTER (WHERE NOT done)::int AS open FROM tasks WHERE member_id = $1 AND day = $2',
    [me.id, t],
  );
  return {
    score: score.total,
    scoreParts: score.labels.map((label, i) => ({ label, points: score.parts[i] ?? 0 })),
    streak: streak.current,
    longestStreak: streak.longest,
    xp: xp.total,
    level: xp.level,
    levelTitle: xp.title,
    nextLevelAt: xp.next?.at ?? null,
    tasksDone: rows[0]?.done ?? 0,
    tasksOpen: rows[0]?.open ?? 0,
  };
}

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`;

/** The numbers, plainly (also what the person sees if a reply has to be corrected). */
export function statsSummary(s: HanaStats): string {
  return (
    `today’s score ${s.score}/100, current streak ${days(s.streak)} (longest ${days(s.longestStreak)}), ` +
    `${s.xp} XP — level ${s.level} “${s.levelTitle}”${s.nextLevelAt !== null ? ` (next level at ${s.nextLevelAt} XP)` : ''}, ` +
    `tasks today: ${s.tasksDone} done, ${s.tasksOpen} open`
  );
}

/** For the system prompt and the my_stats tool. */
export function statsLine(s: HanaStats): string {
  const parts = s.scoreParts.filter((p) => p.points > 0).map((p) => `${p.label} ${p.points}`).join(', ');
  return `VERIFIED STATS (live from MyDay, just now): ${statsSummary(s)}${parts ? `; today’s score is made of: ${parts}` : ''}`;
}

export const STATS_RULE =
  'PERSONAL NUMBERS: the only personal numbers you may state — score, streak, XP, level, points, counts — are the ones in VERIFIED STATS ' +
  'or returned by a tool in this conversation. Never estimate, guess, round, or reuse a number from earlier in the chat (it may have ' +
  'changed: call my_stats). If a number isn’t there, say plainly that you don’t have it and where in MyDay they can see it. ' +
  'If you said a wrong number earlier, correct it plainly.';

export type StatKind = 'score' | 'streak' | 'xp' | 'level';
export interface StatClaim {
  kind: StatKind;
  said: number;
}

// Claims about the person's own numbers ("your score is 60", "you're on a 2-day streak", "you have 450 XP", "you're level 3").
const CLAIMS: Array<[StatKind, RegExp]> = [
  ['score', /\byour\s+(?:daily\s+|today['’]s\s+|current\s+)?score\s+(?:is|is at|was|stands at|sits at|of|=|:)\s*(\d{1,3})\b/gi],
  ['score', /\byour\s+score\b[^.!?\n\d]{0,20}(\d{1,3})\s*(?:\/|out of)\s*100\b/gi],
  ['score', /\byou(?:['’]ve|\s+have)?\s+scored\s+(?:an?\s+)?(\d{1,3})\b/gi],
  ['score', /\byou(?:['’]re|\s+are)\s+at\s+(\d{1,3})\s*(?:\/|out of)\s*100\b/gi],
  ['streak', /\byour\s+(?:current\s+)?streak\s+(?:is|is at|stands at|sits at|of|=|:)\s*(?:an?\s+)?(\d{1,4})\b/gi],
  ['streak', /\byou(?:['’]re|\s+are)\s+on\s+an?\s+(\d{1,4})[- ]day\s+streak\b/gi],
  ['streak', /\byou(?:['’]ve|\s+have)(?:\s+got)?\s+an?\s+(\d{1,4})[- ]day\s+streak\b/gi],
  ['streak', /\byour\s+(\d{1,4})[- ]day\s+streak\b/gi],
  ['xp', /\byou(?:['’]ve|\s+have)(?:\s+got|\s+earned)?\s+(\d[\d,]*)\s*XP\b/gi],
  ['xp', /\byour\s+(?:total\s+)?XP\s+(?:is|is at|stands at|of|=|:)\s*(\d[\d,]*)/gi],
  ['xp', /\byou(?:['’]re|\s+are)\s+at\s+(\d[\d,]*)\s*XP\b/gi],
  ['level', /\byou(?:['’]re|\s+are)\s+(?:at\s+|on\s+)?level\s+(\d{1,2})\b/gi],
  ['level', /\byour\s+level\s+(?:is\s+)?(\d{1,2})\b/gi],
];

function allowed(kind: StatKind, s: HanaStats): Set<number> {
  if (kind === 'score') return new Set([s.score, ...s.scoreParts.map((p) => p.points)]);
  if (kind === 'streak') return new Set([s.streak, s.longestStreak]);
  if (kind === 'xp') return new Set([s.xp, ...(s.nextLevelAt !== null ? [s.nextLevelAt, s.nextLevelAt - s.xp] : [])]);
  return new Set([s.level]);
}

/**
 * Numbers the text states about the person that don't match the live values.
 * Several snapshots (before and after this turn's actions) are all accepted.
 */
export function wrongStats(text: string, s: HanaStats | HanaStats[]): StatClaim[] {
  const snaps = Array.isArray(s) ? s : [s];
  const out: StatClaim[] = [];
  for (const [kind, re] of CLAIMS) {
    for (const m of text.matchAll(re)) {
      const said = Number((m[1] ?? '').replace(/,/g, ''));
      if (Number.isFinite(said) && !snaps.some((x) => allowed(kind, x).has(said))) out.push({ kind, said });
    }
  }
  return out;
}

/** Last resort: drop the sentences with a wrong number and state the real ones. */
export function stripWrongStats(text: string, s: HanaStats, ok: HanaStats[] = [s]): string {
  const lines = text.split('\n').map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => wrongStats(sentence, ok).length === 0)
      .join(' '),
  );
  const kept = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${kept ? `${kept}\n\n` : ''}Your numbers right now: ${statsSummary(s)}.`;
}

export const REWRITE_SYSTEM = (s: HanaStats): string =>
  'You correct one message written by Hana, an assistant in the MyDay app. It stated personal numbers that are wrong. ' +
  `The person's real numbers: ${statsSummary(s)}. Rewrite the message so every personal number matches these exactly ` +
  '(or remove the claim). Change nothing else: same voice, same length, same formatting. Output only the corrected message.';
