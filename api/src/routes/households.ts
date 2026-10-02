/**
 * Signup + onboarding: a signed-in person with no household creates one
 * (type: family / couple / solo / empty nesters / college), becoming its
 * first grown-up. Household settings and onboarding progress live here too.
 */
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import {
  BUILDS,
  HOUSEHOLD_TYPES,
  ONBOARDING_STEPS,
  type HouseholdInfo,
  type HouseholdType,
  type OnboardingStep,
} from '@myday/shared';
import { asSystem, pool, setHousehold } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, str } from '../lib/http.js';
import { requireAdult, self } from '../lib/members.js';
import { householdInfo } from '../auth.js';

export const householdsRouter = Router();

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function newCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

const TRIAL_DAYS = 30;

/** Create a household and become its first grown-up. */
householdsRouter.post('/api/households', async (req, res) => {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (req.member) throw new HttpError(409, 'You already belong to a household');
  const b = req.body as Record<string, unknown>;
  const type = HOUSEHOLD_TYPES.find((t) => t === b.type);
  if (!type) throw new HttpError(400, 'Pick a household type');
  const householdName = str(b.householdName, 'householdName', 60, true);
  const yourName = str(b.yourName, 'yourName', 40, true);
  const build = b.build === undefined || b.build === null || b.build === '' ? null : BUILDS.find((x) => x === b.build);
  if (build === undefined) throw new HttpError(400, 'Unknown build');
  const school = str(b.school, 'school', 120);
  const userId = req.user.id;
  const email = req.user.email && !req.user.email.endsWith('@invalid') ? req.user.email.toLowerCase() : null;

  const householdId = await asSystem(async () => {
    let id: number | undefined;
    for (let attempt = 0; attempt < 5 && id === undefined; attempt++) {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO households (name, type, code, trial_ends_at, onboarding)
         VALUES ($1, $2, $3, now() + make_interval(days => $4::int), '{"household": true}'::jsonb)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [householdName, type, newCode(), TRIAL_DAYS],
      );
      id = r.rows[0]?.id;
    }
    if (id === undefined) throw new Error('could not allocate a household code');
    const key = yourName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'me';
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO household_members (household_id, key, name, kind, email, xp_track, sort_order, school)
       VALUES ($1, $2, $3, 'adult', $4, $5, 1, $6) RETURNING id`,
      [id, key, yourName, email, type === 'college' ? 'student' : 'leader', school || null],
    );
    const memberId = rows[0]?.id;
    if (memberId === undefined) throw new Error('member insert returned nothing');
    await pool.query('UPDATE users SET member_id = $2 WHERE id = $1', [userId, memberId]);
    if (build) {
      await pool.query(
        `INSERT INTO health_profiles (household_id, member_id, plan_start, build, level, bodyweight_lb, food_protein)
         VALUES ($1, $2, CURRENT_DATE, $3, 'beginner', NULL, NULL)`,
        [id, memberId, build],
      );
    }
    await logEvent('household_created', { type, build: build ?? '' }, memberId, id);
    return id;
  });
  await setHousehold(householdId);
  req.householdId = householdId;
  const out: HouseholdInfo = await householdInfo(householdId);
  res.status(201).json(out);
});

householdsRouter.get('/api/household/info', async (req, res) => {
  self(req);
  if (!req.householdId) throw new HttpError(409, 'No household');
  res.json(await householdInfo(req.householdId));
});

/** Rename, change type, or flip the teen bank-link gate (grown-ups). */
householdsRouter.patch('/api/household/info', async (req, res) => {
  requireAdult(req);
  if (!req.householdId) throw new HttpError(409, 'No household');
  const b = req.body as Record<string, unknown>;
  const cur = await householdInfo(req.householdId);
  const type: HouseholdType = b.type === undefined ? cur.type : (HOUSEHOLD_TYPES.find((t) => t === b.type) ?? cur.type);
  const name = b.name === undefined ? cur.name : str(b.name, 'name', 60, true);
  const gate = b.allowTeenBankLink === undefined ? cur.allowTeenBankLink : b.allowTeenBankLink === true;
  await asSystem(() =>
    pool.query('UPDATE households SET name = $2, type = $3, allow_teen_bank_link = $4 WHERE id = $1', [
      req.householdId,
      name,
      type,
      gate,
    ]),
  );
  res.json(await householdInfo(req.householdId));
});

/** Mark an onboarding step done (or skipped). */
householdsRouter.post('/api/onboarding/:step', async (req, res) => {
  requireAdult(req);
  const step = ONBOARDING_STEPS.find((s) => s === req.params.step) as OnboardingStep | undefined;
  if (!step) throw new HttpError(404, 'No such step');
  if (!req.householdId) throw new HttpError(409, 'No household');
  await asSystem(() =>
    pool.query(`UPDATE households SET onboarding = onboarding || jsonb_build_object($2::text, true) WHERE id = $1`, [
      req.householdId,
      step,
    ]),
  );
  await logEvent('onboarding_step', { step, skipped: (req.body as { skipped?: unknown }).skipped === true });
  res.json(await householdInfo(req.householdId));
});

/** School autocomplete: names already used in this household (siblings share schools). Optional field. */
householdsRouter.get('/api/schools', async (req, res) => {
  self(req);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const { rows } = await pool.query<{ school: string }>(
    `SELECT DISTINCT school FROM (
       SELECT school FROM household_members WHERE school IS NOT NULL AND school <> ''
       UNION SELECT school FROM classes WHERE school <> ''
     ) s WHERE $1 = '' OR lower(school) LIKE '%' || $1 || '%' ORDER BY school LIMIT 10`,
    [q],
  );
  res.json({ schools: rows.map((r) => r.school) });
});
