/**
 * School: classes (the per-class study library hangs off these), plus the
 * student academic engine ported from apiAdultSchool / AddClass / AddAssign /
 * DoneAssign / LogStudy / AddExam / LogExamPrep / AddCampus / CampusVisit —
 * same XP (assignment +20, study session +15, exam prep +15). Kids and
 * students use it; it's about the signed-in member (?member= for grown-ups).
 */
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import {
  WEEKDAYS,
  type Assignment,
  type CampusContact,
  type ClassInfo,
  type DateStr,
  type Exam,
  type SchoolResponse,
  type Weekday,
} from '@myday/shared';
import { pool } from '../db.js';
import { addDays, daysBetween, isoToWeekday, isoWeekday, today, weekdayToIso } from '../lib/dates.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { targetMember } from '../lib/members.js';
import { awardXpOnce, withEarn } from '../lib/xp.js';
import { config } from '../config.js';

export const schoolRouter = Router();

interface ClassRow {
  id: number;
  name: string;
  teacher: string;
  room: string;
  school: string;
  color: string;
  days: number[];
  start_time: string;
  source: 'manual' | 'classroom';
  lectures: number;
  cards: number;
}

export const toClass = (r: ClassRow): ClassInfo => ({
  id: r.id,
  name: r.name,
  teacher: r.teacher,
  room: r.room,
  school: r.school,
  color: r.color,
  days: [...r.days].sort((a, b) => a - b).map(isoToWeekday),
  startTime: r.start_time,
  source: r.source,
  lectureCount: r.lectures,
  cardCount: r.cards,
});

export async function classesFor(memberId: number): Promise<ClassInfo[]> {
  const { rows } = await pool.query<ClassRow>(
    `SELECT c.id, c.name, c.teacher, c.room, c.school, c.color, c.days, c.start_time, c.source,
            (SELECT COUNT(*) FROM lectures l WHERE l.class_id = c.id)::int AS lectures,
            (SELECT COUNT(*) FROM flashcards f WHERE f.class_id = c.id)::int AS cards
       FROM classes c WHERE c.member_id = $1 AND NOT c.archived ORDER BY c.start_time, c.id`,
    [memberId],
  );
  return rows.map(toClass);
}

const parseDays = (v: unknown): number[] =>
  Array.isArray(v) ? WEEKDAYS.filter((d) => v.includes(d)).map((d: Weekday) => weekdayToIso(d)) : [];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

async function schoolFor(memberId: number, member: SchoolResponse['member']): Promise<SchoolResponse> {
  const t = today();
  const classes = await classesFor(memberId);
  const { rows: a } = await pool.query<{ id: number; class_id: number | null; class_name: string | null; name: string; due: DateStr | null; priority: Assignment['priority'] }>(
    `SELECT a.id, a.class_id, c.name AS class_name, a.name, a.due::text AS due, a.priority
       FROM assignments a LEFT JOIN classes c ON c.id = a.class_id
      WHERE a.member_id = $1 AND NOT a.done ORDER BY a.due NULLS LAST, a.id`,
    [memberId],
  );
  const { rows: e } = await pool.query<{ id: number; name: string; course: string; exam_date: DateStr | null; prep_count: number }>(
    'SELECT id, name, course, exam_date::text AS exam_date, prep_count FROM exams WHERE member_id = $1 ORDER BY exam_date NULLS LAST, id',
    [memberId],
  );
  const { rows: cc } = await pool.query<{ id: number; name: string; kind: string; phone: string; email: string; notes: string; visits: number }>(
    `SELECT c.id, c.name, c.kind, c.phone, c.email, c.notes,
            (SELECT COUNT(*) FROM campus_visits v WHERE v.contact_id = c.id)::int AS visits
       FROM campus_contacts c WHERE c.member_id = $1 ORDER BY c.id`,
    [memberId],
  );
  const { rows: s } = await pool.query<{ today: number; week: number }>(
    `SELECT COALESCE(SUM(minutes) FILTER (WHERE day = $2), 0)::int AS today,
            COALESCE(SUM(minutes) FILTER (WHERE day > $3), 0)::int AS week
       FROM study_sessions WHERE member_id = $1`,
    [memberId, t, addDays(t, -7)],
  );
  const { rows: ack } = await pool.query<{ ack: boolean }>(
    'SELECT recording_ack_at IS NOT NULL AS ack FROM household_members WHERE id = $1',
    [memberId],
  );
  return {
    member,
    classes,
    todayClasses: classes.filter((c) => c.days.includes(isoToWeekday(isoWeekday(t)))),
    assignments: a.map(
      (r): Assignment => ({
        id: r.id,
        classId: r.class_id,
        className: r.class_name ?? '',
        name: r.name,
        due: r.due,
        priority: r.priority,
        overdue: r.due !== null && r.due < t,
        today: r.due === t,
      }),
    ),
    exams: e.map((r): Exam => ({ id: r.id, name: r.name, course: r.course, date: r.exam_date, daysLeft: r.exam_date ? daysBetween(t, r.exam_date) : null, prepCount: r.prep_count })),
    campus: cc.map((r): CampusContact => ({ ...r })),
    studyToday: s[0]?.today ?? 0,
    studyWeek: s[0]?.week ?? 0,
    recordingAcknowledged: ack[0]?.ack ?? false,
  };
}

