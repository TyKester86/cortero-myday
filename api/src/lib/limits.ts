/**
 * Fair-use limits, so one household (or a script) can't run up the AI bill or
 * fill the disk. Counted in the database (they survive restarts); tunable per
 * server with env vars. Generous for real families.
 */
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { HttpError } from './http.js';

const n = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  /** Messages to Hana (Ask Hana + the homework helper) per household per day, on Solo and Family. Family+ is unlimited. */
  hanaMessagesPerDay: () => n('HANA_DAILY_MESSAGES', 50),
  /** Minutes of lecture audio turned into notes, per household per month. */
  lectureMinutesPerMonth: () => n('LECTURE_MONTHLY_MINUTES', 1200),
  /** Lecture uploads per person per day. */
  lecturesPerDay: () => n('LECTURES_PER_DAY', 8),
  /** Progress-photo uploads per person per day (4 poses + retakes). */
  photosPerDay: () => n('PHOTOS_PER_DAY', 24),
};

const TIER_NAME: Record<string, string> = { solo: 'Solo', family: 'Family', familyplus: 'Family+' };

/** The household's Hana allowance per day: null = unlimited (Family+, and complimentary households). */
export async function hanaDailyCap(householdId: number): Promise<{ cap: number | null; tier: string }> {
  const { rows } = await asSystem(() =>
    pool.query<{ tier: string | null; status: string }>(
      `SELECT p.tier, h.billing_status AS status FROM households h
         LEFT JOIN billing_plans p ON p.id = COALESCE(h.plan_id, (SELECT id FROM billing_plans WHERE is_default))
        WHERE h.id = $1`,
      [householdId],
    ),
  );
  const tier = rows[0]?.tier ?? 'family';
  if (tier === 'familyplus' || rows[0]?.status === 'comped') return { cap: null, tier };
  return { cap: LIMITS.hanaMessagesPerDay(), tier };
}

/**
 * Enforced on the server before every message to Hana (runs in the household's scope, so it counts this
 * household's messages): Solo and Family get 50 a day for the whole household, reset at local midnight;
 * Family+ is unlimited. Messages Hana couldn't answer don't count.
 */
export async function checkHanaDaily(householdId: number, kind: 'adult' | 'kid'): Promise<void> {
  const { cap, tier } = await hanaDailyCap(householdId);
  if (cap === null) return;
  const { rows } = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM chat_messages WHERE who = 'user' AND NOT failed AND created_at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)",
    [config.tz],
  );
  if ((rows[0]?.n ?? 0) >= cap) {
    throw new HttpError(
      429,
      kind === 'adult'
        ? `Your household has used today’s ${cap} Hana messages on ${TIER_NAME[tier] ?? 'your plan'}. They reset at midnight — or switch to Family+ for unlimited Hana.`
        : 'Hana’s done for today — she’ll be back tomorrow!',
      'hana_daily_limit',
      { cap, tier, upgrade: kind === 'adult' ? 'familyplus' : null },
    );
  }
}

export async function checkLectureUpload(memberId: number, durationS: number): Promise<void> {
  const { rows } = await pool.query<{ today: number; minutes: number }>(
    `SELECT (SELECT COUNT(*)::int FROM lectures WHERE member_id = $1 AND created_at > now() - interval '1 day') AS today,
            (SELECT COALESCE(SUM(duration_s), 0)::int / 60 FROM lectures WHERE created_at >= date_trunc('month', now())) AS minutes`,
    [memberId],
  );
  if ((rows[0]?.today ?? 0) >= LIMITS.lecturesPerDay()) throw new HttpError(429, 'That’s a lot of recordings today — the rest can wait until tomorrow.', 'daily_limit');
  if ((rows[0]?.minutes ?? 0) + Math.round(durationS / 60) > LIMITS.lectureMinutesPerMonth()) {
    throw new HttpError(429, 'Your household has used this month’s lecture-notes minutes. They reset on the 1st.', 'monthly_limit');
  }
}

export async function checkPhotoUpload(memberId: number): Promise<void> {
  const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM progress_photos WHERE member_id = $1 AND created_at > now() - interval '1 day'", [memberId]);
  if ((rows[0]?.n ?? 0) >= LIMITS.photosPerDay()) throw new HttpError(429, 'That’s enough photos for today.', 'daily_limit');
}
