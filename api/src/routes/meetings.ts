/**
 * Meetings (grown-ups only): record on the phone (offline-first, the same
 * capture as lectures) → upload → transcribe (lib/transcribe.ts) → AI notes
 * (lib/meetingnotes.ts) → one tap turns an action item into a task with a
 * reminder.
 *
 * Private: only the person who recorded a meeting can see it — not another
 * grown-up, never a kid. The audio stays on the server until the notes are
 * made, so a failed transcription or notes step can be retried; nothing is lost.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Router, type Request } from 'express';
import type { DateStr, Meeting, MeetingNotes, MeetingSummary } from '@myday/shared';
import { detached, inHousehold, pool } from '../db.js';
import { localToInstant, today, addDays } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { meetingNotes } from '../lib/meetingnotes.js';
import { requireAdult } from '../lib/members.js';
import { currentKeyId, openText, sealText } from '../lib/seal.js';
import { transcriber } from '../lib/transcribe.js';

export const meetingsRouter = Router();
export const meetingUploadRouter = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads');
const MAX_AUDIO = 25 * 1024 * 1024; // the transcription API's limit (about 2 hours at the phone's bitrate)
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a' };
const PER_DAY = (): number => Number(process.env.MEETINGS_PER_DAY) || 12;

interface Row {
  id: number;
  member_id: number;
  title: string;
  title_edited: boolean;
  recorded_at: Date;
  duration_s: number;
  status: Meeting['status'];
  error: string;
  audio_path: string | null;
  audio_mime: string;
  transcript_enc: Buffer | null;
  notes_enc: Buffer | null;
  key_id: string;
}

const summary = (r: Row): MeetingSummary => ({ id: r.id, title: r.title || 'Meeting', recordedAt: r.recorded_at.toISOString(), durationS: r.duration_s, status: r.status });
const notesOf = (r: Row): MeetingNotes | null => (r.notes_enc ? (JSON.parse(openText(r.notes_enc, r.key_id)) as MeetingNotes) : null);

async function row(id: number, memberId: number): Promise<Row> {
  const { rows } = await pool.query<Row>('SELECT * FROM meetings WHERE id = $1 AND member_id = $2', [id, memberId]);
  if (!rows[0]) throw new HttpError(404, 'No such meeting');
  return rows[0];
}

function view(r: Row): Meeting {
  return { ...summary(r), error: r.error, notes: notesOf(r), transcript: r.transcript_enc ? openText(r.transcript_enc, r.key_id) : null, audioKept: !!r.audio_path };
}

const localDay = (d: Date): DateStr => {
  const s = d.toLocaleDateString('en-CA', { timeZone: process.env.TZ_HOUSEHOLD || 'America/Chicago' });
  return (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : today()) as DateStr;
};

/** Background: transcribe (unless we already have the transcript), then notes. Failures keep the audio. */
async function processMeeting(householdId: number, id: number): Promise<void> {
  await inHousehold(householdId, async () => {
    const { rows } = await pool.query<Row>('SELECT * FROM meetings WHERE id = $1', [id]);
    const m = rows[0];
    if (!m) return;
    try {
      let transcript = m.transcript_enc ? openText(m.transcript_enc, m.key_id) : '';
      if (!transcript) {
        if (!m.audio_path) throw new HttpError(410, 'The recording is no longer on the server');
        const t = transcriber();
        if (!t) throw new HttpError(503, 'Transcription isn’t set up on this server yet (TRANSCRIPTION_KEY) — your recording is kept.');
        await pool.query("UPDATE meetings SET status = 'transcribing', error = '' WHERE id = $1", [id]);
        transcript = (await t.transcribe(await readFile(m.audio_path), m.audio_mime, path.basename(m.audio_path))).trim();
        if (!transcript) throw new HttpError(422, 'No speech was found in the recording');
        await pool.query("UPDATE meetings SET status = 'structuring', transcript_enc = $2 WHERE id = $1", [id, sealText(transcript, m.key_id)]);
      } else {
        await pool.query("UPDATE meetings SET status = 'structuring', error = '' WHERE id = $1", [id]);
      }
      const notes = await meetingNotes(transcript, localDay(m.recorded_at));
      await pool.query(
        "UPDATE meetings SET status = 'ready', notes_enc = $2, title = CASE WHEN title_edited THEN title ELSE $3 END, audio_path = NULL, error = '' WHERE id = $1",
        [id, sealText(JSON.stringify(notes), m.key_id), notes.title.slice(0, 120)],
      );
      // Private by default: the audio itself isn't kept once the notes exist.
      if (m.audio_path) await unlink(m.audio_path).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : 'Something went wrong making notes — your recording is kept; try again.';
      if (!(e instanceof HttpError)) console.error('meeting processing failed', e);
      await pool.query("UPDATE meetings SET status = 'failed', error = $2 WHERE id = $1", [id, msg]);
    }
  });
}

