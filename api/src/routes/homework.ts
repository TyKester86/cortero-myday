/**
 * Homework. Port of apiAddHomework / apiToggleHomework: kids log their own,
 * each item is worth 20 points (HOMEWORK_POINTS) paid when it's checked off.
 * Open homework due by today blocks Perfect Week (see score.ts).
 */
import { Router, type Request } from 'express';
import {
  HOMEWORK_POINTS,
  type HomeworkEntry,
  type HomeworkListResponse,
  type HouseholdMember,
  type ToggleHomeworkResponse,
} from '@myday/shared';
import { pool, tx } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { bool, HttpError, idParam, int, str } from '../lib/http.js';
import { memberById, requireAdult, targetMember } from '../lib/members.js';
import { withEarn } from '../lib/xp.js';

export const homeworkRouter = Router();

interface HomeworkRow {
  id: number;
  assignment: string;
  subject: string;
  due: string | null;
  done: boolean;
  done_on: string | null;
  points: number;
}

export async function homeworkFor(member: HouseholdMember): Promise<HomeworkListResponse> {
  const t = today();
  const { rows } = await pool.query<HomeworkRow>(
    `SELECT id, assignment, subject, due, done, done_on, points FROM homework
      WHERE member_id = $1 AND (NOT done OR done_on >= $2)
      ORDER BY done, due NULLS LAST, id`,
    [member.id, addDays(t, -14)],
  );
  const entries = rows.map(
    (h): HomeworkEntry => ({
      id: h.id,
      assignment: h.assignment,
      subject: h.subject,
      due: h.due,
      overdue: !h.done && h.due !== null && h.due < t,
      points: h.points,
      done: h.done,
      doneOn: h.done_on,
    }),
  );
  return { member, open: entries.filter((e) => !e.done), doneRecently: entries.filter((e) => e.done) };
}

homeworkRouter.get('/api/homework', async (req, res) => {
  res.json(await homeworkFor(await targetMember(req)));
});

homeworkRouter.post('/api/homework', async (req, res) => {
  const member = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const dueRaw = str(b.due, 'due', 10);
  if (dueRaw && !/^\d{4}-\d{2}-\d{2}$/.test(dueRaw)) throw new HttpError(400, 'due must be yyyy-MM-dd');
  // Kids can't set their own point value.
  const points =
    req.member?.kind === 'adult' && b.points !== undefined ? int(b.points, 'points', 0, 1000) : HOMEWORK_POINTS;
  await pool.query(
    `INSERT INTO homework (member_id, assignment, subject, due, points, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [member.id, str(b.assignment, 'assignment', 120, true), str(b.subject, 'subject', 60), dueRaw || null, points, req.user?.id ?? null],
  );
  res.status(201).json(await homeworkFor(member));
});

async function ownedHomework(req: Request, id: number): Promise<{ member: HouseholdMember; points: number }> {
  const { rows } = await pool.query<{ member_id: number; points: number }>(
    'SELECT member_id, points FROM homework WHERE id = $1',
    [id],
  );
  const row = rows[0];
  const member = row ? await memberById(row.member_id) : null;
  if (!row || !member) throw new HttpError(404, 'Homework not found');
  if (req.member?.kind !== 'adult' && req.member?.id !== member.id) throw new HttpError(403, 'That is not your homework');
  return { member, points: row.points };
}

homeworkRouter.post('/api/homework/:id/toggle', async (req, res) => {
  const id = idParam(req.params.id);
  const done = bool((req.body as { done?: unknown }).done, 'done');
  const { member, points } = await ownedHomework(req, id);
  const t = today();
  const { earn } = await withEarn(member.id, () =>
    tx(async (c) => {
      if (done) {
        const upd = await c.query('UPDATE homework SET done = true, done_on = $2 WHERE id = $1 AND NOT done', [id, t]);
        if (upd.rowCount) {
          const { rows } = await c.query<{ assignment: string }>('SELECT assignment FROM homework WHERE id = $1', [id]);
          await c.query(
            `INSERT INTO scores (member_id, earned_on, points, source, note, homework_id)
             VALUES ($1, $2, $3, 'homework', $4, $5)`,
            [member.id, t, points, rows[0]?.assignment ?? 'Homework', id],
          );
        }
      } else {
        await c.query('UPDATE homework SET done = false, done_on = NULL WHERE id = $1', [id]);
        await c.query('DELETE FROM scores WHERE homework_id = $1', [id]);
      }
    }),
  );
  const out: ToggleHomeworkResponse = { ...earn, homework: await homeworkFor(member) };
  res.json(out);
});

/**
 * Grown-ups only — so homework can't be deleted to dodge the Perfect Week
 * rule. Open items only: deleting a finished one would take its points away.
 */
homeworkRouter.delete('/api/homework/:id', async (req, res) => {
  requireAdult(req);
  const id = idParam(req.params.id);
  const { member } = await ownedHomework(req, id);
  const r = await pool.query('DELETE FROM homework WHERE id = $1 AND NOT done', [id]);
  if (!r.rowCount) throw new HttpError(409, 'Finished homework stays — its points were earned');
  res.json(await homeworkFor(member));
});