schoolRouter.get('/api/school', async (req, res) => {
  const m = await targetMember(req);
  res.json(await schoolFor(m.id, m));
});

/* ---------- classes ---------- */

schoolRouter.post('/api/classes', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const start = str(b.startTime, 'startTime', 5);
  if (start && !TIME.test(start)) throw new HttpError(400, 'Start time must be HH:MM');
  const color = str(b.color, 'color', 7);
  await pool.query(
    `INSERT INTO classes (member_id, name, teacher, room, school, color, days, start_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [m.id, str(b.name, 'name', 60, true), str(b.teacher, 'teacher', 60), str(b.room, 'room', 40), str(b.school, 'school', 120),
      /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#2E4B8F', parseDays(b.days), start],
  );
  res.status(201).json(await schoolFor(m.id, m));
});

schoolRouter.patch('/api/classes/:id', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const id = idParam(req.params.id);
  const { rows } = await pool.query<ClassRow>('SELECT * FROM classes WHERE id = $1 AND member_id = $2', [id, m.id]);
  const cur = rows[0];
  if (!cur) throw new HttpError(404, 'No such class');
  const start = b.startTime === undefined ? cur.start_time : str(b.startTime, 'startTime', 5);
  if (start && !TIME.test(start)) throw new HttpError(400, 'Start time must be HH:MM');
  await pool.query(
    'UPDATE classes SET name = $3, teacher = $4, room = $5, days = $6, start_time = $7 WHERE id = $1 AND member_id = $2',
    [id, m.id, b.name === undefined ? cur.name : str(b.name, 'name', 60, true), b.teacher === undefined ? cur.teacher : str(b.teacher, 'teacher', 60),
      b.room === undefined ? cur.room : str(b.room, 'room', 40), b.days === undefined ? cur.days : parseDays(b.days), start],
  );
  res.json(await schoolFor(m.id, m));
});

/** Notes never expire: archiving hides a class from today's list but keeps its whole study library. */
schoolRouter.post('/api/classes/:id/archive', async (req, res) => {
  const m = await targetMember(req);
  await pool.query('UPDATE classes SET archived = true WHERE id = $1 AND member_id = $2', [idParam(req.params.id), m.id]);
  res.json(await schoolFor(m.id, m));
});

/* ---------- assignments, study, exams, campus (student engine) ---------- */

schoolRouter.post('/api/school/assignments', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const due = str(b.due, 'due', 10);
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400, 'due must be yyyy-MM-dd');
  const pri = b.priority === 'High' || b.priority === 'Low' ? b.priority : 'Medium';
  await pool.query(
    'INSERT INTO assignments (member_id, class_id, name, due, priority, created_on) VALUES ($1,$2,$3,$4,$5,$6)',
    [m.id, b.classId ? idParam(b.classId) : null, str(b.name, 'name', 80, true), due || null, pri, today()],
  );
  res.status(201).json(await schoolFor(m.id, m));
});

/** apiAdultDoneAssign: +20 XP. */
schoolRouter.post('/api/school/assignments/:id/done', async (req, res) => {
  const m = await targetMember(req);
  const id = idParam(req.params.id);
  const t = today();
  const { earn } = await withEarn(m.id, async () => {
    const r = await pool.query('UPDATE assignments SET done = true, done_on = $3 WHERE id = $1 AND member_id = $2 AND NOT done', [id, m.id, t]);
    if (r.rowCount) await awardXpOnce(m.id, t, 20, 'Complete an Assignment', `assign:${id}`);
  });
  res.json({ ...earn, school: await schoolFor(m.id, m) });
});

/** apiAdultLogStudy: +15 XP per session (minutes clamped 1–960, default 25). */
schoolRouter.post('/api/school/study', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const t = today();
  const { earn } = await withEarn(m.id, async () => {
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO study_sessions (member_id, class_id, subject, minutes, location, day) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [m.id, b.classId ? idParam(b.classId) : null, str(b.subject, 'subject', 60), int(b.minutes ?? 25, 'minutes', 1, 960), str(b.location, 'location', 60), t],
    );
    await awardXpOnce(m.id, t, 15, 'Log a Study Session', `study:${rows[0]?.id ?? t}`);
  });
  res.status(201).json({ ...earn, school: await schoolFor(m.id, m) });
});

schoolRouter.post('/api/school/exams', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  const date = str(b.date, 'date', 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date must be yyyy-MM-dd');
  await pool.query('INSERT INTO exams (member_id, name, course, exam_date) VALUES ($1,$2,$3,$4)', [m.id, str(b.name, 'name', 60, true), str(b.course, 'course', 60), date || null]);
  res.status(201).json(await schoolFor(m.id, m));
});

/** apiAdultLogExamPrep: +15 XP per prep session. */
schoolRouter.post('/api/school/exams/:id/prep', async (req, res) => {
  const m = await targetMember(req);
  const id = idParam(req.params.id);
  const t = today();
  const { earn } = await withEarn(m.id, async () => {
    const r = await pool.query<{ prep_count: number }>(
      'UPDATE exams SET prep_count = prep_count + 1 WHERE id = $1 AND member_id = $2 RETURNING prep_count',
      [id, m.id],
    );
    const n = r.rows[0]?.prep_count;
    if (n === undefined) throw new HttpError(404, 'No such exam');
    await awardXpOnce(m.id, t, 15, 'Exam Prep Session Logged', `examprep:${id}:${n}`);
  });
  res.json({ ...earn, school: await schoolFor(m.id, m) });
});

schoolRouter.delete('/api/school/exams/:id', async (req, res) => {
  const m = await targetMember(req);
  await pool.query('DELETE FROM exams WHERE id = $1 AND member_id = $2', [idParam(req.params.id), m.id]);
  res.json(await schoolFor(m.id, m));
});

schoolRouter.post('/api/school/campus', async (req, res) => {
  const m = await targetMember(req);
  const b = req.body as Record<string, unknown>;
  await pool.query('INSERT INTO campus_contacts (member_id, name, kind, phone, email, notes) VALUES ($1,$2,$3,$4,$5,$6)', [
    m.id, str(b.name, 'name', 60, true), str(b.kind, 'kind', 20) || 'Other', str(b.phone, 'phone', 30), str(b.email, 'email', 60), str(b.notes, 'notes', 200),
  ]);
  res.status(201).json(await schoolFor(m.id, m));
});

/** apiAdultCampusVisit: logs the visit (no XP in the script); feeds two achievements. */
schoolRouter.post('/api/school/campus/:id/visit', async (req, res) => {
  const m = await targetMember(req);
  const id = idParam(req.params.id);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM campus_contacts WHERE id = $1 AND member_id = $2', [id, m.id]);
  const c = rows[0];
  if (!c) throw new HttpError(404, 'No such contact');
  await pool.query('INSERT INTO campus_visits (member_id, contact_id, name, day) VALUES ($1,$2,$3,$4)', [m.id, id, c.name, today()]);
  res.json(await schoolFor(m.id, m));
});

schoolRouter.delete('/api/school/campus/:id', async (req, res) => {
  const m = await targetMember(req);
  await pool.query('DELETE FROM campus_contacts WHERE id = $1 AND member_id = $2', [idParam(req.params.id), m.id]);
  res.json(await schoolFor(m.id, m));
});

/* ---------- Google Classroom: import classes ---------- */

const CLASSROOM_SCOPE = 'https://www.googleapis.com/auth/classroom.courses.readonly';
const classroomRedirect = (): string => `${config.publicUrl}/api/classroom/callback`;

const FAKE_COURSES = [
  { id: 'fake-bio', name: 'Biology', section: 'Period 2', room: '214' },
  { id: 'fake-alg', name: 'Algebra II', section: 'Period 4', room: '108' },
  { id: 'fake-eng', name: 'English 10', section: 'Period 6', room: '301' },
];

async function importCourses(memberId: number, courses: Array<{ id: string; name: string; section?: string; room?: string }>): Promise<number> {
  let n = 0;
  for (const c of courses) {
    const r = await pool.query<{ inserted: boolean }>(
      `INSERT INTO classes (member_id, name, room, teacher, source, external_id) VALUES ($1, $2, $3, $4, 'classroom', $5)
       ON CONFLICT (member_id, external_id) WHERE external_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name, room = EXCLUDED.room
       RETURNING (xmax = 0) AS inserted`,
      [memberId, c.name.slice(0, 60), (c.room ?? '').slice(0, 40), (c.section ?? '').slice(0, 60), c.id],
    );
    // Only new classes count as imported; a reconnect just refreshes names/rooms.
    if (r.rows[0]?.inserted) n++;
  }
  return n;
}

/**
 * Connect Google Classroom. With CLASSROOM_PROVIDER=fake (local proof, never
 * production) three sample courses import directly; otherwise this returns
 * the Google consent URL (read-only course list scope).
 */
schoolRouter.post('/api/classroom/connect', async (req, res) => {
  const m = await targetMember(req);
  if (process.env.CLASSROOM_PROVIDER === 'fake' && !config.production) {
    const n = await importCourses(m.id, FAKE_COURSES);
    res.json({ imported: n, authUrl: null, school: await schoolFor(m.id, m) });
    return;
  }
  if (!config.googleClientId) throw new HttpError(503, 'Google sign-in is not configured');
  const state = `${m.id}.${randomBytes(18).toString('base64url')}`;
  req.session.oauthState = state;
  const q = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: classroomRedirect(),
    response_type: 'code',
    scope: CLASSROOM_SCOPE,
    state,
    include_granted_scopes: 'true',
    prompt: 'consent',
  });
  req.session.save(() => res.json({ imported: 0, authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}` }));
});

