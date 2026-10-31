/**
 * Q9 (first pair) routes: JP6 the shield and JP5 people dossiers — parents only.
 * The shield warns; a parent marks each warning fine or a scam (nothing is ever blocked).
 */
import { Router } from 'express';
import type { PersonRole } from '@myday/shared';
import { pool } from '../db.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { decideAlert, listAlerts, requireParentShield } from '../lib/chief/shield.js';
import { dossier, peopleView, requireParentPeople, ROLES, savePerson } from '../lib/chief/people.js';

export const peopleRouter = Router();

peopleRouter.get('/api/shield', async (req, res) => {
  requireParentShield(self(req));
  res.json({ alerts: await listAlerts(req.query.all === '1') });
});

peopleRouter.post('/api/shield/:id/:verdict', async (req, res) => {
  const v = req.params.verdict;
  if (v !== 'fine' && v !== 'scam') throw new HttpError(404, 'Not found');
  res.json({ alert: await decideAlert(self(req), idParam(req.params.id), v) });
});

const body = (b: Record<string, unknown>) => {
  const role = b.role as PersonRole;
  if (!ROLES.includes(role)) throw new HttpError(400, `Role is one of ${ROLES.join(', ')}`);
  const forIds = Array.isArray(b.forIds) ? b.forIds : [];
  if (!forIds.every((x) => Number.isInteger(x))) throw new HttpError(400, 'forIds are member ids');
  return {
    name: str(b.name, 'name', 120, true),
    role,
    email: str(b.email ?? '', 'email', 200),
    phone: str(b.phone ?? '', 'phone', 40),
    org: str(b.org ?? '', 'org', 120),
    notes: str(b.notes ?? '', 'notes', 500),
    forIds: forIds as number[],
  };
};

peopleRouter.get('/api/people', async (req, res) => {
  res.json(await peopleView(self(req)));
});

peopleRouter.get('/api/people/:id', async (req, res) => {
  res.json(await dossier(self(req), idParam(req.params.id)));
});

peopleRouter.post('/api/people', async (req, res) => {
  res.status(201).json({ person: await savePerson(self(req), null, body(req.body as Record<string, unknown>)) });
});

peopleRouter.put('/api/people/:id', async (req, res) => {
  res.json({ person: await savePerson(self(req), idParam(req.params.id), body(req.body as Record<string, unknown>)) });
});

peopleRouter.delete('/api/people/:id', async (req, res) => {
  requireParentPeople(self(req));
  const { rowCount } = await pool.query('DELETE FROM people WHERE id = $1', [idParam(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'No such person');
  res.json({ ok: true });
});
