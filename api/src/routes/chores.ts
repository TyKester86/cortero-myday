/**
 * Home Chores + Manage Chores. Ported from the script's apiToday /
 * apiToggleChore / apiChoreList / apiAddChore / apiDelChore.
 */
import { Router } from 'express';
import {
  WEEKDAYS,
  type Chore,
  type ChoreListResponse,
  type HomeworkItem,
  type HouseholdMember,
  type TodayChore,
  type TodayResponse,
  type ToggleChoreResponse,
  type Weekday,
} from '@myday/shared';
import { pool, tx, type Db } from '../db.js';
import { isoToWeekday, isoWeekday, today, weekdayName, weekdayToIso } from '../lib/dates.js';
import { bool, HttpError, idParam, int, str } from '../lib/http.js';
import { memberById, requireAdult, targetMember } from '../lib/members.js';
import { totalPoints, withEarn, xpStatus } from '../lib/xp.js';
import { tryPerfectWeek } from './score.js';
import { tonightCurfew } from './family.js';
import { logEvent } from '../lib/events.js';

export const choresRouter = Router();

interface TodayChoreRow {
  id: number;
  name: string;
  points: number;
  done: boolean;
}

interface HomeworkRow {
  id: number;
  assignment: string;
  subject: string;
  due: string | null;
  points: number;
}

export async function todayFor(member: HouseholdMember, db: Db = pool): Promise<TodayResponse> {
  const date = today();
  const { rows: chores } = await db.query<TodayChoreRow>(
    `SELECT c.id, c.name, c.points, (cc.id IS NOT NULL) AS done
       FROM chores c
       LEFT JOIN chore_completions cc ON cc.chore_id = c.id AND cc.completed_on = $2
      WHERE c.member_id = $1 AND c.active AND $3 = ANY (c.days)
      ORDER BY c.id`,
    [member.id, date, isoWeekday(date)],
  );
  const { rows: hw } = await db.query<HomeworkRow>(
    `SELECT id, assignment, subject, due, points FROM homework
      WHERE member_id = $1 AND NOT done
      ORDER BY due NULLS LAST, id`,
    [member.id],
  );
  const list: TodayChore[] = chores.map((c) => ({ id: c.id, name: c.name, points: c.points, done: c.done }));
  const homework: HomeworkItem[] = hw.map((h) => ({
    id: h.id,
    assignment: h.assignment,
    subject: h.subject,
    due: h.due,
    overdue: h.due !== null && h.due < date,
    points: h.points,
  }));
  // Same arithmetic as apiToday: today's plate = scheduled chores + open homework.
  const pointsToday = list.reduce((s, c) => s + c.points, 0) + homework.reduce((s, h) => s + h.points, 0);
  const pointsEarned = list.filter((c) => c.done).reduce((s, c) => s + c.points, 0);
  const curfew = member.kind === 'kid' ? await tonightCurfew(member.id, date) : null;
  return { member, date, weekday: weekdayName(date), chores: list, homework, pointsToday, pointsEarned, curfew };
}

choresRouter.get('/api/chores/today', async (req, res) => {
  const out: TodayResponse = await todayFor(await targetMember(req));
  res.json(out);
});

/**
 * Check / uncheck a chore for today. Checking awards its points immediately
 * (one ledger row per completion); unchecking a mistaken tap removes them.
 * Finishing the day runs the server-side Perfect Week check.
 */
