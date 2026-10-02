/**
 * Identity tools, restored from the script: the Identity Anchor (who I am
 * with ADHD, my values, my mission), the monthly identity review, the weekly
 * survey about how the head of household showed up (FamFeedback), and the
 * mental-load tracker (who carries what at home).
 */
import { Router } from 'express';
import type { HouseholdSurvey, IdentityResponse, MentalLoadRow, XpTrack } from '@myday/shared';
import { pool } from '../db.js';
import { trackOf } from '../lib/adult.js';
import { today, weekStart } from '../lib/dates.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { requireAdult } from '../lib/members.js';
import { awardXpOnce } from '../lib/xp.js';

export const identityRouter = Router();

export const ANCHOR_FIELDS = [
  'ADHD subtype', 'Biggest EF challenge', 'ADHD superpower', 'Primary shame trigger', 'Diagnosed at age', 'ADHD affects most',
  'The lie ADHD tells me', 'The neuroscience truth', 'My reframe statement', 'Core value 1', 'Core value 2', 'Core value 3', 'Personal mission',
];

export function identityQuestions(track: XpTrack): string[] {
  if (track === 'student') {
    return ['Anchor refresh — does my statement still fit?', 'Which core values did I live this month?', 'Wins & achievements — every win counts', 'What worked? What do I want to change?', 'One word for next month — what am I becoming?'];
  }
  if (track === 'woman') {
    return ['Who was I this month?', 'Who am I becoming?', 'What evidence proves it?', 'What did my family experience from me?', 'What behavior must improve next month?'];
  }
  return ['Who was I this month as a husband and father?', 'Who am I becoming?', 'What evidence proves it?', 'What did my family experience from me?', 'What behavior must improve next month?'];
}

export const MENTAL_SEED = [
  'Kids schedules', 'Meals/groceries', 'Appointments', 'School communication', 'Bills/admin', 'Cleaning/home upkeep',
  'Family birthdays/holidays', 'Emotional labor', 'Work follow-up', 'Personal care', 'Fitness/health', 'Extended family',
];
const LOADS = ['', 'Light', 'Medium', 'Heavy'] as const;
const SURVEY_DIMS = ['presence', 'reliability', 'emotional', 'followThrough', 'communication'] as const;

async function identityFor(memberId: number): Promise<IdentityResponse> {
  const track = await trackOf(memberId);
  const t = today();
  const { rows: a } = await pool.query<{ field: string; value: string }>('SELECT field, value FROM identity_anchor WHERE member_id = $1', [memberId]);
  const { rows: r } = await pool.query<{ month: string; answers: string[] }>(
    'SELECT month, answers FROM identity_reviews WHERE member_id = $1 ORDER BY month DESC LIMIT 12',
    [memberId],
  );
  const { rows: s } = await pool.query<{
    week_start: string; presence: number; reliability: number; emotional: number; follow_through: number; communication: number;
    more_of: string; improved: string; work_on: string;
  }>('SELECT week_start::text AS week_start, * FROM household_surveys WHERE member_id = $1 AND week_start = $2', [memberId, weekStart(t)]);
  // The mental-load list is seeded with the script's 12 categories on first view.
  await pool.query(
    `INSERT INTO mental_load (member_id, category) SELECT $1, c FROM unnest($2::text[]) AS c
     WHERE NOT EXISTS (SELECT 1 FROM mental_load WHERE member_id = $1) ON CONFLICT DO NOTHING`,
    [memberId, MENTAL_SEED],
  );
  const { rows: ml } = await pool.query<{ id: number; category: string; load: MentalLoadRow['load']; owner: string; delegate: boolean }>(
    'SELECT id, category, load, owner, delegate FROM mental_load WHERE member_id = $1 ORDER BY id',
    [memberId],
  );
  const sv = s[0];
  const survey: HouseholdSurvey | null = sv
    ? {
        weekStart: sv.week_start, presence: sv.presence, reliability: sv.reliability, emotional: sv.emotional,
        followThrough: sv.follow_through, communication: sv.communication, moreOf: sv.more_of, improved: sv.improved, workOn: sv.work_on,
      }
    : null;
  return {
    fields: ANCHOR_FIELDS,
    anchor: Object.fromEntries(a.map((x) => [x.field, x.value])),
    questions: identityQuestions(track),
    month: t.slice(0, 7),
    reviews: r,
    survey,
    mentalLoad: ml,
  };
}

