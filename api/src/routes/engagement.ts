/**
 * Engagement: rotating weekly quests for kids (game feel), one shared family
 * challenge a week, a celebration-only win feed (only things that went
 * right — no misses, no rankings), the Sunday ritual, a teen's private notes,
 * themes, and the age-specific first run.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import type { DateStr, EngagementResponse, FamilyChallenge, HouseholdMember, PrivateNote, Quest, WinItem } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, isoWeekday, today, weekStart } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { listMembers, self } from '../lib/members.js';
import { TEEN_AGE } from './kidmoney.js';

export const engagementRouter = Router();

interface QuestDef {
  code: string;
  title: string;
  goal: number;
  reward: number;
  /** Progress this week (week = [ws, ws+6]). */
  progress: (memberId: number, ws: DateStr) => Promise<number>;
}

async function n(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

const end = (ws: DateStr): DateStr => addDays(ws, 6);

/** The quest pool. Three rotate in each week, different per kid. */
export const QUESTS: QuestDef[] = [
  { code: 'chores5', title: 'Knock out 5 chores', goal: 5, reward: 15,
    progress: (m, ws) => n('SELECT COUNT(*)::int AS n FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id WHERE c.member_id = $1 AND cc.completed_on BETWEEN $2 AND $3', [m, ws, end(ws)]) },
  { code: 'choredays4', title: 'Do a chore on 4 different days', goal: 4, reward: 20,
    progress: (m, ws) => n('SELECT COUNT(DISTINCT cc.completed_on)::int AS n FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id WHERE c.member_id = $1 AND cc.completed_on BETWEEN $2 AND $3', [m, ws, end(ws)]) },
  { code: 'homework3', title: 'Finish 3 homework assignments', goal: 3, reward: 15,
    progress: (m, ws) => n('SELECT COUNT(*)::int AS n FROM homework WHERE member_id = $1 AND done AND done_on BETWEEN $2 AND $3', [m, ws, end(ws)]) },
  { code: 'early2', title: 'Finish 2 homework before the due day', goal: 2, reward: 20,
    progress: (m, ws) => n('SELECT COUNT(*)::int AS n FROM homework WHERE member_id = $1 AND done AND done_on BETWEEN $2 AND $3 AND due IS NOT NULL AND done_on < due', [m, ws, end(ws)]) },
  { code: 'focus3', title: 'Finish 3 focus timers', goal: 3, reward: 15,
    progress: (m, ws) => n("SELECT COUNT(*)::int AS n FROM events WHERE member_id = $1 AND name = 'focus_done' AND at::date BETWEEN $2 AND $3", [m, ws, end(ws)]) },
  { code: 'cards20', title: 'Answer 20 flashcards', goal: 20, reward: 15,
    progress: (m, ws) => n('SELECT COUNT(*)::int AS n FROM quiz_attempts WHERE member_id = $1 AND at::date BETWEEN $2 AND $3', [m, ws, end(ws)]) },
  { code: 'water5', title: 'Drink your water 5 days', goal: 5, reward: 10,
    progress: (m, ws) => n("SELECT COUNT(*)::int AS n FROM health_habits WHERE member_id = $1 AND habit = 'water' AND day BETWEEN $2 AND $3", [m, ws, end(ws)]) },
  { code: 'save1', title: 'Put money toward a savings goal', goal: 1, reward: 10,
    progress: (m, ws) => n("SELECT COUNT(*)::int AS n FROM kid_ledger WHERE member_id = $1 AND kind = 'to_goal' AND day BETWEEN $2 AND $3", [m, ws, end(ws)]) },
];

/** Deterministic rotation: three quests per kid per week. */
export function questCodesFor(memberId: number, ws: DateStr): string[] {
  const ranked = QUESTS.map((q) => ({ code: q.code, h: createHash('sha256').update(`${ws}:${memberId}:${q.code}`).digest().readUInt32BE(0) }));
  ranked.sort((a, b) => a.h - b.h);
  return ranked.slice(0, 3).map((r) => r.code);
}

async function questsFor(member: HouseholdMember, t: DateStr): Promise<Quest[]> {
  if (member.kind !== 'kid') return [];
  const ws = weekStart(t);
  for (const code of questCodesFor(member.id, ws)) {
    const d = QUESTS.find((q) => q.code === code);
    if (!d) continue;
    await pool.query(
      'INSERT INTO quests (member_id, week_start, code, title, goal, reward) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [member.id, ws, d.code, d.title, d.goal, d.reward],
    );
  }
  const { rows } = await pool.query<{ id: number; code: string; title: string; goal: number; reward: number; claimed: boolean }>(
    'SELECT id, code, title, goal, reward, claimed FROM quests WHERE member_id = $1 AND week_start = $2 ORDER BY id',
    [member.id, ws],
  );
  const out: Quest[] = [];
  for (const r of rows) {
    const d = QUESTS.find((q) => q.code === r.code);
    const p = d ? Math.min(r.goal, await d.progress(member.id, ws)) : 0;
    out.push({ id: r.id, code: r.code, title: r.title, progress: p, goal: r.goal, reward: r.reward, claimed: r.claimed, done: p >= r.goal });
  }
  return out;
}

const CHALLENGES: Array<{ code: string; title: (goal: number) => string; per: number; count: (ws: DateStr) => Promise<Array<{ member_id: number; n: number }>> }> = [
  { code: 'chores', per: 6, title: (g) => `Family goal: ${g} chores done together`,
    count: async (ws) => (await pool.query<{ member_id: number; n: number }>('SELECT c.member_id, COUNT(*)::int AS n FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id WHERE cc.completed_on BETWEEN $1 AND $2 GROUP BY c.member_id', [ws, end(ws)])).rows },
  { code: 'moves', per: 3, title: (g) => `Family goal: ${g} workouts or active sessions`,
    count: async (ws) => (await pool.query<{ member_id: number; n: number }>("SELECT member_id, COUNT(DISTINCT logged_on)::int AS n FROM workout_logs WHERE kind IN ('day_complete', 'session') AND logged_on BETWEEN $1 AND $2 GROUP BY member_id", [ws, end(ws)])).rows },
  { code: 'homework', per: 4, title: (g) => `Family goal: ${g} homework + tasks finished`,
    count: async (ws) => (await pool.query<{ member_id: number; n: number }>(
      `SELECT member_id, SUM(n)::int AS n FROM (
         SELECT member_id, COUNT(*) AS n FROM homework WHERE done AND done_on BETWEEN $1 AND $2 GROUP BY member_id
         UNION ALL SELECT member_id, COUNT(*) FROM tasks WHERE done AND done_on BETWEEN $1 AND $2 GROUP BY member_id) x GROUP BY member_id`, [ws, end(ws)])).rows },
];

async function challengeFor(t: DateStr, members: HouseholdMember[]): Promise<FamilyChallenge | null> {
  if (members.length < 2) return null;
  const ws = weekStart(t);
  const weekNo = Math.floor(Date.parse(`${ws}T00:00:00Z`) / (7 * 86400000));
  const def = CHALLENGES[weekNo % CHALLENGES.length];
  if (!def) return null;
  const goal = def.per * members.length;
  await pool.query('INSERT INTO family_challenges (week_start, code, title, goal) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [ws, def.code, def.title(goal), goal]);
  const { rows } = await pool.query<{ code: string; title: string; goal: number }>('SELECT code, title, goal FROM family_challenges WHERE week_start = $1', [ws]);
  const ch = rows[0];
  const d = CHALLENGES.find((c) => c.code === ch?.code);
  if (!ch || !d) return null;
  const counts = await d.count(ws);
  const progress = counts.reduce((s, c) => s + c.n, 0);
  const names = new Map(members.map((m) => [m.id, m.name]));
  return {
    title: ch.title,
    progress: Math.min(progress, ch.goal),
    goal: ch.goal,
    done: progress >= ch.goal,
    helpers: counts.filter((c) => c.n > 0).map((c) => names.get(c.member_id)).filter((x): x is string => !!x),
  };
}

/** Only good news from the last 7 days. */
async function winsFor(t: DateStr, members: HouseholdMember[]): Promise<WinItem[]> {
  const names = new Map(members.map((m) => [m.id, m.name]));
  const since = addDays(t, -6);
  const wins: WinItem[] = [];
  const add = (at: string, id: number, text: string, emoji: string): void => {
    const who = names.get(id);
    if (who) wins.push({ at, who, text, emoji });
  };
  const chores = await pool.query<{ member_id: number; day: DateStr; n: number }>(
    `SELECT c.member_id, cc.completed_on::text AS day, COUNT(*)::int AS n FROM chore_completions cc JOIN chores c ON c.id = cc.chore_id
      WHERE cc.completed_on >= $1 GROUP BY 1, 2`, [since]);
  for (const r of chores.rows) add(r.day, r.member_id, r.n === 1 ? 'finished a chore' : `finished ${r.n} chores`, '🧹');
  const hw = await pool.query<{ member_id: number; day: DateStr; n: number }>(
    'SELECT member_id, done_on::text AS day, COUNT(*)::int AS n FROM homework WHERE done AND done_on >= $1 GROUP BY 1, 2', [since]);
  for (const r of hw.rows) add(r.day, r.member_id, r.n === 1 ? 'turned in homework' : `turned in ${r.n} homework assignments`, '📚');
  const ach = await pool.query<{ member_id: number; day: DateStr; name: string }>(
    'SELECT member_id, unlocked_on::text AS day, name FROM achievements WHERE unlocked_on >= $1', [since]);
  for (const r of ach.rows) add(r.day, r.member_id, `unlocked ${r.name}`, '🏅');
  const q = await pool.query<{ member_id: number; day: DateStr; note: string }>(
    "SELECT member_id, earned_on::text AS day, note FROM scores WHERE source IN ('quest', 'perfect_week') AND earned_on >= $1", [since]);
  for (const r of q.rows) add(r.day, r.member_id, r.note || 'completed a quest', '⭐');
  const red = await pool.query<{ member_id: number; day: DateStr; reward_name: string }>(
    "SELECT member_id, requested_on::text AS day, reward_name FROM redemptions WHERE status = 'approved' AND requested_on >= $1", [since]);
  for (const r of red.rows) add(r.day, r.member_id, `earned ${r.reward_name}`, '🎁');
  const wo = await pool.query<{ member_id: number; day: DateStr }>(
    "SELECT DISTINCT member_id, logged_on::text AS day FROM workout_logs WHERE kind IN ('day_complete', 'session') AND logged_on >= $1", [since]);
  for (const r of wo.rows) add(r.day, r.member_id, 'got a workout in', '💪');
  const goals = await pool.query<{ member_id: number; name: string; day: DateStr }>(
    "SELECT g.member_id, g.name, MAX(l.day)::text AS day FROM savings_goals g JOIN kid_ledger l ON l.goal_id = g.id WHERE g.done AND l.day >= $1 GROUP BY 1, 2", [since]);
  for (const r of goals.rows) add(r.day, r.member_id, `reached a savings goal: ${r.name}`, '🐷');
  wins.sort((a, b) => b.at.localeCompare(a.at));
  return wins.slice(0, 40);
}

function roleOf(m: HouseholdMember, track: string | null, householdType: string): EngagementResponse['role'] {
  if (m.kind === 'kid') return (m.age ?? 0) >= TEEN_AGE ? 'teen' : 'kid';
  if (track === 'student') return 'student';
  if (householdType === 'solo') return 'solo';
  return 'adult';
}

async function engagementFor(me: HouseholdMember): Promise<EngagementResponse> {
  const t = today();
  const members = await listMembers();
  const { rows } = await pool.query<{ first_run_done: boolean; theme: EngagementResponse['theme']; accent: string; xp_track: string | null; type: string }>(
    `SELECT m.first_run_done, m.theme, m.accent, m.xp_track, h.type FROM household_members m JOIN households h ON h.id = m.household_id WHERE m.id = $1`,
    [me.id],
  );
  const r = rows[0];
  const ws = weekStart(t);
  const isSunday = isoWeekday(t) === 7;
  const { rows: sr } = await pool.query<{ highlight: string }>('SELECT highlight FROM sunday_rituals WHERE week_start = $1', [ws]);
  const { rows: wp } = await pool.query<{ member_id: number; points: number }>(
    'SELECT member_id, COALESCE(SUM(points), 0)::int AS points FROM scores WHERE earned_on BETWEEN $1 AND $2 GROUP BY member_id',
    [ws, end(ws)],
  );
  const kids = members.filter((m) => m.kind === 'kid');
  return {
    quests: await questsFor(me, t),
    challenge: await challengeFor(t, members),
    wins: await winsFor(t, members),
    sunday: kids.length || members.length > 1
      ? {
          isSunday,
          done: sr.length > 0,
          highlight: sr[0]?.highlight ?? '',
          weekPoints: kids.map((k) => ({ name: k.name, points: wp.find((x) => x.member_id === k.id)?.points ?? 0 })),
        }
      : null,
    firstRunDone: r?.first_run_done ?? false,
    role: roleOf(me, r?.xp_track ?? null, r?.type ?? 'family'),
    theme: r?.theme ?? 'system',
    accent: r?.accent ?? 'navy',
  };
}

engagementRouter.get('/api/engagement', async (req, res) => {
  res.json(await engagementFor(self(req)));
});

engagementRouter.post('/api/quests/:id/claim', async (req, res) => {
  const me = self(req);
  const qs = await questsFor(me, today());
  const q = qs.find((x) => x.id === idParam(req.params.id));
  if (!q) throw new HttpError(404, 'No such quest this week');
  if (!q.done) throw new HttpError(409, 'Not finished yet — keep going!');
  const r = await pool.query('UPDATE quests SET claimed = true WHERE id = $1 AND NOT claimed', [q.id]);
  if (r.rowCount) {
    await pool.query("INSERT INTO scores (member_id, earned_on, points, source, note) VALUES ($1, $2, $3, 'quest', $4)", [me.id, today(), q.reward, `Quest: ${q.title}`]);
    await logEvent('quest_claimed', { code: q.code, reward: q.reward }, me.id);
  }
  res.json(await engagementFor(me));
});

/** Sunday ritual: the family looks back at the week together, then names a highlight. */
engagementRouter.post('/api/sunday', async (req, res) => {
  const me = self(req);
  if (me.kind !== 'adult') throw new HttpError(403, 'A grown-up wraps up Sunday');
  const highlight = str((req.body as { highlight?: unknown }).highlight, 'highlight', 200);
  await pool.query(
    `INSERT INTO sunday_rituals (week_start, done_by, highlight) VALUES ($1, $2, $3)
     ON CONFLICT (household_id, week_start) DO UPDATE SET highlight = EXCLUDED.highlight, done_by = EXCLUDED.done_by, done_at = now()`,
    [weekStart(today()), me.id, highlight],
  );
  res.json(await engagementFor(me));
});

/** A focus timer finished (counts toward quests). */
engagementRouter.post('/api/focus/done', async (req, res) => {
  const me = self(req);
  const minutes = Number((req.body as { minutes?: unknown }).minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) throw new HttpError(400, 'minutes must be 1–180');
  await logEvent('focus_done', { minutes: Math.round(minutes) }, me.id);
  res.json(await engagementFor(me));
});

engagementRouter.patch('/api/me/prefs', async (req, res) => {
  const me = self(req);
  const b = req.body as Record<string, unknown>;
  if (b.theme !== undefined) {
    if (b.theme !== 'system' && b.theme !== 'light' && b.theme !== 'dark') throw new HttpError(400, 'theme is system, light or dark');
    await pool.query('UPDATE household_members SET theme = $2 WHERE id = $1', [me.id, b.theme]);
  }
  if (b.accent !== undefined) {
    const accent = ['navy', 'teal', 'purple', 'rose', 'orange', 'green'].find((a) => a === b.accent);
    if (!accent) throw new HttpError(400, 'Unknown accent');
    await pool.query('UPDATE household_members SET accent = $2 WHERE id = $1', [me.id, accent]);
  }
  if (b.firstRunDone === true) await pool.query('UPDATE household_members SET first_run_done = true WHERE id = $1', [me.id]);
  res.json(await engagementFor(me));
});

/* ---------- a teen's private notes: only they can ever read them ---------- */

async function notesFor(memberId: number): Promise<PrivateNote[]> {
  const { rows } = await pool.query<{ id: number; body: string; created_at: Date }>(
    'SELECT id, body, created_at FROM private_notes WHERE member_id = $1 ORDER BY id DESC LIMIT 200',
    [memberId],
  );
  return rows.map((r) => ({ id: r.id, body: r.body, at: r.created_at.toISOString() }));
}

engagementRouter.get('/api/private-notes', async (req, res) => {
  res.json({ notes: await notesFor(self(req).id) });
});

engagementRouter.post('/api/private-notes', async (req, res) => {
  const me = self(req);
  await pool.query('INSERT INTO private_notes (member_id, body) VALUES ($1, $2)', [me.id, str((req.body as { body?: unknown }).body, 'body', 4000, true)]);
  res.status(201).json({ notes: await notesFor(me.id) });
});

engagementRouter.delete('/api/private-notes/:id', async (req, res) => {
  const me = self(req);
  const r = await pool.query('DELETE FROM private_notes WHERE id = $1 AND member_id = $2', [idParam(req.params.id), me.id]);
  if (!r.rowCount) throw new HttpError(404, 'No such note');
  res.json({ notes: await notesFor(me.id) });
});