/** Raw audio upload (mounted before the JSON parser), streamed to disk. */
meetingUploadRouter.post('/api/meetings/upload', async (req: Request, res) => {
  if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
  if (!req.user || !req.member || !req.householdId) throw new HttpError(401, 'Not signed in');
  if (req.member.kind !== 'adult') throw new HttpError(403, 'Meetings are for grown-ups');
  const me = req.member;
  const householdId = req.householdId;
  const durationS = int(req.query.durationS ?? 0, 'durationS', 0, 6 * 3600);
  if (Number(req.headers['content-length'] ?? 0) > MAX_AUDIO) throw new HttpError(413, 'That recording is too big to upload (25 MB max — about 2 hours).');
  // A retried upload (same phone id) returns the meeting it already made.
  const clientId = typeof req.query.clientId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(req.query.clientId) ? req.query.clientId : null;
  if (clientId) {
    const { rows: dup } = await pool.query<Row>('SELECT * FROM meetings WHERE member_id = $1 AND client_id = $2', [me.id, clientId]);
    if (dup[0]) {
      res.status(200).json({ meeting: view(dup[0]) });
      return;
    }
  }
  const { rows: n } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM meetings WHERE member_id = $1 AND created_at > now() - interval '1 day'", [me.id]);
  if ((n[0]?.n ?? 0) >= PER_DAY()) throw new HttpError(429, 'That’s a lot of meetings today — the rest can wait until tomorrow.', 'daily_limit');
  const mime = (req.headers['content-type'] ?? 'audio/webm').split(';')[0] ?? 'audio/webm';
  const dir = path.join(UPLOAD_DIR, String(householdId), 'meetings');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.${EXT[mime] ?? 'webm'}`);
  let size = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          done(size > MAX_AUDIO ? new HttpError(413, 'That recording is too big to upload (25 MB max — about 2 hours).') : null, chunk);
        },
      }),
      createWriteStream(file),
    );
  } catch (e) {
    await unlink(file).catch(() => undefined);
    throw e;
  }
  if (size < 10) {
    await unlink(file).catch(() => undefined);
    throw new HttpError(400, 'The recording was empty');
  }
  // Recorded offline and uploaded later: keep when it was actually recorded (up to 2 weeks back).
  const at = typeof req.query.recordedAt === 'string' ? new Date(Number(req.query.recordedAt)) : new Date();
  const recordedAt = !Number.isNaN(at.getTime()) && at.getTime() <= Date.now() + 60_000 && at.getTime() > Date.now() - 14 * 86_400_000 ? at : new Date();
  const { rows } = await pool.query<Row>(
    'INSERT INTO meetings (member_id, recorded_at, duration_s, audio_path, audio_mime, key_id, client_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
    [me.id, recordedAt, durationS, file, mime, currentKeyId(), clientId],
  );
  const m = rows[0];
  if (!m) throw new Error('meeting insert returned nothing');
  await logEvent('meeting_recorded', { seconds: durationS }, me.id);
  detached(() => processMeeting(householdId, m.id));
  res.status(201).json({ meeting: view(m) });
});

/** History, newest first. ?q= searches titles, notes and transcripts (decrypted here, never in SQL). */
meetingsRouter.get('/api/meetings', async (req, res) => {
  const me = requireAdult(req);
  const { rows } = await pool.query<Row>('SELECT * FROM meetings WHERE member_id = $1 ORDER BY recorded_at DESC LIMIT 300', [me.id]);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const hits = q
    ? rows.filter((r) => {
        const n = notesOf(r);
        const hay = [r.title, n?.summary, ...(n?.decisions ?? []), ...(n?.actionItems ?? []).map((a) => `${a.task} ${a.owner ?? ''}`), ...(n?.followUps ?? []), r.transcript_enc ? openText(r.transcript_enc, r.key_id) : '']
          .join('\n')
          .toLowerCase();
        return q.split(/\s+/).every((w) => hay.includes(w));
      })
    : rows;
  res.json({ meetings: hits.map(summary) });
});

meetingsRouter.get('/api/meetings/:id', async (req, res) => {
  const me = requireAdult(req);
  res.json(view(await row(idParam(req.params.id), me.id)));
});

/** Rename (the AI's suggestion is just a start). */
meetingsRouter.patch('/api/meetings/:id', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  await row(id, me.id);
  const title = str((req.body as { title?: unknown }).title, 'title', 120, true);
  await pool.query('UPDATE meetings SET title = $2, title_edited = true WHERE id = $1', [id, title]);
  res.json(view(await row(id, me.id)));
});

/** Try a failed transcription / notes step again (the audio was kept). */
meetingsRouter.post('/api/meetings/:id/retry', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  const m = await row(id, me.id);
  if (m.status !== 'failed') throw new HttpError(409, 'Only a meeting that didn’t finish can be retried');
  if (!m.audio_path && !m.transcript_enc) throw new HttpError(410, 'The recording is no longer on the server');
  await pool.query("UPDATE meetings SET status = 'uploaded', error = '' WHERE id = $1", [id]);
  const hh = req.householdId;
  if (!hh) throw new HttpError(409, 'No household');
  detached(() => processMeeting(hh, id));
  res.json(view(await row(id, me.id)));
});

/** One tap: an action item becomes a task (on its due day, or today) with a reminder push at 9:00. */
meetingsRouter.post('/api/meetings/:id/actions/:idx/task', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  const m = await row(id, me.id);
  const notes = notesOf(m);
  const idx = Number(req.params.idx);
  const item = notes?.actionItems[idx];
  if (!notes || !item || !Number.isInteger(idx)) throw new HttpError(404, 'No such action item');
  if (item.taskId) throw new HttpError(409, 'Already in your tasks');
  const t = today();
  const day = item.due && item.due >= t ? item.due : t;
  const text = `${item.task}${item.owner ? ` (${item.owner})` : ''}`.slice(0, 200);
  const { rows } = await pool.query<{ id: number }>(
    "INSERT INTO tasks (member_id, day, task, priority, energy, context) VALUES ($1, $2, $3, 'Important', 'Low Brain', $4) RETURNING id",
    [me.id, day, text, `From the meeting “${(m.title || 'Meeting').slice(0, 60)}”`],
  );
  const taskId = rows[0]?.id ?? null;
  // The reminder: 9:00 on the due day, or tomorrow at 9:00 when there's no due date (or it's today and 9:00 has passed).
  let at = localToInstant(day, '09:00');
  if (at.getTime() <= Date.now()) at = localToInstant(addDays(t, 1), '09:00');
  await pool.query('INSERT INTO hana_reminders (member_id, text, remind_at) VALUES ($1, $2, $3)', [me.id, `Meeting follow-up: ${item.task}`.slice(0, 200), at]);
  notes.actionItems[idx] = { ...item, taskId };
  await pool.query('UPDATE meetings SET notes_enc = $2 WHERE id = $1', [id, sealText(JSON.stringify(notes), m.key_id)]);
  res.json({ meeting: view(await row(id, me.id)), taskId, day, remindAt: at.toISOString() });
});

meetingsRouter.delete('/api/meetings/:id', async (req, res) => {
  const me = requireAdult(req);
  const id = idParam(req.params.id);
  const m = await row(id, me.id);
  if (m.audio_path) await unlink(m.audio_path).catch(() => undefined);
  await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
  res.json({ ok: true });
});
