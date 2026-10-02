/**
 * Brain Dump: capture anything (empties working memory), then triage each
 * note into a task for today or mark it handled. Ported from apiAdultDump /
 * apiAdultDumpDone; kids can capture too (the old Quick Capture).
 */
import { Router } from 'express';
import type { DumpItem, DumpResponse, HouseholdMember, TriageRequest } from '@myday/shared';
import { pool, tx } from '../db.js';
import { today } from '../lib/dates.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { insertTask, parseNewTask } from './day.js';

export const dumpRouter = Router();

interface DumpRow {
  id: number;
  note: string;
  captured_on: string;
  status: DumpItem['status'];
  task_id: number | null;
}

const toItem = (r: DumpRow): DumpItem => ({ id: r.id, note: r.note, capturedOn: r.captured_on, status: r.status, taskId: r.task_id });

async function dumpFor(member: HouseholdMember): Promise<DumpResponse> {
  const { rows: open } = await pool.query<DumpRow>(
    "SELECT id, note, captured_on::text AS captured_on, status, task_id FROM dump_items WHERE member_id = $1 AND status = 'open' ORDER BY id DESC",
    [member.id],
  );
  const { rows: triaged } = await pool.query<DumpRow>(
    "SELECT id, note, captured_on::text AS captured_on, status, task_id FROM dump_items WHERE member_id = $1 AND status <> 'open' ORDER BY id DESC LIMIT 20",
    [member.id],
  );
  return { open: open.map(toItem), triaged: triaged.map(toItem) };
}

dumpRouter.get('/api/dump', async (req, res) => {
  res.json(await dumpFor(self(req)));
});

dumpRouter.post('/api/dump', async (req, res) => {
  const me = self(req);
  const note = str((req.body as { note?: unknown }).note, 'note', 500, true);
  await pool.query('INSERT INTO dump_items (member_id, captured_on, note) VALUES ($1, $2, $3)', [me.id, today(), note]);
  res.status(201).json(await dumpFor(me));
});

dumpRouter.post('/api/dump/:id/triage', async (req, res) => {
  const me = self(req);
  const id = idParam(req.params.id);
  const b = req.body as TriageRequest & Record<string, unknown>;
  if (b.to !== 'task' && b.to !== 'done') throw new HttpError(400, "to must be 'task' or 'done'");
  if (b.to === 'task' && me.kind !== 'adult') throw new HttpError(403, 'Tasks are for grown-ups — mark it done instead');
  await tx(async (c) => {
    const { rows } = await c.query<{ note: string }>(
      "SELECT note FROM dump_items WHERE id = $1 AND member_id = $2 AND status = 'open' FOR UPDATE",
      [id, me.id],
    );
    const item = rows[0];
    if (!item) throw new HttpError(404, 'Nothing open with that id');
    if (b.to === 'done') {
      await c.query("UPDATE dump_items SET status = 'done' WHERE id = $1", [id]);
      return;
    }
    const task = parseNewTask({ ...b, task: item.note.slice(0, 200) });
    const taskId = await insertTask(me.id, task, today(), c);
    await c.query("UPDATE dump_items SET status = 'task', task_id = $2 WHERE id = $1", [id, taskId]);
  });
  res.json(await dumpFor(me));
});
