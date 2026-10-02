/**
 * Records (A4 parity with the script's record-keeping): one history view over
 * everything a grown-up logs — check-ins, evening reviews, workouts, brain
 * dumps, money check-ins, study sessions, partner check-ins, 1-on-1s and
 * restarts — newest first, filterable by kind, searchable, and exportable
 * as CSV.
 */
import { Router } from 'express';
import type { DateStr } from '@myday/shared';
import { pool } from '../db.js';
import { addDays, today } from '../lib/dates.js';
import { HttpError, int } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';

export const recordsRouter = Router();

export const RECORD_KINDS = ['checkin', 'review', 'workout', 'note', 'money', 'study', 'partner', 'one_on_one', 'restart'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface RecordRow {
  kind: RecordKind;
  date: DateStr;
  title: string;
  detail: string;
}

const QUERIES: Record<RecordKind, string> = {
  checkin: `SELECT 'checkin' AS kind, day::text AS date, 'Morning check-in' AS title,
    concat_ws(' · ', nullif('Nervous system: ' || nervous, 'Nervous system: '), nullif('Sleep: ' || sleep, 'Sleep: '),
              nullif('Fuel: ' || fuel, 'Fuel: '), nullif('Grateful: ' || grateful, 'Grateful: ')) AS detail
    FROM checkins WHERE member_id = $1 AND day >= $2`,
  review: `SELECT 'review' AS kind, day::text AS date, 'Evening review' AS title,
    concat_ws(' · ', nullif('Got done: ' || got, 'Got done: '), nullif('Derailed: ' || derailed, 'Derailed: '),
              nullif('Tomorrow: ' || tomorrow, 'Tomorrow: '), nullif('Energy: ' || energy_end, 'Energy: ')) AS detail
    FROM reviews WHERE member_id = $1 AND day >= $2`,
  workout: `SELECT 'workout' AS kind, logged_on::text AS date,
    CASE kind WHEN 'session' THEN activity WHEN 'day_complete' THEN 'Workout complete: ' || day_name ELSE exercise END AS title,
    CASE kind WHEN 'session' THEN minutes || ' min' WHEN 'exercise' THEN concat_ws(' · ', sets || ' sets', nullif(reps, ''), nullif(weight, '')) ELSE phase_name END AS detail
    FROM workout_logs WHERE member_id = $1 AND logged_on >= $2`,
  note: `SELECT 'note' AS kind, captured_on::text AS date, 'Note' AS title, note AS detail
    FROM dump_items WHERE member_id = $1 AND captured_on >= $2`,
  money: `SELECT 'money' AS kind, day::text AS date, 'Money check-in' AS title, 'Anxiety: ' || anxiety AS detail
    FROM money_checkins WHERE member_id = $1 AND day >= $2`,
  study: `SELECT 'study' AS kind, s.day::text AS date, 'Study: ' || COALESCE(c.name, nullif(s.subject, ''), 'session') AS title,
    concat_ws(' · ', s.minutes || ' min', nullif(s.location, '')) AS detail
    FROM study_sessions s LEFT JOIN classes c ON c.id = s.class_id WHERE s.member_id = $1 AND s.day >= $2`,
  partner: `SELECT 'partner' AS kind, updated_on::text AS date, 'Partner check-in' AS title,
    concat_ws(' · ', positives || ' positive / ' || negatives || ' negative', nullif(connection, ''), nullif('Need: ' || need, 'Need: ')) AS detail
    FROM partner_checkins WHERE member_id = $1 AND updated_on >= $2`,
  one_on_one: `SELECT 'one_on_one' AS kind, o.logged_on::text AS date, '1-on-1 with ' || m.name AS title,
    concat_ws(' · ', o.minutes || ' min', CASE WHEN o.promise_kept THEN 'promise kept' END, nullif(o.word, ''), nullif(o.reflection, '')) AS detail
    FROM one_on_ones o JOIN household_members m ON m.id = o.child_id WHERE o.member_id = $1 AND o.logged_on >= $2`,
  restart: `SELECT 'restart' AS kind, day::text AS date, 'Red Alert restart' AS title,
    concat_ws(' · ', nullif(trigger, ''), steps_done || '/' || steps_total || ' steps', nullif(note, '')) AS detail
    FROM red_alerts WHERE member_id = $1 AND day >= $2`,
};

export async function recordsFor(memberId: number, kinds: readonly RecordKind[], days: number, q: string): Promise<RecordRow[]> {
  const since = addDays(today(), -days);
  const sql = kinds.map((k) => `(${QUERIES[k]})`).join(' UNION ALL ');
  const { rows } = await pool.query<RecordRow>(
    `SELECT * FROM (${sql}) r WHERE ($3 = '' OR r.title ILIKE '%' || $3 || '%' OR r.detail ILIKE '%' || $3 || '%')
      ORDER BY r.date DESC, r.kind LIMIT 500`,
    [memberId, since, q],
  );
  return rows;
}

function parse(query: Record<string, unknown>): { kinds: RecordKind[]; days: number; q: string } {
  const kind = typeof query.kind === 'string' ? query.kind : '';
  const kinds = kind ? RECORD_KINDS.filter((k) => k === kind) : [...RECORD_KINDS];
  if (!kinds.length) throw new HttpError(400, 'Unknown record kind');
  return { kinds, days: int(query.days ?? 90, 'days', 1, 3660), q: typeof query.q === 'string' ? query.q.trim().slice(0, 60) : '' };
}

recordsRouter.get('/api/records', async (req, res) => {
  const me = requireAdult(req);
  const { kinds, days, q } = parse(req.query);
  res.json({ kinds: RECORD_KINDS, records: await recordsFor(me.id, kinds, days, q) });
});

recordsRouter.get('/api/records.csv', async (req, res) => {
  const me = requireAdult(req);
  const { kinds, days, q } = parse(req.query);
  const rows = await recordsFor(me.id, kinds, days, q);
  const cell = (s: string): string => `"${s.replace(/"/g, '""').replace(/^[=+\-@]/, "'$&")}"`;
  const csv = ['date,kind,title,detail', ...rows.map((r) => [r.date, r.kind, r.title, r.detail ?? ''].map(cell).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="myday-records-${today()}.csv"`);
  res.send(csv);
});