identityRouter.get('/api/identity', async (req, res) => {
  res.json(await identityFor(requireAdult(req).id));
});

/** Save the whole anchor at once (only the known fields). */
identityRouter.put('/api/identity/anchor', async (req, res) => {
  const me = requireAdult(req);
  const b = (req.body as { anchor?: unknown }).anchor;
  if (!b || typeof b !== 'object') throw new HttpError(400, 'anchor must be an object');
  for (const f of ANCHOR_FIELDS) {
    const v = (b as Record<string, unknown>)[f];
    if (v === undefined) continue;
    await pool.query(
      `INSERT INTO identity_anchor (member_id, field, value) VALUES ($1, $2, $3)
       ON CONFLICT (member_id, field) DO UPDATE SET value = EXCLUDED.value`,
      [me.id, f, str(v, f, 500)],
    );
  }
  res.json(await identityFor(me.id));
});

/** Monthly review: five answers; the first save of a month earns 30 XP. */
identityRouter.put('/api/identity/review', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as { month?: unknown; answers?: unknown };
  const month = typeof b.month === 'string' && /^\d{4}-\d{2}$/.test(b.month) ? b.month : today().slice(0, 7);
  if (!Array.isArray(b.answers) || b.answers.length !== 5) throw new HttpError(400, 'Answer the five questions (blank is fine)');
  const answers = b.answers.map((x, i) => str(x, `answer ${i + 1}`, 600));
  await pool.query(
    `INSERT INTO identity_reviews (member_id, month, answers) VALUES ($1, $2, $3)
     ON CONFLICT (member_id, month) DO UPDATE SET answers = EXCLUDED.answers`,
    [me.id, month, answers],
  );
  await awardXpOnce(me.id, today(), 30, 'Identity Review Completed', `identity:${month}`);
  res.json(await identityFor(me.id));
});

/** This week's survey on how the head of household showed up (1–5 each). */
identityRouter.put('/api/identity/survey', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const [p, r, e, f, c] = SURVEY_DIMS.map((d) => {
    const v = b[d];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, `${d} is a 1–5 rating`);
    return v;
  });
  await pool.query(
    `INSERT INTO household_surveys (member_id, week_start, presence, reliability, emotional, follow_through, communication, more_of, improved, work_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (member_id, week_start) DO UPDATE SET presence = EXCLUDED.presence, reliability = EXCLUDED.reliability,
       emotional = EXCLUDED.emotional, follow_through = EXCLUDED.follow_through, communication = EXCLUDED.communication,
       more_of = EXCLUDED.more_of, improved = EXCLUDED.improved, work_on = EXCLUDED.work_on`,
    [me.id, weekStart(today()), p, r, e, f, c, str(b.moreOf, 'moreOf', 200), str(b.improved, 'improved', 200), str(b.workOn, 'workOn', 200)],
  );
  res.json(await identityFor(me.id));
});

identityRouter.patch('/api/identity/load/:id', async (req, res) => {
  const me = requireAdult(req);
  const b = req.body as Record<string, unknown>;
  const load = LOADS.find((l) => l === b.load);
  if (load === undefined) throw new HttpError(400, 'load must be Light, Medium, Heavy or blank');
  const r = await pool.query('UPDATE mental_load SET load = $3, owner = $4, delegate = $5 WHERE id = $1 AND member_id = $2', [
    idParam(req.params.id), me.id, load, str(b.owner, 'owner', 40), b.delegate === true,
  ]);
  if (!r.rowCount) throw new HttpError(404, 'No such category');
  res.json(await identityFor(me.id));
});

identityRouter.post('/api/identity/load', async (req, res) => {
  const me = requireAdult(req);
  await identityFor(me.id); // seed first so a custom row doesn't suppress the defaults
  const cat = str((req.body as { category?: unknown }).category, 'category', 60, true);
  await pool.query('INSERT INTO mental_load (member_id, category) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, cat]);
  res.status(201).json(await identityFor(me.id));
});
