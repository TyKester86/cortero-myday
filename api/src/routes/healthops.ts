/**
 * Q8, C7: health logistics routes (lib/chief/healthops.ts). Medications and recurring care are for
 * grown-ups; a kid sees their own visit's prep pack and may add their own questions to it.
 * Organization only — nothing here reads, scores or explains a symptom.
 */
import { Router } from 'express';
import type { DateStr, HealthLogistics } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { bool, HttpError, idParam, str } from '../lib/http.js';
import { listMembers, self } from '../lib/members.js';
import { openLoop } from '../lib/chief/loops.js';
import { viewerOf } from '../lib/chief/scope.js';
import { addQuestion, careItems, healthLoops, listMeds, logRefill, prepPacks, removeQuestion, requireParentHealth } from '../lib/chief/healthops.js';

export const healthOpsRouter = Router();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown, field: string, max: number): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${field} must be a number from 0 to ${max}`);
  return n;
};
const date = (v: unknown, field: string): DateStr | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE.test(v)) throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  return v as DateStr;
};
async function memberIn(id: unknown): Promise<number> {
  if (!Number.isInteger(id) || !(await listMembers()).some((m) => m.id === id)) throw new HttpError(400, 'Pick someone in the household');
  return id as number;
}

/** Everything for the grown-ups' view; a kid gets their own visits for the next two weeks. */
healthOpsRouter.get('/api/health/logistics', async (req, res) => {
  const me = self(req);
  const v = viewerOf(me);
  const t = today();
  const visits = [];
  for (let i = 0; i < 14; i++) visits.push(...(await prepPacks(v, addDays(t, i) as DateStr)));
  if (me.kind !== 'adult') {
    res.json({ medications: [], care: [], visits } satisfies HealthLogistics);
    return;
  }
  await healthLoops();
  res.json({ medications: await listMeds(), care: await careItems(), visits } satisfies HealthLogistics);
});

/** The prep pack for one day (default tomorrow — what the evening brief assembles). */
healthOpsRouter.get('/api/health/prep', async (req, res) => {
  const d = date(req.query.date, 'date') ?? (addDays(today(), 1) as DateStr);
  res.json({ date: d, packs: await prepPacks(viewerOf(self(req)), d) });
});

healthOpsRouter.post('/api/health/medications', async (req, res) => {
  const me = self(req);
  requireParentHealth(me);
  const b = req.body as Record<string, unknown>;
  const supply = num(b.supply, 'supply', 100_000);
  await pool.query(
    `INSERT INTO medications (member_id, name, dose, schedule, per_day, supply, supply_on, refills_left, pharmacy, prescriber, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      await memberIn(b.memberId),
      str(b.name, 'name', 120, true),
      str(b.dose ?? '', 'dose', 120),
      str(b.schedule ?? '', 'schedule', 120),
      num(b.perDay, 'perDay', 100) || null,
      supply,
      supply === null ? null : (date(b.supplyOn, 'supplyOn') ?? today()),
      num(b.refillsLeft, 'refillsLeft', 99),
      str(b.pharmacy ?? '', 'pharmacy', 120),
      str(b.prescriber ?? '', 'prescriber', 120),
      me.id,
    ],
  );
  await healthLoops();
  res.status(201).json({ medications: await listMeds() });
});

healthOpsRouter.put('/api/health/medications/:id', async (req, res) => {
  requireParentHealth(self(req));
  const b = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const args: unknown[] = [idParam(req.params.id)];
  const set = (col: string, v: unknown): void => {
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  };
  if (b.name !== undefined) set('name', str(b.name, 'name', 120, true));
  if (b.dose !== undefined) set('dose', str(b.dose, 'dose', 120));
  if (b.schedule !== undefined) set('schedule', str(b.schedule, 'schedule', 120));
  if (b.perDay !== undefined) set('per_day', num(b.perDay, 'perDay', 100) || null);
  if (b.supply !== undefined) {
    set('supply', num(b.supply, 'supply', 100_000));
    set('supply_on', date(b.supplyOn, 'supplyOn') ?? today());
  }
  if (b.refillsLeft !== undefined) set('refills_left', num(b.refillsLeft, 'refillsLeft', 99));
  if (b.pharmacy !== undefined) set('pharmacy', str(b.pharmacy, 'pharmacy', 120));
  if (b.prescriber !== undefined) set('prescriber', str(b.prescriber, 'prescriber', 120));
  if (b.active !== undefined) set('active', bool(b.active, 'active'));
  if (!sets.length) throw new HttpError(400, 'Nothing to change');
  const { rowCount } = await pool.query(`UPDATE medications SET ${sets.join(', ')} WHERE id = $1`, args);
  if (!rowCount) throw new HttpError(404, 'No such medication');
  await healthLoops();
  res.json({ medications: await listMeds() });
});

