/**
 * Hana in MyDay — the chief of staff's own surfaces. Everything here reads; nothing
 * changes app state outside Hana's own log (hana_items).
 *
 * H2: GET /api/hana/tools/:tool — the read-only toolbelt, scoped to whoever asks
 *     (a parent: the family; a child: only their own day) with source and as-of.
 * H3: GET /api/hana/brief — the morning / evening / weekly brief for whoever asks.
 *     POST /api/hana/items/:id/outcome — acted on / not now / wrong (H9).
 *     GET /api/hana/alerts — parents: open crisis + watch items (Family HQ).
 * H4: GET /api/hana/coach — one kid's homework plan (a kid: their own; a parent: ?member=).
 *     POST /api/hana/coach/:homeworkId/step — the progress signal (Hana's record only).
 *     POST /api/hana/nudges/:homeworkId/dismiss — a dismissed nudge stays dismissed.
 * H9: GET /api/hana/report?month=YYYY-MM — parents only, wins and where Hana was wrong.
 */
import { Router } from 'express';
import type { DateStr } from '@myday/shared';
import { config } from '../config.js';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, idParam } from '../lib/http.js';
import { self } from '../lib/members.js';
import { requireParent, viewerOf } from '../lib/chief/scope.js';
import { balances, billsDue, choresFor, familyFor, feedInbox, healthFor, homeworkFor, scheduleFor } from '../lib/chief/tools.js';
import { briefFor, markItem, type BriefKind, type ItemOutcome } from '../lib/chief/brief.js';
import { familyReport } from '../lib/chief/needle.js';
import { coachFor, coachTarget, dismissNudge, refreshEscalations, setStep } from '../lib/chief/coach.js';

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

/** Morning before 3 PM, evening after (household time), unless asked. */
function defaultKind(): BriefKind {
  const h = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: config.tz }));
  return h >= 15 ? 'evening' : 'morning';
}

hqRouter.get('/api/hana/brief', async (req, res) => {
  const v = viewerOf(self(req));
  const k = req.query.kind;
  const kind: BriefKind = k === 'morning' || k === 'evening' || k === 'weekly' ? k : defaultKind();
  res.json(await briefFor(v, kind));
});

const OUTCOMES: ItemOutcome[] = ['acted', 'dismissed', 'wrong'];

hqRouter.post('/api/hana/items/:id/outcome', async (req, res) => {
  const v = viewerOf(self(req));
  const outcome = OUTCOMES.find((o) => o === (req.body as { outcome?: unknown }).outcome);
  if (!outcome) throw new HttpError(400, 'Outcome is acted, dismissed or wrong');
  // Only your own items: anyone else's (or another household's) is simply not found.
  if (!(await markItem(v, idParam(req.params.id), outcome))) throw new HttpError(404, 'Not found');
  res.json({ ok: true, outcome });
});

hqRouter.get('/api/hana/alerts', async (req, res) => {
  const v = viewerOf(self(req));
  requireParent(v, 'Family HQ');
  await refreshEscalations();
  const { rows } = await pool.query<{ id: number; surface: string; category: string; text: string; source: string; as_of: Date | null; shown_on: string }>(
    `SELECT id, surface, category, text, source, as_of, shown_on::text AS shown_on FROM hana_items
      WHERE member_id = $1 AND surface IN ('crisis', 'watch', 'escalation') AND outcome IS NULL AND shown_on >= $2
      ORDER BY (surface = 'crisis') DESC, shown_on DESC, id DESC LIMIT 30`,
    [v.me.id, addDays(today(), -7)],
  );
  res.json({
    alerts: rows.map((r) => ({ id: r.id, kind: r.surface, category: r.category, text: r.text, source: r.source, asOf: r.as_of?.toISOString() ?? null, date: r.shown_on })),
  });
});

hqRouter.get('/api/hana/report', async (req, res) => {
  const v = viewerOf(self(req));
  const month = typeof req.query.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month) ? req.query.month : today().slice(0, 7);
  res.json(await familyReport(v, month));
});

hqRouter.get('/api/hana/coach', async (req, res) => {
  const v = viewerOf(self(req));
  res.json(await coachFor(v, await coachTarget(v, typeof req.query.member === 'string' ? req.query.member : null)));
});

hqRouter.post('/api/hana/coach/:homeworkId/step', async (req, res) => {
  const v = viewerOf(self(req));
  await setStep(v, idParam(req.params.homeworkId), Number((req.body as { step?: unknown }).step));
  res.json({ ok: true });
});

hqRouter.post('/api/hana/nudges/:homeworkId/dismiss', async (req, res) => {
  const v = viewerOf(self(req));
  await dismissNudge(v, idParam(req.params.homeworkId));
  res.json({ ok: true });
});
