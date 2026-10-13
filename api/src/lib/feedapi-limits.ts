/**
 * The Feed Publishing API's quotas. This file is the one place they are set (docs/feed-api.md quotes
 * them). Operators can override any of them with FEED_API_LIMITS, e.g.
 *   FEED_API_LIMITS="posts.app=500,posts.user=20,media.app=500,media.user=40,window=3600"
 *
 *   posts.app   posts one app may publish, across everyone who connected it, per window
 *   posts.user  posts one person may publish through apps (all apps together), per window
 *   media.app / media.user   the same for photo uploads
 *   window      the rolling window, in seconds
 *
 * Counted in the database (what was actually stored in the last `window` seconds), so they hold across
 * restarts and servers. On top of these, The Feed's own limit applies to everyone, app or not: 30 posts
 * an hour per person across every kind of post (routes/community.ts POSTS_PER_HOUR -> 429 post_limit).
 */
import type { Response } from 'express';
import { pool } from '../db.js';
import { HttpError } from './http.js';

export interface FeedApiLimits {
  posts: { app: number; user: number };
  media: { app: number; user: number };
  windowSeconds: number;
}

const DEFAULTS: FeedApiLimits = { posts: { app: 500, user: 20 }, media: { app: 500, user: 40 }, windowSeconds: 3600 };

function fromEnv(raw: string | undefined): FeedApiLimits {
  const out: FeedApiLimits = { posts: { ...DEFAULTS.posts }, media: { ...DEFAULTS.media }, windowSeconds: DEFAULTS.windowSeconds };
  for (const part of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(posts|media)\.(app|user)=(\d+)$|^window=(\d+)$/.exec(part);
    if (!m) throw new Error(`FEED_API_LIMITS: can't read "${part}"`);
    if (m[4]) out.windowSeconds = Math.max(60, Number(m[4]));
    else out[m[1] as 'posts' | 'media'][m[2] as 'app' | 'user'] = Number(m[3]);
  }
  return out;
}

export const FEED_API_LIMITS: FeedApiLimits = fromEnv(process.env.FEED_API_LIMITS);

const TABLE = { posts: { table: 'social_posts', user: 'author_user_id' }, media: { table: 'community_images', user: 'user_id' } } as const;

/**
 * Check both quotas for `kind` before doing the work. Sets X-RateLimit-Limit / -Remaining / -Reset
 * (Unix seconds) for whichever quota is closer to running out; over either one -> 429 rate_limited with
 * Retry-After.
 */
export async function checkQuota(res: Response, kind: 'posts' | 'media', appId: number, userId: number): Promise<void> {
  const t = TABLE[kind];
  const w = FEED_API_LIMITS.windowSeconds;
  const { rows } = await pool.query<{ app_n: number; app_oldest: Date | null; user_n: number; user_oldest: Date | null; now: Date }>(
    `SELECT a.n AS app_n, a.oldest AS app_oldest, u.n AS user_n, u.oldest AS user_oldest, now() AS now
       FROM (SELECT COUNT(*)::int AS n, min(created_at) AS oldest FROM ${t.table} WHERE via_app_id = $1 AND created_at > now() - make_interval(secs => $3)) a,
            (SELECT COUNT(*)::int AS n, min(created_at) AS oldest FROM ${t.table} WHERE ${t.user} = $2 AND via_app_id IS NOT NULL AND created_at > now() - make_interval(secs => $3)) u`,
    [appId, userId, w],
  );
  const r = rows[0]!;
  const quotas = [
    { scope: 'app' as const, limit: FEED_API_LIMITS[kind].app, used: r.app_n, oldest: r.app_oldest },
    { scope: 'user' as const, limit: FEED_API_LIMITS[kind].user, used: r.user_n, oldest: r.user_oldest },
  ];
  const tight = quotas.reduce((a, b) => (b.limit - b.used < a.limit - a.used ? b : a));
  const resetAt = Math.ceil(((tight.oldest ?? r.now).getTime() + w * 1000) / 1000);
  res.set({
    'X-RateLimit-Limit': String(tight.limit),
    'X-RateLimit-Remaining': String(Math.max(0, tight.limit - tight.used - 1)),
    'X-RateLimit-Reset': String(resetAt),
  });
  if (tight.used >= tight.limit) {
    res.set({ 'X-RateLimit-Remaining': '0', 'Retry-After': String(Math.max(1, resetAt - Math.floor(r.now.getTime() / 1000))) });
    throw new HttpError(
      429,
      tight.scope === 'app' ? `This app has reached its ${kind} quota (${tight.limit} per ${w / 60} minutes)` : `This person has reached the ${kind} quota for apps (${tight.limit} per ${w / 60} minutes)`,
      'rate_limited',
      { quota: `${kind}.${tight.scope}`, limit: tight.limit, windowSeconds: w },
    );
  }
}
