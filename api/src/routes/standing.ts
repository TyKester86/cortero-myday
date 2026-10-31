/**
 * Q10 routes: Tier 3 standing authority (parents). Each class shows this family's record and
 * what it still needs; a grant succeeds only when the record has earned it; either parent revokes.
 */
import { Router } from 'express';
import { HttpError } from '../lib/http.js';
import { self } from '../lib/members.js';
import { grant, revoke, standingView } from '../lib/chief/standing.js';

export const standingRouter = Router();

standingRouter.get('/api/hana/standing', async (req, res) => {
  if (self(req).kind !== 'adult') throw new HttpError(403, 'Standing authority is for grown-ups');
  res.json({ classes: await standingView() });
});

standingRouter.post('/api/hana/standing/:cls/grant', async (req, res) => {
  res.json({ classes: await grant(self(req), String(req.params.cls)) });
});

standingRouter.post('/api/hana/standing/:cls/revoke', async (req, res) => {
  res.json({ classes: await revoke(self(req), String(req.params.cls)) });
});
