/**
 * C2: connected calendars (read-only) and the family timeline.
 *
 * GET    /api/calendar/sources            — a parent: everyone's; a child: their own (never the address)
 * POST   /api/calendar/sources            — a grown-up connects their own calendar; a parent adds a
 *                                            child's school calendar (kids can't add anything)
 * PATCH  /api/calendar/sources/:id        — the owner: busy-only or with details
 * POST   /api/calendar/sources/:id/sync   — read it again now
 * DELETE /api/calendar/sources/:id        — disconnect (its events go with it)
 * GET    /api/calendar/timeline           — MyDay's calendar + connected ones, labeled, with the conflicts
 *
 * Read every 30 minutes (job calendar-sources); conflicts found on a sync go to the watch right away.
 */
import { Router } from 'express';
import type { CalendarSource, CalendarSourceKind, DateStr, FamilyTimeline, HouseholdMember } from '@myday/shared';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { listMembers, self } from '../lib/members.js';
import { rateLimiter } from '../lib/pin.js';
import { registerJob } from '../lib/schedulers.js';
import { sealText, currentKeyId } from '../lib/seal.js';
import { normalizeFeedUrl, syncSource, urlHint } from '../lib/calendarSources.js';
import { viewerOf } from '../lib/chief/scope.js';
import { scheduleFor } from '../lib/chief/tools.js';
import { findConflicts } from '../lib/chief/conflicts.js';
import { conflictOptions } from '../lib/chief/brief.js';
import { runWatch } from '../lib/chief/watch.js';
import { logEvent } from '../lib/events.js';

export const calendarSourcesRouter = Router();

const KINDS: CalendarSourceKind[] = ['google', 'outlook', 'apple', 'school', 'other'];
const KIND_LABEL: Record<CalendarSourceKind, string> = { google: 'Google calendar', outlook: 'Outlook calendar', apple: 'Apple calendar', school: 'school calendar', other: 'calendar' };
const MAX_PER_MEMBER = 5;
const syncLimit = rateLimiter(20, 60 * 60_000);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Row {
  id: number;
  member_id: number;
  added_by: number | null;
  kind: CalendarSourceKind;
  label: string;
  url_hint: string;
  visibility: 'busy' | 'details';
  last_synced_at: Date | null;
  last_error: string | null;
  event_count: number;
}
const COLS = 'id, member_id, added_by, kind, label, url_hint, visibility, last_synced_at, last_error, event_count';

const toSource = (r: Row, members: HouseholdMember[]): CalendarSource => ({
  id: r.id,
  member: members.find((m) => m.id === r.member_id)?.name ?? 'Someone',
  memberKey: members.find((m) => m.id === r.member_id)?.key ?? '',
  kind: r.kind,
  label: r.label,
  hint: r.url_hint,
  visibility: r.visibility,
  lastSyncedAt: r.last_synced_at?.toISOString() ?? null,
  error: r.last_error,
  events: r.event_count,
});

/** Who may change a source: its owner (a grown-up), or any parent for a child's. */
async function editable(me: HouseholdMember, id: number): Promise<Row> {
  if (me.kind !== 'adult') throw new HttpError(403, 'Only grown-ups can change connected calendars');
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM calendar_sources WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'Not found');
  const owner = (await listMembers()).find((m) => m.id === r.member_id);
  if (r.member_id !== me.id && owner?.kind !== 'kid') throw new HttpError(404, 'Not found');
  return r;
}

async function listFor(me: HouseholdMember): Promise<CalendarSource[]> {
  const members = await listMembers();
  const { rows } = await pool.query<Row>(`SELECT ${COLS} FROM calendar_sources ${me.kind === 'adult' ? '' : 'WHERE member_id = $1'} ORDER BY id`, me.kind === 'adult' ? [] : [me.id]);
  return rows.map((r) => toSource(r, members));
}

calendarSourcesRouter.get('/api/calendar/sources', async (req, res) => {
  res.json({ sources: await listFor(self(req)) });
});

calendarSourcesRouter.post('/api/calendar/sources', async (req, res) => {
  const me = self(req);
  if (me.kind !== 'adult') throw new HttpError(403, 'A grown-up connects calendars');
  const b = req.body as { url?: unknown; kind?: unknown; label?: unknown; member?: unknown; visibility?: unknown };
  const kind = KINDS.find((k) => k === b.kind);
  if (!kind) throw new HttpError(400, `Kind is ${KINDS.join(', ')}`);
  const members = await listMembers();
  const who = typeof b.member === 'string' && b.member ? members.find((m) => m.key === b.member) : me;
  if (!who) throw new HttpError(404, 'No one by that name here');
  // Your own calendar, or a child's school calendar — never another grown-up's.
  if (who.id !== me.id && who.kind !== 'kid') throw new HttpError(403, 'Each grown-up connects their own calendar');
  if (who.kind === 'kid' && kind !== 'school' && kind !== 'other') throw new HttpError(400, 'For a child, add a school or activity calendar');
  const url = normalizeFeedUrl(str(b.url, 'url', 2000));
  const { rows: n } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM calendar_sources WHERE member_id = $1', [who.id]);
  if ((n[0]?.n ?? 0) >= MAX_PER_MEMBER) throw new HttpError(400, `Up to ${MAX_PER_MEMBER} calendars each`);
  const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 40) : KIND_LABEL[kind];
  // A grown-up's own calendar is busy-only to the rest of the family unless they choose otherwise; a child's is shown.
  const visibility = who.kind === 'kid' ? 'details' : b.visibility === 'details' ? 'details' : 'busy';
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO calendar_sources (member_id, added_by, kind, label, url_enc, key_id, url_hint, visibility) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [who.id, me.id, kind, label, sealText(url, keyId), keyId, urlHint(url), visibility],
  );
  const id = rows[0]?.id as number;
  const sync = await syncSource(id);
  await logEvent('calendar_connected', { kind, ok: !sync.error }, me.id);
  // A first read that fails isn't kept: say why, so they can paste the right link.
  if (sync.error) {
    await pool.query('DELETE FROM calendar_sources WHERE id = $1', [id]);
    throw new HttpError(400, sync.error);
  }
  await runWatch(new Date()).catch(() => undefined);
  res.status(201).json({ sources: await listFor(me), sync });
});

