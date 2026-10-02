/**
 * Lecture capture + study library.
 *
 *   record → upload (≤25 MB audio) → transcribe → structured notes →
 *   flashcards + detected assignments → study (Leitner flashcards, quiz
 *   history, tutor quizzing) — all filed under the class, never expiring.
 *
 * Private by default: lectures and notes are visible only to the student
 * who recorded them. Audio is deleted once it's transcribed.
 * Scaffold: from a class's 3rd lecture the student drafts the summary first,
 * and from the 6th the key points, BEFORE the AI notes are revealed.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request } from 'express';
import type {
  DateStr,
  DetectedAssignment,
  Flashcard,
  HouseholdMember,
  Lecture,
  LectureNotes,
  LectureStatus,
  LectureSummary,
  ScaffoldPart,
  StudyView,
  UploadLectureResponse,
} from '@myday/shared';
import { detached, inHousehold, pool, tx } from '../db.js';
import { today } from '../lib/dates.js';
import { logEvent } from '../lib/events.js';
import { bool, HttpError, idParam, int, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { structureLecture } from '../lib/lecturenotes.js';
import { transcriber } from '../lib/transcribe.js';
import { classesFor } from './school.js';

export const lecturesRouter = Router();
export const lectureUploadRouter = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'uploads');
const MAX_AUDIO = 25 * 1024 * 1024; // the transcription API's limit
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-m4a': 'm4a' };

interface LectureRow {
  id: number;
  member_id: number;
  class_id: number;
  class_name: string;
  title: string;
  recorded_on: DateStr;
  duration_s: number;
  status: LectureStatus;
  error: string;
  notes: LectureNotes | null;
  scaffold: Lecture['scaffold'];
  revealed: boolean;
}

const SELECT = `SELECT l.id, l.member_id, l.class_id, c.name AS class_name, l.title, l.recorded_on::text AS recorded_on, l.duration_s,
  l.status, l.error, l.notes, l.scaffold, l.revealed FROM lectures l JOIN classes c ON c.id = l.class_id`;

async function lectureView(id: number, memberId: number): Promise<Lecture> {
  const { rows } = await pool.query<LectureRow>(`${SELECT} WHERE l.id = $1 AND l.member_id = $2`, [id, memberId]);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'No such lecture');
  const { rows: d } = await pool.query<{ part: ScaffoldPart; draft: string }>('SELECT part, draft FROM note_drafts WHERE lecture_id = $1', [id]);
  const { rows: a } = await pool.query<{ id: number; title: string; due: DateStr | null; homework_id: number | null; dismissed: boolean }>(
    'SELECT id, title, due::text AS due, homework_id, dismissed FROM lecture_assignments WHERE lecture_id = $1 ORDER BY id',
    [id],
  );
  const { rows: n } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM flashcards WHERE lecture_id = $1', [id]);
  const drafts: Lecture['drafts'] = {};
  for (const x of d) drafts[x.part] = x.draft;
  return {
    id: r.id,
    classId: r.class_id,
    className: r.class_name,
    title: r.title,
    recordedOn: r.recorded_on,
    durationS: r.duration_s,
    status: r.status,
    error: r.error,
    notes: r.scaffold !== 'none' && !r.revealed ? null : r.notes,
    scaffold: r.scaffold,
    revealed: r.revealed,
    drafts,
    assignments: a.map((x): DetectedAssignment => ({ id: x.id, title: x.title, due: x.due, homeworkId: x.homework_id, dismissed: x.dismissed })),
    cardCount: n[0]?.n ?? 0,
  };
}

/** Background: transcribe, structure, file flashcards + assignments. */
async function processLecture(householdId: number, lectureId: number, age: number | null): Promise<void> {
  await inHousehold(householdId, async () => {
    const { rows } = await pool.query<{ audio_path: string | null; class_name: string; recorded_on: DateStr; member_id: number; class_id: number }>(
      `SELECT l.audio_path, c.name AS class_name, l.recorded_on::text AS recorded_on, l.member_id, l.class_id
         FROM lectures l JOIN classes c ON c.id = l.class_id WHERE l.id = $1`,
      [lectureId],
    );
    const lec = rows[0];
    if (!lec?.audio_path) return;
    try {
      const t = transcriber();
      if (!t) throw new HttpError(503, 'Transcription is not set up on the server (TRANSCRIPTION_KEY)');
      await pool.query("UPDATE lectures SET status = 'transcribing' WHERE id = $1", [lectureId]);
      const audio = await readFile(lec.audio_path);
      const text = await t.transcribe(audio, 'audio/webm', path.basename(lec.audio_path));
      if (!text.trim()) throw new HttpError(422, 'No speech found in the recording');
      await pool.query("UPDATE lectures SET status = 'structuring', transcript = $2 WHERE id = $1", [lectureId, text]);
      const s = await structureLecture(text, { className: lec.class_name, recordedOn: lec.recorded_on, age });
      await tx(async (c) => {
        const notes: LectureNotes = { title: s.title, summary: s.summary, sections: s.sections, keyPoints: s.keyPoints, terms: s.terms };
        await c.query("UPDATE lectures SET status = 'ready', notes = $2, title = $3, audio_path = NULL, error = '' WHERE id = $1", [lectureId, JSON.stringify(notes), s.title.slice(0, 120)]);
        for (const f of s.flashcards.slice(0, 20)) {
          await c.query('INSERT INTO flashcards (member_id, class_id, lecture_id, front, back, explanation) VALUES ($1,$2,$3,$4,$5,$6)', [
            lec.member_id, lec.class_id, lectureId, f.front.slice(0, 300), f.back.slice(0, 600), f.explanation.slice(0, 600),
          ]);
        }
        for (const a of s.assignments.slice(0, 10)) {
          await c.query('INSERT INTO lecture_assignments (lecture_id, title, due) VALUES ($1, $2, $3)', [lectureId, a.title.slice(0, 120), a.due]);
        }
      });
      // Private by default: the audio itself is not kept once it's turned into notes.
      await unlink(lec.audio_path).catch(() => undefined);
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : 'Processing failed';
      if (!(e instanceof HttpError)) console.error('lecture processing failed', e);
      await pool.query("UPDATE lectures SET status = 'failed', error = $2 WHERE id = $1", [lectureId, msg]);
    }
  });
}