choresRouter.post('/api/chores/:id/toggle', async (req, res) => {
  const choreId = idParam(req.params.id);
  const done = bool((req.body as { done?: unknown }).done, 'done');
  const date = today();

  const { rows } = await pool.query<{ member_id: number; points: number; days: number[]; active: boolean }>(
    'SELECT member_id, points, days, active FROM chores WHERE id = $1',
    [choreId],
  );
  const chore = rows[0];
  if (!chore || !chore.active) throw new HttpError(404, 'Chore not found');
  const owner = await memberById(chore.member_id);
  if (!owner) throw new HttpError(404, 'Chore not found');
  if (req.member?.kind !== 'adult' && req.member?.id !== owner.id) {
    throw new HttpError(403, 'That is not your chore');
  }
  if (!chore.days.includes(isoWeekday(date))) throw new HttpError(400, 'That chore is not scheduled today');

  const { earn } = await withEarn(owner.id, () => tx(async (c) => {
    if (done) {
      const ins = await c.query<{ id: number }>(
        `INSERT INTO chore_completions (chore_id, completed_on, points, completed_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT (chore_id, completed_on) DO NOTHING RETURNING id`,
        [choreId, date, chore.points, req.user?.id ?? null],
      );
      const completionId = ins.rows[0]?.id;
      if (completionId !== undefined) {
        const { rows: nm } = await c.query<{ name: string }>('SELECT name FROM chores WHERE id = $1', [choreId]);
        await c.query(
          `INSERT INTO scores (member_id, earned_on, points, source, note, chore_completion_id)
           VALUES ($1, $2, $3, 'chore', $4, $5)`,
          [owner.id, date, chore.points, nm[0]?.name ?? '', completionId],
        );
      }
    } else {
      // The ledger row goes with it (ON DELETE CASCADE).
      await c.query('DELETE FROM chore_completions WHERE chore_id = $1 AND completed_on = $2', [choreId, date]);
    }
  }));

  if (done) await logEvent('chore_done', { chore: choreId }, owner.id);
  const day = await todayFor(owner);
  const allDone = day.chores.length > 0 && day.chores.every((c) => c.done);
  const perfectWeek = done && allDone ? await tryPerfectWeek(owner) : null;
  // A Perfect Week bonus is points too, so re-read the totals after it.
  const after = perfectWeek?.awarded ? await xpStatus(owner.id) : earn.xp;
  const out: ToggleChoreResponse = {
    today: day,
    perfectWeek,
    totalPoints: perfectWeek?.awarded ? await totalPoints(owner.id) : earn.totalPoints,
    xp: after,
    leveledUp: earn.leveledUp || after.level > earn.xp.level,
  };
  res.json(out);
});

/* ---------- Manage Chores (grown-ups) ---------- */

interface ChoreRow {
  id: number;
  name: string;
  member_id: number;
  member_name: string;
  days: number[];
  points: number;
}

choresRouter.get('/api/chores', async (_req, res) => {
  const { rows } = await pool.query<ChoreRow>(
    `SELECT c.id, c.name, c.member_id, m.name AS member_name, c.days, c.points
       FROM chores c JOIN household_members m ON m.id = c.member_id
      WHERE c.active AND m.archived_at IS NULL
      ORDER BY m.sort_order, m.id, c.id`,
  );
  const chores: Chore[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    memberId: r.member_id,
    memberName: r.member_name,
    days: [...r.days].sort((a, b) => a - b).map(isoToWeekday),
    points: r.points,
  }));
  const out: ChoreListResponse = { chores };
  res.json(out);
});

function parseDays(v: unknown): Weekday[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'days must be a list');
  const days = WEEKDAYS.filter((w) => v.includes(w));
  if (!days.length) throw new HttpError(400, 'Pick at least one day');
  return days;
}

choresRouter.post('/api/chores', async (req, res) => {
  requireAdult(req);
  const body = req.body as Record<string, unknown>;
  const name = str(body.name, 'name', 80, true);
  const memberId = idParam(body.memberId);
  const days = parseDays(body.days);
  // Same rule as apiAddChore: whole, non-negative points.
  const points = int(body.points ?? 0, 'points', 0, 10_000);
  if (!(await memberById(memberId))) throw new HttpError(400, 'Pick someone in the household');
  try {
    await pool.query('INSERT INTO chores (name, member_id, days, points, created_on) VALUES ($1, $2, $3, $4, $5)', [
      name,
      memberId,
      days.map(weekdayToIso),
      points,
      today(),
    ]);
  } catch (e) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505') {
      throw new HttpError(409, 'That person already has a chore with that name');
    }
    throw e;
  }
  res.status(201).json({ ok: true });
});

choresRouter.delete('/api/chores/:id', async (req, res) => {
  requireAdult(req);
  // Soft delete: points already earned from this chore stay earned.
  const r = await pool.query('UPDATE chores SET active = false WHERE id = $1 AND active', [idParam(req.params.id)]);
  if (!r.rowCount) throw new HttpError(404, 'Chore not found');
  res.json({ ok: true });
});
