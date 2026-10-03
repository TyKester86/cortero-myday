/**
 * Fair-use limits, so one household (or a script) can't run up the AI bill or
 * fill the disk. Counted in the database (they survive restarts); tunable per
 * server with env vars. Generous for real families.
 */
import { pool } from '../db.js';
import { HttpError } from './http.js';

const n = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  /** Messages to Hana + the homework helper, per household per calendar month. */
  aiMessagesPerMonth: () => n('AI_MONTHLY_MESSAGES', 1500),
  /** Minutes of lecture audio turned into notes, per household per month. */
  lectureMinutesPerMonth: () => n('LECTURE_MONTHLY_MINUTES', 1200),
  /** Lecture uploads per person per day. */
  lecturesPerDay: () => n('LECTURES_PER_DAY', 8),
  /** Progress-photo uploads per person per day (4 poses + retakes). */
  photosPerDay: () => n('PHOTOS_PER_DAY', 24),
};

/** Household-wide AI messages this month (runs in the household's scope). */
export async function checkAiMonthly(): Promise<void> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM chat_messages WHERE who = 'user' AND created_at >= date_trunc('month', now())",
  );
  if ((rows[0]?.n ?? 0) >= LIMITS.aiMessagesPerMonth()) {
    throw new HttpError(429, 'Your household has used this month’s AI messages. They reset on the 1st.', 'monthly_limit');
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
