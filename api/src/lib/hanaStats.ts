/**
 * What Hana states as fact about the person and their household comes only from
 * live queries here, never from the model: personal numbers (score, streak, XP,
 * level, task counts) AND the household itself (who is in it, how many people,
 * how many chores each person has). Every chat turn gets them as a VERIFIED
 * STATS line (zeros included, so there's nothing to "fill in"), the my_stats
 * tool re-reads them mid-conversation, and every reply is checked: a number,
 * a member count, a chore count, or a "X isn't in your household" that doesn't
 * match is corrected before the reply is saved or shown.
 */
import type { HouseholdMember } from '@myday/shared';
import { pool } from '../db.js';
import { dailyScore, trackOf } from './adult.js';
import { today } from './dates.js';
import { listMembers } from './members.js';
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
  /** Who you're talking to. */
  me: string;
  /** The whole household (from the roster — complete). */
  members: Array<{ name: string; kind: 'adult' | 'kid'; age: number | null }>;
  /** Active chores on the chart: in total and per person (everyone listed, zeros included). */
  chores: { total: number; byMember: Record<string, number> };
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
  const roster = await listMembers();
  const { rows: ch } = await pool.query<{ member_id: number; n: number }>('SELECT member_id, COUNT(*)::int AS n FROM chores WHERE active GROUP BY member_id');
  const byMember: Record<string, number> = {};
  for (const m of roster) byMember[m.name] = ch.find((c) => c.member_id === m.id)?.n ?? 0;
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
    me: me.name,
    members: roster.map((m) => ({ name: m.name, kind: m.kind === 'kid' ? 'kid' : 'adult', age: m.age })),
    chores: { total: Object.values(byMember).reduce((a, b) => a + b, 0), byMember },
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

/** The household, plainly: every member and the chore counts. */
export function householdSummary(s: HanaStats): string {
  const people = s.members.map((m) => `${m.name} (${m.kind === 'kid' ? `kid${m.age !== null ? `, ${m.age}` : ''}` : 'grown-up'}${m.name === s.me ? ', you' : ''})`);
  const per = s.members.map((m) => `${m.name} ${s.chores.byMember[m.name] ?? 0}`).join(', ');
  return `${s.members.length} ${s.members.length === 1 ? 'person' : 'people'} in the household: ${people.join(', ')}. Chores on the chart: ${s.chores.total} (${per})`;
}

/** For the system prompt and the my_stats tool. */
export function statsLine(s: HanaStats): string {
  const parts = s.scoreParts.filter((p) => p.points > 0).map((p) => `${p.label} ${p.points}`).join(', ');
  return (
    `VERIFIED STATS (live from MyDay, just now): ${statsSummary(s)}${parts ? `; today’s score is made of: ${parts}` : ''}. ` +
    `HOUSEHOLD (complete roster, live): ${householdSummary(s)}`
  );
}

export const STATS_RULE =
  'PERSONAL NUMBERS: the only personal numbers you may state — score, streak, XP, level, points, counts — are the ones in VERIFIED STATS ' +
  'or returned by a tool in this conversation. Never estimate, guess, round, or reuse a number from earlier in the chat (it may have ' +
  'changed: call my_stats). If a number isn’t there, say plainly that you don’t have it and where in MyDay they can see it. ' +
  'If you said a wrong number earlier, correct it plainly. HOUSEHOLD FACTS: the HOUSEHOLD roster above is complete and current — ' +
  'everyone listed IS in the household, and no one else is. Never invent or guess people, membership, or counts of people or chores; ' +
  'never say someone isn’t in the household if they’re listed. Chores can be given to anyone listed, kids or grown-ups. When you add ' +
  'chores, say how many were actually added from the tool result. If you can’t see something, say so and ask — never fill the blank.';

export type StatKind = 'score' | 'streak' | 'xp' | 'level' | 'notMember' | 'members' | 'kids' | 'chores' | 'choresOf' | 'choresAdded';
export interface StatClaim {
  kind: StatKind;
  said: number | string;
}

const WORDS: Record<string, number> = { no: 0, zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = '(\\d[\\d,]*|no|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const num = (s: string): number => (s.toLowerCase() in WORDS ? (WORDS[s.toLowerCase()] as number) : Number(s.replace(/,/g, '')));
const re = (src: string): RegExp => new RegExp(src, 'gi');

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
  // Household: how many people / kids.
  ['members', re(`\\b${NUM}\\s+(?:people|members|family members|of you)\\s+(?:in|on)\\s+(?:your|the|this)\\s+(?:household|family)\\b`)],
  ['members', re(`\\b(?:your|the)\\s+household\\s+(?:has|is)\\s+${NUM}\\s+(?:people|members|strong)\\b`)],
  ['kids', re(`\\byou(?:['’]ve|\\s+have)\\s+${NUM}\\s+(?:kids|children)\\b`)],
  ['kids', re(`\\b${NUM}\\s+(?:kids|children)\\s+in\\s+(?:your|the|this)\\s+(?:household|family)\\b`)],
  // Chores: the chart, and what was added this turn.
  ['chores', re(`\\b(?:you\\s+have|there\\s+are|there['’]s|the\\s+chart\\s+has|your\\s+household\\s+has)\\s+${NUM}\\s+(?:active\\s+)?chores?\\b`)],
  ['chores', re(`\\b${NUM}\\s+chores?\\s+(?:in\\s+total|total|altogether|on\\s+the\\s+chart)\\b`)],
  ['choresAdded', re(`\\b(?:added|created|set\\s+up|put\\s+in|assigned)\\s+(?:all\\s+)?${NUM}\\s+(?:new\\s+)?chores?\\b`)],
];