calendarSourcesRouter.patch('/api/calendar/sources/:id', async (req, res) => {
  const me = self(req);
  const r = await editable(me, idParam(req.params.id));
  const v = (req.body as { visibility?: unknown }).visibility;
  if (v !== 'busy' && v !== 'details') throw new HttpError(400, 'Busy-only or details');
  if (r.member_id !== me.id) throw new HttpError(403, 'Only the calendar’s owner chooses what the family sees');
  await pool.query('UPDATE calendar_sources SET visibility = $2 WHERE id = $1', [r.id, v]);
  res.json({ sources: await listFor(me) });
});

calendarSourcesRouter.post('/api/calendar/sources/:id/sync', async (req, res) => {
  const me = self(req);
  const r = await editable(me, idParam(req.params.id));
  if (!syncLimit(String(me.id))) throw new HttpError(429, 'That’s a lot of refreshing — it reads on its own every 30 minutes');
  const sync = await syncSource(r.id);
  if (!sync.error) await runWatch(new Date()).catch(() => undefined);
  res.json({ sources: await listFor(me), sync });
});

calendarSourcesRouter.delete('/api/calendar/sources/:id', async (req, res) => {
  const me = self(req);
  const r = await editable(me, idParam(req.params.id));
  await pool.query('DELETE FROM calendar_sources WHERE id = $1', [r.id]);
  res.json({ sources: await listFor(me) });
});

/** The family timeline: a VIEW over MyDay's calendar and the connected ones, each labeled, plus the conflicts. */
calendarSourcesRouter.get('/api/calendar/timeline', async (req, res) => {
  const v = viewerOf(self(req));
  const from = (typeof req.query.from === 'string' && DATE.test(req.query.from) ? req.query.from : today()) as DateStr;
  const to = (typeof req.query.to === 'string' && DATE.test(req.query.to) ? req.query.to : addDays(from, 6)) as DateStr;
  if (to < from || to > addDays(from, 31)) throw new HttpError(400, 'Pick up to a month');
  const f = await scheduleFor(v, from, to);
  const t = today();
  const label = (d: DateStr): string => (d === t ? 'today' : d === addDays(t, 1) ? 'tomorrow' : new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }));
  const conflicts = findConflicts(f.data, await conflictOptions(label)).flatMap((c) => (v.parent ? [{ key: c.key, kind: c.kind, date: c.date, text: c.text }] : c.kidText ? [{ key: c.key, kind: c.kind, date: c.date, text: c.kidText }] : []));
  const out: FamilyTimeline = {
    from,
    to,
    source: f.source,
    asOf: f.asOf,
    stale: f.stale,
    items: f.data.map((e) => ({ id: e.eventId, date: e.date, time: e.time, endTime: e.endTime, title: e.title, location: e.busy ? '' : e.location, people: e.people, from: e.from, busy: e.busy, pickup: e.pickup, pickupBy: e.pickupBy })),
    conflicts,
  };
  res.json(out);
});

/** Every household's connected calendars, read again; a sync that finds something new wakes the watch. */
export async function syncAllSources(): Promise<number> {
  const { rows } = await asSystem(() => pool.query<{ id: number; household_id: number }>('SELECT id, household_id FROM calendar_sources WHERE last_synced_at IS NULL OR last_synced_at < $1 ORDER BY household_id, id', [new Date(Date.now() - 25 * 60_000)]));
  const byHousehold = new Map<number, number[]>();
  for (const r of rows) byHousehold.set(r.household_id, [...(byHousehold.get(r.household_id) ?? []), r.id]);
  for (const [hh, ids] of byHousehold) {
    await inHousehold(hh, async () => {
      for (const id of ids) await syncSource(id).catch((e) => console.error('calendar-sources', id, e));
      await runWatch(new Date()).catch(() => undefined);
    }).catch((e) => console.error('calendar-sources', hh, e));
  }
  return rows.length;
}

registerJob({ name: 'calendar-sources', everyMs: 30 * 60 * 1000, run: async () => void (await syncAllSources()) });
