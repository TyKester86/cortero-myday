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
 * H5: GET/PUT /api/hana/settings — parents: quiet hours, thresholds, mutes, quiet her.
 *     The watch runs every 15 minutes per household (job hana-watch).
 * H9: GET /api/hana/report?month=YYYY-MM — parents only, wins and where Hana was wrong.
 * H6: PATCH /api/hana/actions/:id — edit a drafted note before it goes (the proposer only).
 *     POST /api/hana/alerts/:id/draft — a kind check-in drafted from a homework escalation.
 *     GET /api/hana/notes, POST /api/hana/notes/:id/read — notes delivered to you, in the app.
 *     GET /api/hana/log — parents: what Hana prepared, who approved or discarded it, when.
 * H7 Stage 1: POST /api/hana/voice — push-to-talk audio in, the words heard out (nothing sent).
 * C4: GET/POST /api/hana/loops, POST /api/hana/loops/:id/(close|reopen|share) — open loops.
 */
import express, { Router, type Request } from 'express';
import type { DateStr } from '@myday/shared';
import { config } from '../config.js';
import { asSystem, inHousehold, pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, idParam } from '../lib/http.js';
import { self } from '../lib/members.js';
import { registerJob } from '../lib/schedulers.js';
import { requireParent, viewerOf } from '../lib/chief/scope.js';
import { balances, billsDue, choresFor, familyFor, feedInbox, healthFor, homeworkFor, scheduleFor } from '../lib/chief/tools.js';
import { briefFor, markItem, type BriefKind, type ItemOutcome } from '../lib/chief/brief.js';
import { familyReport, reportEmail } from '../lib/chief/needle.js';
import { sendMail } from '../lib/mail.js';
import { listMembers } from '../lib/members.js';
import { coachFor, coachTarget, dismissNudge, refreshEscalations, setStep } from '../lib/chief/coach.js';
import { runWatch, saveSettings, settingsOf } from '../lib/chief/watch.js';
import { auditLog, draftFromEscalation, editDraft, markNoteRead, notesFor } from '../lib/hana.js';
import { closeLoop, loopsFor, openLoop, reopenLoop, shareLoop } from '../lib/chief/loops.js';
import { logEvent } from '../lib/events.js';
import { rateLimiter } from '../lib/pin.js';
import { transcriber } from '../lib/transcribe.js';
import { requireAiConsent } from './account.js';

export const hqRouter = Router();
export const hanaVoiceRouter = Router();

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

hqRouter.get('/api/hana/settings', async (req, res) => {
  const v = viewerOf(self(req));
  requireParent(v, 'Hana’s settings');
  res.json(await settingsOf());
});

hqRouter.put('/api/hana/settings', async (req, res) => {
  const v = viewerOf(self(req));
  res.json(await saveSettings(v, req.body as Record<string, unknown>));
});

hqRouter.patch('/api/hana/actions/:id', async (req, res) => {
  res.json({ action: await editDraft(self(req), idParam(req.params.id), (req.body as { text?: unknown }).text) });
});

hqRouter.post('/api/hana/alerts/:id/draft', async (req, res) => {
  res.json({ action: await draftFromEscalation(self(req), idParam(req.params.id)) });
});

hqRouter.get('/api/hana/notes', async (req, res) => {
  res.json({ notes: await notesFor(self(req)) });
});

hqRouter.post('/api/hana/notes/:id/read', async (req, res) => {
  await markNoteRead(self(req), idParam(req.params.id));
  res.json({ ok: true });
});

hqRouter.get('/api/hana/log', async (req, res) => {
  res.json({ log: await auditLog(self(req)) });
});

hqRouter.get('/api/hana/loops', async (req, res) => {
  const v = viewerOf(self(req));
  res.json({ loops: await loopsFor(v, req.query.closed === '1' ? { closedSince: addDays(today(), -30) } : {}) });
});

hqRouter.post('/api/hana/loops', async (req, res) => {
  const v = viewerOf(self(req));
  requireParent(v, 'Adding a loop');
  const b = req.body as { what?: unknown; owedBy?: unknown; about?: unknown; due?: unknown; private?: unknown };
  if (typeof b.what !== 'string' || typeof b.owedBy !== 'string' || !b.owedBy.trim()) throw new HttpError(400, 'Say what it is and who owes it');
  const due = typeof b.due === 'string' && DATE.test(b.due) ? (b.due as DateStr) : null;
  const loop = await openLoop(v.me, { what: b.what, owedBy: b.owedBy, about: typeof b.about === 'string' ? b.about : null, due, source: 'manual', private: b.private === true });
  res.status(201).json({ loop });
});

for (const verb of ['close', 'reopen', 'share'] as const) {
  hqRouter.post(`/api/hana/loops/:id/${verb}`, async (req, res) => {
    const v = viewerOf(self(req));
    const id = idParam(req.params.id);
    const b = req.body as { note?: unknown; shared?: unknown };
    res.json({ loop: verb === 'close' ? await closeLoop(v, id, b.note) : verb === 'reopen' ? await reopenLoop(v, id) : await shareLoop(v, id, b.shared !== false) });
  });
}