// "Avery has 5 chores"
const CHORES_OF = re(`\\b([A-Z][a-z]+)\\s+(?:now\\s+)?has\\s+${NUM}\\s+(?:active\\s+)?chores?\\b`);
// "Kayla isn't in your household", "there's no Kayla in your household", "no one named Kayla", "I don't see Kayla in your household"
const NOT_MEMBER: RegExp[] = [
  /\b([A-Z][a-z]+)\s+(?:isn['’]t|is\s+not|wasn['’]t|is\s+no\s+longer)\s+(?:in|part\s+of|a\s+member\s+of|on|listed\s+in)\s+(?:your|the|this)\s+(?:household|family|roster)/g,
  /\b(?:[Tt]here['’]s|[Tt]here\s+is)\s+no\s+([A-Z][a-z]+)\s+in\s+(?:your|the|this)\s+(?:household|family|roster)/g,
  /\b(?:[Nn]o\s+one|[Nn]obody|[Nn]o\s+household\s+member|[Nn]o\s+kid|[Nn]o\s+member|[Nn]o\s+child)\s+(?:named|called)\s+([A-Z][a-z]+)/g,
  /\bI\s+(?:don['’]t|do\s+not|can['’]t|cannot)\s+(?:see|find)\s+(?:anyone\s+named\s+|someone\s+named\s+|a\s+)?([A-Z][a-z]+)\s+(?:in|on)\s+(?:your|the|this)\s+(?:household|family|roster)/g,
];

function allowed(kind: StatKind, s: HanaStats): Set<number> {
  if (kind === 'score') return new Set([s.score, ...s.scoreParts.map((p) => p.points)]);
  if (kind === 'streak') return new Set([s.streak, s.longestStreak]);
  if (kind === 'xp') return new Set([s.xp, ...(s.nextLevelAt !== null ? [s.nextLevelAt, s.nextLevelAt - s.xp] : [])]);
  if (kind === 'members') return new Set([s.members.length]);
  if (kind === 'kids') return new Set([s.members.filter((m) => m.kind === 'kid').length]);
  // "you have N chores": the household's total, or the person's own.
  if (kind === 'chores') return new Set([s.chores.total, s.chores.byMember[s.me] ?? 0]);
  return new Set([s.level]);
}

/**
 * Facts the text states that don't match the live values. Several snapshots
 * (before and after this turn's actions) are all accepted; "added N chores"
 * must match what this turn actually added (first snapshot → last).
 */
export function wrongStats(text: string, s: HanaStats | HanaStats[]): StatClaim[] {
  const snaps = Array.isArray(s) ? s : [s];
  const first = snaps[0] as HanaStats;
  const last = snaps[snaps.length - 1] as HanaStats;
  const out: StatClaim[] = [];
  for (const [kind, rx] of CLAIMS) {
    for (const m of text.matchAll(rx)) {
      const said = num(m[1] ?? '');
      if (!Number.isFinite(said)) continue;
      if (kind === 'choresAdded') {
        if (said !== last.chores.total - first.chores.total) out.push({ kind, said });
      } else if (!snaps.some((x) => allowed(kind, x).has(said))) out.push({ kind, said });
    }
  }
  const names = new Map(last.members.map((m) => [m.name.toLowerCase(), m.name]));
  for (const m of text.matchAll(CHORES_OF)) {
    const who = names.get((m[1] ?? '').toLowerCase());
    const said = num(m[2] ?? '');
    if (who && Number.isFinite(said) && !snaps.some((x) => (x.chores.byMember[who] ?? 0) === said)) out.push({ kind: 'choresOf', said: `${who} ${said}` });
  }
  for (const rx of NOT_MEMBER) {
    for (const m of text.matchAll(rx)) {
      const who = names.get((m[1] ?? '').toLowerCase());
      if (who) out.push({ kind: 'notMember', said: who });
    }
  }
  return out;
}

const HOUSEHOLD_KINDS = new Set<StatKind>(['notMember', 'members', 'kids', 'chores', 'choresOf', 'choresAdded']);

/** Last resort: drop the sentences with a wrong fact and state the real ones. */
export function stripWrongStats(text: string, s: HanaStats, ok: HanaStats[] = [s]): string {
  const bad = wrongStats(text, ok);
  const lines = text.split('\n').map((line) =>
    line
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => wrongStats(sentence, ok).length === 0)
      .join(' '),
  );
  const kept = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const facts: string[] = [];
  if (bad.some((b) => !HOUSEHOLD_KINDS.has(b.kind))) facts.push(`Your numbers right now: ${statsSummary(s)}.`);
  if (bad.some((b) => HOUSEHOLD_KINDS.has(b.kind))) {
    const added = s.chores.total - (ok[0] as HanaStats).chores.total;
    facts.push(`${added > 0 ? `Added ${added} chore${added === 1 ? '' : 's'} just now. ` : ''}${householdSummary(s)}.`);
  }
  return `${kept ? `${kept}\n\n` : ''}${facts.join('\n\n')}`;
}

export const REWRITE_SYSTEM = (s: HanaStats, before?: HanaStats): string =>
  'You correct one message written by Hana, an assistant in the MyDay app. It stated facts that are wrong (personal numbers, or facts ' +
  `about the household). The real facts: ${statsSummary(s)}. ${householdSummary(s)}.` +
  (before ? ` Chores added this turn: ${s.chores.total - before.chores.total}.` : '') +
  ' Rewrite the message so every fact matches these exactly (or remove the claim). Change nothing else: same voice, same length, ' +
  'same formatting. Output only the corrected message.';
