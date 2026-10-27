/**
 * Hana in MyDay — the chief of staff's own surfaces. Everything here reads; nothing
 * changes app state outside Hana's own log (hana_items).
 *
 * H2: GET /api/hana/tools/:tool — the read-only toolbelt, scoped to whoever asks
 *     (a parent: the family; a child: only their own day) with source and as-of.
 */
import { Router } from 'express';
import type { DateStr } from '@myday/shared';
import { addDays, today } from '../lib/dates.js';
import { HttpError } from '../lib/http.js';
import { self } from '../lib/members.js';
import { viewerOf } from '../lib/chief/scope.js';
import { balances, billsDue, choresFor, familyFor, feedInbox, healthFor, homeworkFor, scheduleFor } from '../lib/chief/tools.js';

export const hqRouter = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateQ = (v: unknown, fallback: DateStr): DateStr => (typeof v === 'string' && DATE.test(v) ? v : fallback);
const personQ = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : null);

hqRouter.get('/api/hana/tools/:tool', async (req, res) => {
  const v = viewerOf(self(req));
  const q = req.query;
  switch (req.params.tool) {
    case 'schedule': {
      const from = dateQ(q.from, today());
      const to = dateQ(q.to, from);
      if (to < from || to > addDays(from, 31)) throw new HttpError(400, 'Pick up to a month');
      res.json(await scheduleFor(v, from, to));
      return;
    }
    case 'homework':
      res.json(await homeworkFor(v, personQ(q.person)));
      return;
    case 'chores':
      res.json(await choresFor(v, dateQ(q.day, today()), personQ(q.person)));
      return;
    case 'bills':
      res.json(await billsDue(v, Number(q.days ?? 7) || 7));
      return;
    case 'balance':
      res.json(await balances(v));
      return;
    case 'feed':
      res.json(await feedInbox(v));
      return;
    case 'health':
      res.json(await healthFor(v, personQ(q.person)));
      return;
    case 'family':
      res.json(await familyFor(v));
      return;
    default:
      throw new HttpError(404, 'No such tool');
  }
});