healthOpsRouter.delete('/api/health/medications/:id', async (req, res) => {
  requireParentHealth(self(req));
  const id = idParam(req.params.id);
  // Stop first, so its open refill loop closes on that evidence, then remove it.
  const { rowCount } = await pool.query('UPDATE medications SET active = false WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'No such medication');
  await healthLoops();
  await pool.query('DELETE FROM medications WHERE id = $1', [id]);
  res.json({ medications: await listMeds() });
});

healthOpsRouter.post('/api/health/medications/:id/refill', async (req, res) => {
  const amount = num((req.body as { amount?: unknown }).amount, 'amount', 10_000);
  const med = await logRefill(self(req), idParam(req.params.id), amount ?? 0);
  res.json({ medication: med });
});

healthOpsRouter.post('/api/health/care', async (req, res) => {
  const me = self(req);
  requireParentHealth(me);
  const b = req.body as Record<string, unknown>;
  const every = num(b.everyMonths, 'everyMonths', 60);
  if (!every || !Number.isInteger(every)) throw new HttpError(400, 'How many months apart?');
  await pool.query('INSERT INTO care_schedule (member_id, what, every_months, last_on, created_by) VALUES ($1, $2, $3, $4, $5)', [
    await memberIn(b.memberId),
    str(b.what, 'what', 120, true),
    every,
    date(b.lastOn, 'lastOn'),
    me.id,
  ]);
  await healthLoops();
  res.status(201).json({ care: await careItems() });
});

/** Log a visit that happened (sets "last"), or change the rhythm. */
healthOpsRouter.put('/api/health/care/:id', async (req, res) => {
  requireParentHealth(self(req));
  const b = req.body as Record<string, unknown>;
  const every = b.everyMonths === undefined ? null : num(b.everyMonths, 'everyMonths', 60);
  const last = b.lastOn === undefined ? undefined : date(b.lastOn, 'lastOn');
  const { rowCount } = await pool.query(
    'UPDATE care_schedule SET every_months = COALESCE($2, every_months), last_on = CASE WHEN $3 THEN $4::date ELSE last_on END WHERE id = $1',
    [idParam(req.params.id), every, last !== undefined, last ?? null],
  );
  if (!rowCount) throw new HttpError(404, 'Not found');
  await healthLoops();
  res.json({ care: await careItems() });
});

healthOpsRouter.delete('/api/health/care/:id', async (req, res) => {
  requireParentHealth(self(req));
  const id = idParam(req.params.id);
  await pool.query("UPDATE open_loops SET closed_at = now(), closed_evidence = 'Removed from the care schedule' WHERE source = 'health' AND source_ref LIKE $1 AND closed_at IS NULL", [`health:care:${id}:%`]);
  const { rowCount } = await pool.query('DELETE FROM care_schedule WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ care: await careItems() });
});

healthOpsRouter.post('/api/health/visits/:key/questions', async (req, res) => {
  const b = req.body as { question?: unknown; member?: unknown };
  const q = await addQuestion(self(req), String(req.params.key), b.member === undefined || b.member === null ? null : str(b.member, 'member', 60), str(b.question, 'question', 300, true));
  res.status(201).json({ question: q });
});

healthOpsRouter.delete('/api/health/questions/:id', async (req, res) => {
  await removeQuestion(self(req), idParam(req.params.id));
  res.json({ ok: true });
});

/** After a visit: the follow-up the clinician asked for, as a loop (a parent books it). */
healthOpsRouter.post('/api/health/follow-ups', async (req, res) => {
  const me = self(req);
  requireParentHealth(me);
  const b = req.body as Record<string, unknown>;
  const memberId = await memberIn(b.memberId);
  const who = (await listMembers()).find((m) => m.id === memberId)?.name ?? '';
  const loop = await openLoop(me, {
    what: `Follow-up for ${who}: ${str(b.what, 'what', 160, true)}`,
    owedBy: 'the family',
    due: date(b.due, 'due'),
    source: 'health',
    sourceRef: `health:followup:${memberId}:${Date.now()}`,
  });
  res.status(201).json({ loop });
});