// H7 Stage 1: only when someone holds the mic button (never always-listening); up to ~60 seconds.
const VOICE_MAX = 3 * 1024 * 1024;
const voiceLimit = rateLimiter(Number(process.env.VOICE_PER_HOUR) || 40, 60 * 60_000);
const AUDIO = /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)(;.*)?$/;
hanaVoiceRouter.post('/api/hana/voice', express.raw({ type: () => true, limit: VOICE_MAX }), async (req: Request, res) => {
  const me = self(req);
  // A child's voice goes to a transcription provider: under 13, a parent turns that on first.
  await requireAiConsent(me);
  const t = transcriber();
  if (!t) throw new HttpError(503, 'Talking to Hana needs a grown-up to finish setting it up');
  const mime = String(req.headers['content-type'] ?? '');
  if (!AUDIO.test(mime) && !(t.kind === 'stub' && mime.startsWith('text/plain'))) throw new HttpError(415, 'That isn’t audio Hana can hear');
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (audio.length < 16) throw new HttpError(400, 'Nothing was recorded — hold the button while you talk');
  if (!voiceLimit(String(me.id))) throw new HttpError(429, 'That’s a lot of talking — try again soon');
  const ext = (mime.match(/audio\/(\w+)/)?.[1] ?? 'webm').replace('x-m4a', 'm4a').replace('mpeg', 'mp3');
  const text = (await t.transcribe(audio, mime.split(';')[0] ?? 'audio/webm', `voice.${ext}`)).trim().slice(0, 2000);
  await logEvent('hana_voice', { chars: text.length }, me.id);
  res.json({ text });
});

/** The watch over every household, each inside its own scope. */
export async function runAllWatches(at: Date = new Date()): Promise<number> {
  const { rows } = await asSystem(() => pool.query<{ id: number }>("SELECT DISTINCT household_id AS id FROM household_members WHERE kind = 'adult' AND archived_at IS NULL"));
  for (const r of rows) {
    try {
      await inHousehold(r.id, () => runWatch(at));
    } catch (e) {
      console.error('hana-watch', r.id, e);
    }
  }
  return rows.length;
}

/** Dev/test only: run the watch for your household now ("as if" at a given time for quiet hours). */
hqRouter.post('/api/hana/run-watch', async (req, res) => {
  const v = viewerOf(self(req));
  requireParent(v, 'The watch');
  if (process.env.PUSH_STUB !== '1') throw new HttpError(404, 'Not found');
  const at = typeof req.query.at === 'string' && !Number.isNaN(Date.parse(req.query.at)) ? new Date(req.query.at) : new Date();
  res.json(await runWatch(at));
});

registerJob({ name: 'hana-watch', everyMs: 15 * 60 * 1000, run: async () => void (await runAllWatches()) });

/** H9: on the 1st (from 8 AM household time), last month's report goes to each parent's own email — once. */
export async function sendMonthlyReport(at: Date = new Date()): Promise<{ month: string; sent: number } | null> {
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (t: string): number => Number(local.find((p) => p.type === t)?.value);
  if (part('day') !== 1 || part('hour') < 8) return null;
  const y = part('year');
  const mo = part('month');
  const month = `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, '0')}`;
  const { rows: s } = await pool.query<{ sent: string | null }>('SELECT report_sent_month AS sent FROM hana_settings LIMIT 1');
  if (s[0]?.sent === month) return null;
  // Only a family Hana actually worked for that month gets a report.
  const { rows: active } = await pool.query("SELECT 1 FROM hana_items WHERE shown_on >= $1::date AND shown_on < ($1::date + interval '1 month') LIMIT 1", [`${month}-01`]);
  if (!active.length) return null;
  await pool.query(
    'INSERT INTO hana_settings (report_sent_month) VALUES ($1) ON CONFLICT (household_id) DO UPDATE SET report_sent_month = EXCLUDED.report_sent_month',
    [month],
  );
  let sent = 0;
  for (const p of (await listMembers()).filter((m) => m.kind === 'adult')) {
    const { rows } = await pool.query<{ email: string }>("SELECT email FROM users WHERE member_id = $1 AND email LIKE '%@%' LIMIT 1", [p.id]);
    if (!rows[0]) continue;
    const mail = reportEmail(await familyReport(viewerOf(p), month), config.publicUrl);
    if (await sendMail({ to: rows[0].email, ...mail }).catch(() => false)) sent++;
  }
  return { month, sent };
}

registerJob({
  name: 'hana-report',
  everyMs: 60 * 60 * 1000,
  run: async () => {
    const { rows } = await asSystem(() => pool.query<{ id: number }>("SELECT DISTINCT household_id AS id FROM household_members WHERE kind = 'adult' AND archived_at IS NULL"));
    for (const r of rows) await inHousehold(r.id, () => sendMonthlyReport()).catch((e) => console.error('hana-report', r.id, e));
  },
});

/** Dev/test only: send the monthly report "as if" at a given time. */
hqRouter.post('/api/hana/run-report', async (req, res) => {
  const v = viewerOf(self(req));
  requireParent(v, 'The family report');
  if (process.env.PUSH_STUB !== '1') throw new HttpError(404, 'Not found');
  const at = typeof req.query.at === 'string' && !Number.isNaN(Date.parse(req.query.at)) ? new Date(req.query.at) : new Date();
  res.json(await sendMonthlyReport(at));
});
