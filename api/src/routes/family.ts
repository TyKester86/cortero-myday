/**
 * Family: weekly partner check-in, a kids overview, curfews / phone-off
 * times, and the 1-on-1 log. Ported from apiAdultFamily /
 * apiAdultSavePartner / apiAdultSaveParent / apiSetCurfew / curfewFor_.
 * Grown-ups only; kids see their own curfew on Today.
 */
import { Router } from 'express';
import type {
  ClockTime,
  Curfew,
  DateStr,
  EarnResult,
  FamilyResponse,
  KidOverview,
  OneOnOne,
  PartnerCheckin,
  TonightCurfew,
} from '@myday/shared';
import { pool } from '../db.js';
import { isoWeekday, today, weekStart } from '../lib/dates.js';
import { HttpError, idParam, int, str } from '../lib/http.js';
import { listMembers, memberById, requireAdult } from '../lib/members.js';
import { trackOf } from '../lib/adult.js';
import { awardXpOnce, withEarn } from '../lib/xp.js';
import { bankFor } from './rewards.js';

export const familyRouter = Router();

/** fmtTime_: "H:MM" / "HH:MM" -> "HH:MM", anything else -> '' (clears). */
export function fmtTime(x: unknown): ClockTime {
  const m = String(x ?? '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return '';
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const EMPTY_CURFEW: Curfew = { curfewWeekday: '', curfewWeekend: '', phoneOffWeekday: '', phoneOffWeekend: '' };

export async function curfewFor(memberId: number): Promise<Curfew> {
  const { rows } = await pool.query<{ cw: string; ce: string; pw: string; pe: string }>(
    `SELECT curfew_weekday AS cw, curfew_weekend AS ce, phone_off_weekday AS pw, phone_off_weekend AS pe
       FROM curfews WHERE member_id = $1`,
    [memberId],
  );
  const r = rows[0];
  return r ? { curfewWeekday: r.cw, curfewWeekend: r.ce, phoneOffWeekday: r.pw, phoneOffWeekend: r.pe } : EMPTY_CURFEW;
}

/** Tonight's times. Friday and Saturday nights count as the weekend. */
export async function tonightCurfew(memberId: number, d: DateStr): Promise<TonightCurfew | null> {
  const c = await curfewFor(memberId);
  const weekend = isoWeekday(d) === 5 || isoWeekday(d) === 6;
  const curfew = weekend ? c.curfewWeekend : c.curfewWeekday;
  const phoneOff = weekend ? c.phoneOffWeekend : c.phoneOffWeekday;
  return curfew || phoneOff ? { weekend, curfew, phoneOff } : null;
}

/** The script's ratio display: "5.0:1", "∞" with no negatives, "—" with neither. */
function ratio(pos: number, neg: number): string {
  if (neg > 0) return `${(pos / neg).toFixed(1)}:1`;
  return pos > 0 ? '∞' : '—';
}

async function kidsOverview(): Promise<KidOverview[]> {
  const t = today();
  const ws = weekStart(t);
  const kids = (await listMembers()).filter((m) => m.kind === 'kid');
  const out: KidOverview[] = [];
  for (const kid of kids) {
    const { rows } = await pool.query<{
      chores_today: number;
      chores_done: number;
      pts_today: number;
      pts_week: number;
      hw_open: number;
      hw_overdue: number;
      pending: number;
      last_signin: Date | null;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM chores c WHERE c.member_id = $1 AND c.active AND $4 = ANY (c.days))::int AS chores_today,
         (SELECT COUNT(*) FROM chores c JOIN chore_completions cc ON cc.chore_id = c.id
           WHERE c.member_id = $1 AND c.active AND cc.completed_on = $2)::int AS chores_done,
         (SELECT COALESCE(SUM(points), 0) FROM scores WHERE member_id = $1 AND earned_on = $2)::int AS pts_today,
         (SELECT COALESCE(SUM(points), 0) FROM scores WHERE member_id = $1 AND earned_on >= $3)::int AS pts_week,
         (SELECT COUNT(*) FROM homework WHERE member_id = $1 AND NOT done)::int AS hw_open,
         (SELECT COUNT(*) FROM homework WHERE member_id = $1 AND NOT done AND due < $2)::int AS hw_overdue,
         (SELECT COUNT(*) FROM redemptions WHERE member_id = $1 AND status = 'pending')::int AS pending,
         (SELECT MAX(at) FROM kid_signins WHERE member_id = $1 AND ok) AS last_signin`,
      [kid.id, t, ws, isoWeekday(t)],
    );
    const r = rows[0];
    if (!r) continue;
    out.push({
      member: kid,
      choresToday: r.chores_today,
      choresDone: r.chores_done,
      pointsToday: r.pts_today,
      weekPoints: r.pts_week,
      bank: await bankFor(kid.id),
      openHomework: r.hw_open,
      overdueHomework: r.hw_overdue,
      pendingRewards: r.pending,
      curfew: await curfewFor(kid.id),
      lastSignIn: r.last_signin ? r.last_signin.toISOString() : null,
    });
  }
  return out;
}

interface PartnerRow {
  week_start: string;
  positives: number;
  negatives: number;
  connection: string;
  conflict: boolean;
  flooded: boolean;
  took_break: boolean;
  need: string;
}

async function familyFor(memberId: number): Promise<FamilyResponse> {
  const ws = weekStart(today());
  const p = (
    await pool.query<PartnerRow>(
      `SELECT week_start::text AS week_start, positives, negatives, connection, conflict, flooded, took_break, need
         FROM partner_checkins WHERE member_id = $1 AND week_start = $2`,
      [memberId, ws],
    )
  ).rows[0];
  const partner: PartnerCheckin | null = p
    ? {
        weekStart: p.week_start,
        positives: p.positives,
        negatives: p.negatives,
        ratio: ratio(p.positives, p.negatives),
        connection: p.connection,
        conflict: p.conflict,
        flooded: p.flooded,
        tookBreak: p.took_break,
        need: p.need,
      }
    : null;
  const { rows: ones } = await pool.query<{
    id: number;
    child_id: number;
    child_name: string;
    logged_on: string;
    minutes: number;
    promise_kept: boolean;
    moment: boolean;
    reflection: string;
    word: string;
  }>(
    `SELECT o.id, o.child_id, m.name AS child_name, o.logged_on::text AS logged_on, o.minutes, o.promise_kept,
            o.moment, o.reflection, o.word
       FROM one_on_ones o JOIN household_members m ON m.id = o.child_id
      WHERE o.member_id = $1 ORDER BY o.logged_on DESC, o.id DESC LIMIT 20`,
    [memberId],
  );
  return {
    weekStart: ws,
    partner,
    kids: await kidsOverview(),
    oneOnOnes: ones.map(
      (o): OneOnOne => ({
        id: o.id,
        childId: o.child_id,
        childName: o.child_name,
        loggedOn: o.logged_on,
        minutes: o.minutes,
        promiseKept: o.promise_kept,
        moment: o.moment,
        reflection: o.reflection,
        word: o.word,
      }),
    ),
  };
}

familyRouter.get('/api/family', async (req, res) => {
  res.json(await familyFor(requireAdult(req).id));
});

/** Weekly partner check-in. 15 XP on the first save of the week ("Marriage Check-In"). */
familyRouter.put('/api/family/partner', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const t = today();
  const ws = weekStart(t);
  const track = await trackOf(me.id);
  const { earn } = await withEarn(me.id, async () => {
    await pool.query(
      `INSERT INTO partner_checkins (member_id, week_start, positives, negatives, connection, conflict, flooded, took_break, need, updated_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (member_id, week_start) DO UPDATE SET positives = EXCLUDED.positives, negatives = EXCLUDED.negatives,
         connection = EXCLUDED.connection, conflict = EXCLUDED.conflict, flooded = EXCLUDED.flooded,
         took_break = EXCLUDED.took_break, need = EXCLUDED.need, updated_on = EXCLUDED.updated_on`,
      [
        me.id, ws, int(b.positives ?? 0, 'positives', 0, 999), int(b.negatives ?? 0, 'negatives', 0, 999),
        str(b.connection, 'connection', 200), b.conflict === true, b.flooded === true, b.tookBreak === true,
        str(b.need, 'need', 200), t,
      ],
    );
    await awardXpOnce(me.id, t, 15, track === 'student' ? 'Relationship Check-In' : 'Marriage Check-In', `partner:${ws}`);
  });
  const out: EarnResult & { family: FamilyResponse } = { ...earn, family: await familyFor(me.id) };
  res.json(out);
});

/** 1-on-1 time with a kid. 20 XP for the first one of the week ("Dad/Mom Presence"). */
familyRouter.post('/api/family/one-on-ones', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const child = await memberById(idParam(b.childId));
  if (!child || child.kind !== 'kid') throw new HttpError(400, 'Pick one of the kids');
  const t = today();
  const track = await trackOf(me.id);
  const { earn } = await withEarn(me.id, async () => {
    await pool.query(
      `INSERT INTO one_on_ones (member_id, child_id, logged_on, minutes, promise_kept, moment, reflection, word)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [me.id, child.id, t, int(b.minutes ?? 0, 'minutes', 0, 1440), b.promiseKept === true, b.moment === true,
        str(b.reflection, 'reflection', 300), str(b.word, 'word', 40)],
    );
    await awardXpOnce(me.id, t, 20, track === 'woman' ? 'Mom Presence Completed' : 'Dad Presence Completed', `parent:${weekStart(t)}`);
  });
  res.status(201).json({ ...earn, family: await familyFor(me.id) });
});

/** Set a kid's curfew / phone-off times. '' clears a time. */
familyRouter.put('/api/family/curfews/:memberId', async (req, res) => {
  const me = requireAdult(req);
  const kid = await memberById(idParam(req.params.memberId));
  if (!kid || kid.kind !== 'kid') throw new HttpError(404, 'No such kid');
  const b = req.body as Record<string, unknown>;
  const cur = await curfewFor(kid.id);
  const pick = (k: keyof Curfew): string => (b[k] === undefined ? cur[k] : fmtTime(b[k]));
  await pool.query(
    `INSERT INTO curfews (member_id, curfew_weekday, curfew_weekend, phone_off_weekday, phone_off_weekend)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (member_id) DO UPDATE SET curfew_weekday = EXCLUDED.curfew_weekday, curfew_weekend = EXCLUDED.curfew_weekend,
       phone_off_weekday = EXCLUDED.phone_off_weekday, phone_off_weekend = EXCLUDED.phone_off_weekend`,
    [kid.id, pick('curfewWeekday'), pick('curfewWeekend'), pick('phoneOffWeekday'), pick('phoneOffWeekend')],
  );
  res.json(await familyFor(me.id));
});
