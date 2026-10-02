/**
 * Boss Battles and Red Alert, ported from BOSS_LIST / apiAdultBattles /
 * apiAdultStartBattle / apiAdultCompleteBattle and RED_STEPS /
 * apiAdultRedAlert. Grown-ups only (they come from the adult workbooks).
 */
import { Router } from 'express';
import type {
  BattleEntry,
  BattlesResponse,
  Boss,
  HouseholdMember,
  RedAlertDone,
  RedAlertResponse,
  XpTrack,
} from '@myday/shared';
import { pool, tx } from '../db.js';
import { today } from '../lib/dates.js';
import { HttpError, int, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { trackOf } from '../lib/adult.js';
import { awardXpOnce, withEarn } from '../lib/xp.js';

export const battlesRouter = Router();

/** BOSS_LIST, verbatim per role. */
export function bossList(track: XpTrack): Boss[] {
  const b = (name: string, desc: string): Boss => ({ name, desc });
  if (track === 'student') {
    return [
      b('⚔️ THE SCHOLAR', 'Study 20+ hours/week for 4 consecutive weeks'),
      b('⚔️ THE FINISHER', 'Complete all MITs for 14 consecutive days'),
      b('⚔️ THE BODY', 'Exercise 4x per week for 4 consecutive weeks'),
      b('⚔️ THE BUDGETER', 'Log all finances for 30 consecutive days'),
      b('⚔️ THE CONNECTOR', 'Use a campus support resource every week for 4 weeks'),
      b('⚔️ THE SLEEPER', 'Log 7+ hours of sleep for 21 consecutive nights'),
    ];
  }
  const base = [
    b('🏗️ Finish overdue project', 'Complete a project you have been avoiding for weeks'),
    b('💰 Complete budget review', 'Review all finances, update autopay in Money'),
    b('💬 Have the hard conversation', 'Address the difficult conversation you have been avoiding'),
    b('🔧 Complete home repair', 'Fix something that has been broken for too long'),
    b('📞 Make 5 important calls', 'Complete the calls you have been procrastinating'),
    b('📝 Organize digital files', 'Clean up computer files, emails, or digital clutter'),
    b('🏃 5 workouts this week', 'Complete 5 exercise sessions in 7 days'),
    b('📚 Read entire book', 'Start and finish a complete book'),
    b('🎯 Finish 3 top priorities', 'Complete your 3 most important tasks'),
  ];
  if (track === 'woman') {
    base.splice(1, 0, b('🧹 Deep clean a space', 'Organize and clean a major space in your home'));
    base.splice(2, 0, b('💑 Family date night', 'Plan and execute a quality date with your spouse'));
    base.splice(8, 0, b('👨‍👧‍👦 Time with each child', 'Spend 1-on-1 quality time with every kid'));
  } else {
    base.splice(1, 0, b('💑 Plan a date night', 'Plan and execute quality time with your partner'));
    base.splice(7, 0, b('👨‍👧‍👦 Time with each child', 'Spend 1-on-1 quality time with every kid'));
  }
  return base;
}

const battleXp = (track: XpTrack): number => (track === 'student' ? 200 : 100);
const cadence = (track: XpTrack): BattlesResponse['cadence'] =>
  track === 'leader' ? 'monthly' : track === 'woman' ? 'weekly' : 'epic';

interface BattleRow {
  id: number;
  name: string;
  status: BattleEntry['status'];
  started_on: string;
  done_on: string | null;
}

async function battlesFor(member: HouseholdMember): Promise<BattlesResponse> {
  const track = await trackOf(member.id);
  const { rows } = await pool.query<BattleRow>(
    `SELECT id, name, status, started_on::text AS started_on, done_on::text AS done_on
       FROM boss_battles WHERE member_id = $1 ORDER BY id DESC LIMIT 13`,
    [member.id],
  );
  const all = rows.map(
    (r): BattleEntry => ({ id: r.id, name: r.name, status: r.status, startedOn: r.started_on, doneOn: r.done_on }),
  );
  return {
    active: all.find((b) => b.status === 'active') ?? null,
    bosses: bossList(track),
    history: all.filter((b) => b.status !== 'active').slice(0, 12),
    xp: battleXp(track),
    cadence: cadence(track),
  };
}

battlesRouter.get('/api/battles', async (req, res) => {
  res.json(await battlesFor(requireAdult(req)));
});

/** Start a battle (from the list or your own). Any active one is marked replaced. */
battlesRouter.post('/api/battles', async (req, res) => {
  const me = requireAdult(req);
  const name = str((req.body as { name?: unknown }).name, 'name', 60, true);
  await tx(async (c) => {
    await c.query("UPDATE boss_battles SET status = 'replaced' WHERE member_id = $1 AND status = 'active'", [me.id]);
    await c.query('INSERT INTO boss_battles (member_id, name, started_on) VALUES ($1, $2, $3)', [me.id, name, today()]);
  });
  res.status(201).json(await battlesFor(me));
});

/** Defeat the active boss: 100 XP (200 on the student track). */
battlesRouter.post('/api/battles/complete', async (req, res) => {
  const me = requireAdult(req);
  const track = await trackOf(me.id);
  const t = today();
  const { earn } = await withEarn(me.id, async () => {
    const { rows } = await pool.query<{ id: number }>(
      "UPDATE boss_battles SET status = 'done', done_on = $2 WHERE member_id = $1 AND status = 'active' RETURNING id",
      [me.id, t],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new HttpError(409, 'No active battle');
    await awardXpOnce(me.id, t, battleXp(track), 'Boss Battle Complete', `boss:${id}`);
  });
  res.json({ ...earn, battles: await battlesFor(me) });
});

/* ---------- Red Alert: the restart protocol ---------- */

export function redSteps(track: XpTrack): string[] {
  if (track === 'student') {
    return [
      'STOP — close every tab but this. Phone face-down.',
      'ASSESS — write what is actually happening. Be honest.',
      'TRIAGE — list the 1–3 things that MUST happen in 24 hours.',
      'COMMUNICATE — who needs to know something right now?',
      'ACTIVATE SUPPORT — text or call one person from Campus Support.',
      'TIMELINE — give each triage item a when.',
    ];
  }
  return [
    'Drink a full glass of water.',
    'Read your Identity Anchor statement.',
    'Complete ONE task — any task.',
    'Text one person who cares about you.',
    'Go outside for 10 minutes.',
  ];
}

const RED_DONE =
  'Minimum viable day complete. That is not failure — that is the protocol working. Tomorrow: only Today. Nothing else.';

battlesRouter.get('/api/red-alert', async (req, res) => {
  const me = requireAdult(req);
  const { rows } = await pool.query<{ day: string; trigger: string; steps_done: number; steps_total: number }>(
    'SELECT day::text AS day, trigger, steps_done, steps_total FROM red_alerts WHERE member_id = $1 ORDER BY id DESC LIMIT 10',
    [me.id],
  );
  const out: RedAlertResponse = {
    steps: redSteps(await trackOf(me.id)),
    recent: rows.map((r) => ({ day: r.day, trigger: r.trigger, stepsDone: r.steps_done, stepsTotal: r.steps_total })),
  };
  res.json(out);
});

/** Log a run of the protocol. 5 XP ("Restart Protocol Used"), at most once a day. */
battlesRouter.post('/api/red-alert', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const steps = redSteps(await trackOf(me.id));
  const t = today();
  const { earn } = await withEarn(me.id, async () => {
    await pool.query(
      'INSERT INTO red_alerts (member_id, day, trigger, steps_done, steps_total, note) VALUES ($1, $2, $3, $4, $5, $6)',
      [me.id, t, str(b.trigger, 'trigger', 200), int(b.stepsDone ?? 0, 'stepsDone', 0, steps.length), steps.length, str(b.note, 'note', 300)],
    );
    await awardXpOnce(me.id, t, 5, 'Restart Protocol Used', `redalert:${t}`);
  });
  const out: RedAlertDone = { ...earn, message: RED_DONE };
  res.json(out);
});