/** Raw audio upload (mounted before the JSON parser). */
lectureUploadRouter.post(
  '/api/lectures/upload',
  express.raw({ type: ['audio/*', 'video/webm', 'application/octet-stream'], limit: MAX_AUDIO }),
  async (req: Request, res) => {
    if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
    if (!req.user || !req.member || !req.householdId) throw new HttpError(401, 'Not signed in');
    const me = req.member;
    const householdId = req.householdId;
    const { rows: ack } = await pool.query<{ ok: boolean }>('SELECT recording_ack_at IS NOT NULL AS ok FROM household_members WHERE id = $1', [me.id]);
    if (!ack[0]?.ok) throw new HttpError(409, 'First check your school’s recording policy and get permission (one-time screen).');
    const classId = idParam(req.query.classId);
    const durationS = int(req.query.durationS ?? 0, 'durationS', 0, 6 * 3600);
    const { rows: cls } = await pool.query<{ id: number }>('SELECT id FROM classes WHERE id = $1 AND member_id = $2', [classId, me.id]);
    if (!cls[0]) throw new HttpError(404, 'Pick one of your classes');
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length < 10) throw new HttpError(400, 'The recording was empty');
    const mime = (req.headers['content-type'] ?? 'audio/webm').split(';')[0] ?? 'audio/webm';
    const dir = path.join(UPLOAD_DIR, String(householdId));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${randomUUID()}.${EXT[mime] ?? 'webm'}`);
    await writeFile(file, body);
    const t = today();
    // Scaffold by how many lectures this class already has.
    const { rows: prior } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM lectures WHERE class_id = $1 AND status <> 'failed'", [classId]);
    const n = prior[0]?.n ?? 0;
    const scaffold = n >= 5 ? 'key_points' : n >= 2 ? 'summary' : 'none';
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO lectures (member_id, class_id, recorded_on, duration_s, audio_path, scaffold, revealed)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [me.id, classId, t, durationS, file, scaffold, scaffold === 'none'],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('lecture insert returned nothing');
    await logEvent('lecture_recorded', { seconds: durationS, scaffold }, me.id);
    detached(() => processLecture(householdId, id, me.age));
    const out: UploadLectureResponse = { lecture: await lectureView(id, me.id) };
    res.status(201).json(out);
  },
);

/** One-time: "I checked my school's recording policy / got permission." */
lecturesRouter.post('/api/lectures/ack', async (req, res) => {
  const me = self(req);
  await pool.query('UPDATE household_members SET recording_ack_at = COALESCE(recording_ack_at, now()) WHERE id = $1', [me.id]);
  res.json({ ok: true });
});

lecturesRouter.get('/api/lectures', async (req, res) => {
  const me = self(req);
  const { rows } = await pool.query<LectureRow>(`${SELECT} WHERE l.member_id = $1 ORDER BY l.id DESC LIMIT 50`, [me.id]);
  res.json({ lectures: rows.map((r): LectureSummary => ({ id: r.id, classId: r.class_id, title: r.title, recordedOn: r.recorded_on, durationS: r.duration_s, status: r.status })) });
});

lecturesRouter.get('/api/lectures/:id', async (req, res) => {
  res.json(await lectureView(idParam(req.params.id), self(req).id));
});

/** Scaffold: the student's own draft first; the AI notes are revealed after. */
lecturesRouter.post('/api/lectures/:id/draft', async (req, res) => {
  const me = self(req);
  const id = idParam(req.params.id);
  const b = req.body as Record<string, unknown>;
  const part: ScaffoldPart = b.part === 'key_points' ? 'key_points' : 'summary';
  const draft = str(b.draft, 'draft', 4000, true);
  const lec = await lectureView(id, me.id);
  if (lec.scaffold === 'none') throw new HttpError(409, 'This lecture has no draft step');
  await pool.query(
    `INSERT INTO note_drafts (lecture_id, member_id, part, draft) VALUES ($1, $2, $3, $4)
     ON CONFLICT (lecture_id, part) DO UPDATE SET draft = EXCLUDED.draft`,
    [id, me.id, part, draft],
  );
  if (part === lec.scaffold) await pool.query('UPDATE lectures SET revealed = true WHERE id = $1', [id]);
  res.json(await lectureView(id, me.id));
});

/** Detected assignment → Homework (kids) or the school assignment list (students). */
lecturesRouter.post('/api/lectures/:id/assignments/:aid/add', async (req, res) => {
  const me = self(req);
  const id = idParam(req.params.id);
  const lec = await lectureView(id, me.id);
  const a = lec.assignments.find((x) => x.id === idParam(req.params.aid));
  if (!a) throw new HttpError(404, 'No such assignment');
  if (a.homeworkId) throw new HttpError(409, 'Already added');
  if (me.kind === 'kid') {
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO homework (member_id, assignment, subject, due, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [me.id, a.title, lec.className, a.due, req.user?.id ?? null],
    );
    await pool.query('UPDATE lecture_assignments SET homework_id = $2 WHERE id = $1', [a.id, rows[0]?.id ?? null]);
  } else {
    await pool.query('INSERT INTO assignments (member_id, class_id, name, due, created_on) VALUES ($1, $2, $3, $4, $5)', [me.id, lec.classId, a.title.slice(0, 80), a.due, today()]);
    await pool.query('UPDATE lecture_assignments SET dismissed = true WHERE id = $1', [a.id]);
  }
  res.json(await lectureView(id, me.id));
});

lecturesRouter.post('/api/lectures/:id/assignments/:aid/dismiss', async (req, res) => {
  const me = self(req);
  const id = idParam(req.params.id);
  await lectureView(id, me.id);
  await pool.query('UPDATE lecture_assignments SET dismissed = true WHERE id = $1 AND lecture_id = $2', [idParam(req.params.aid), id]);
  res.json(await lectureView(id, me.id));
});

/* ---------- the per-class study view ---------- */

async function studyView(me: HouseholdMember, classId: number): Promise<StudyView> {
  const cls = (await classesFor(me.id)).find((c) => c.id === classId);
  if (!cls) throw new HttpError(404, 'No such class');
  const { rows: l } = await pool.query<LectureRow>(`${SELECT} WHERE l.class_id = $1 AND l.member_id = $2 ORDER BY l.recorded_on DESC, l.id DESC`, [classId, me.id]);
  const { rows: cards } = await pool.query<{ id: number; lecture_id: number | null; front: string; back: string; explanation: string; box: number }>(
    'SELECT id, lecture_id, front, back, explanation, box FROM flashcards WHERE class_id = $1 AND member_id = $2 ORDER BY box, id',
    [classId, me.id],
  );
  const { rows: q } = await pool.query<{ date: DateStr; correct: number; total: number }>(
    `SELECT at::date::text AS date, COUNT(*) FILTER (WHERE correct)::int AS correct, COUNT(*)::int AS total
       FROM quiz_attempts WHERE class_id = $1 AND member_id = $2 GROUP BY at::date ORDER BY at::date DESC LIMIT 14`,
    [classId, me.id],
  );
  const tot = q.reduce((s, x) => s + x.total, 0);
  return {
    cls,
    lectures: l.map((r): LectureSummary => ({ id: r.id, classId: r.class_id, title: r.title, recordedOn: r.recorded_on, durationS: r.duration_s, status: r.status })),
    cards: cards.map((c): Flashcard => ({ id: c.id, lectureId: c.lecture_id, front: c.front, back: c.back, explanation: c.explanation, box: c.box })),
    quiz: q,
    accuracy: tot ? Math.round((q.reduce((s, x) => s + x.correct, 0) / tot) * 100) : null,
  };
}

lecturesRouter.get('/api/study/:classId', async (req, res) => {
  res.json(await studyView(self(req), idParam(req.params.classId)));
});

/** Add your own flashcard to a class. */
lecturesRouter.post('/api/study/:classId/cards', async (req, res) => {
  const me = self(req);
  const classId = idParam(req.params.classId);
  const b = req.body as Record<string, unknown>;
  await studyView(me, classId);
  await pool.query('INSERT INTO flashcards (member_id, class_id, front, back, explanation) VALUES ($1,$2,$3,$4,$5)', [
    me.id, classId, str(b.front, 'front', 300, true), str(b.back, 'back', 600, true), str(b.explanation, 'explanation', 600),
  ]);
  res.status(201).json(await studyView(me, classId));
});

/** Quiz answer: right moves the card up a box (max 5), wrong sends it back to box 1. */
lecturesRouter.post('/api/study/cards/:id/answer', async (req, res) => {
  const me = self(req);
  const id = idParam(req.params.id);
  const correct = bool((req.body as { correct?: unknown }).correct, 'correct');
  const { rows } = await pool.query<{ class_id: number }>(
    `UPDATE flashcards SET box = CASE WHEN $3 THEN LEAST(5, box + 1) ELSE 1 END WHERE id = $1 AND member_id = $2 RETURNING class_id`,
    [id, me.id, correct],
  );
  const classId = rows[0]?.class_id;
  if (classId === undefined) throw new HttpError(404, 'No such card');
  await pool.query('INSERT INTO quiz_attempts (member_id, class_id, card_id, correct) VALUES ($1, $2, $3, $4)', [me.id, classId, id, correct]);
  res.json(await studyView(me, classId));
});

/** For the tutor: the lecture material to quiz from (owner only). */
export async function lectureMaterial(memberId: number, lectureId: number): Promise<string> {
  const lec = await lectureView(lectureId, memberId);
  if (!lec.notes) return '';
  const n = lec.notes;
  const { rows: cards } = await pool.query<{ front: string; back: string }>('SELECT front, back FROM flashcards WHERE lecture_id = $1 ORDER BY id LIMIT 12', [lectureId]);
  return [
    `Lecture "${n.title}" (${lec.className}, ${lec.recordedOn}).`,
    `Summary: ${n.summary}`,
    `Key points: ${n.keyPoints.join(' | ')}`,
    `Terms: ${n.terms.map((t) => `${t.term} = ${t.definition}`).join(' | ')}`,
    `Flashcards: ${cards.map((c) => `Q: ${c.front} A: ${c.back}`).join(' | ')}`,
  ].join('\n');
}