schoolRouter.get('/api/classroom/callback', async (req, res) => {
  const { code, state } = req.query;
  const expected = req.session.oauthState;
  if (typeof code !== 'string' || typeof state !== 'string' || state !== expected) {
    res.redirect('/school?classroom=error');
    return;
  }
  const memberId = Number(state.split('.')[0]);
  if (!req.member || req.member.id !== memberId) {
    res.redirect('/school?classroom=error');
    return;
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: classroomRedirect(), grant_type: 'authorization_code' }),
  });
  const tok: unknown = await tokenRes.json();
  const access = typeof tok === 'object' && tok !== null && typeof (tok as Record<string, unknown>).access_token === 'string' ? ((tok as Record<string, unknown>).access_token as string) : '';
  if (!tokenRes.ok || !access) {
    res.redirect('/school?classroom=error');
    return;
  }
  const cr = await fetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE&pageSize=50', { headers: { Authorization: `Bearer ${access}` } });
  const data: unknown = await cr.json();
  const list = typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).courses) ? ((data as Record<string, unknown>).courses as unknown[]) : [];
  const courses = list
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({ id: String(c.id ?? ''), name: String(c.name ?? 'Class'), section: String(c.section ?? ''), room: String(c.room ?? '') }))
    .filter((c) => c.id);
  const n = await importCourses(memberId, courses);
  // The access token is used once and never stored.
  res.redirect(`/school?classroom=${n}`);
});
