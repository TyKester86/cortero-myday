/**
 * Feed Rank v1 — The Feed's home feed. Pure scoring (no I/O); routes/community.ts gathers the signals.
 * Calm social ranking: friends first, conversation over applause, never outrage-weighted.
 *
 *   score = 0.35·C + 0.25·F + 0.20·A + 0.20·D + E      (×0.2 when 2+ people have reported it)
 *
 * North star: meaningful connection per session (comments, poll votes, DMs started, return visits).
 * Deliberately NOT optimized: time on site, scroll depth, session length. Nothing here rewards
 * disagreement, quote-posts or anger — there are no such inputs.
 *
 * Differences from the reference implementation (feed-app-rank.ts), on purpose:
 *  - diversify() never breaks the per-author caps (2 in a row, 20% of each 40-slot window): when only
 *    capped authors are left it stops (the feed then says "You're caught up") instead of taking them anyway.
 *  - It also keeps the spec's third rule the reference skipped: no run of 4+ text-only posts
 *    (soft — relaxed only when no photo/poll post is left).
 */

export type Relation = 'mutual' | 'following' | 'followed_by' | 'none';

export interface AuthorSignals {
  authorId: number;
  relation: Relation;
  /** the viewer's interactions with this author in the trailing 30 days */
  comments: number;
  dms: number;
  pollVotes: number;
  likes: number;
  profileVisits: number;
  ageDays: number;
  lifetimePosts: number;
}

export interface RankPost {
  id: number;
  authorId: number;
  ageHours: number;
  commentCount: number;
  isPoll: boolean;
  /** votes / impressions for polls, 0..1 */
  pollParticipation: number;
  impressions: number;
  /** distinct people with an open report on it */
  reports: number;
  /** a photo or a poll (the text-only interleave rule) */
  rich: boolean;
}

export interface FeedScore {
  postId: number;
  score: number;
  C: number;
  F: number;
  A: number;
  D: number;
  E: number;
}

// The weights shipped with v1 (tune weekly; see the staff feed-rank review).
export const FEED_WEIGHTS = { C: 0.35, F: 0.25, A: 0.2, D: 0.2 } as const;
export const CLOSENESS: Record<Relation, number> = { mutual: 1.0, following: 0.7, followed_by: 0.5, none: 0.2 };
export const HALF_LIFE_HOURS = 18;
export const FRESHNESS_FLOOR = 0.05;
export const AFFINITY_WEIGHTS = { comments: 1.0, dms: 1.5, pollVotes: 0.5, likes: 0.3, profileVisits: 0.2 } as const;
export const AFFINITY_SATURATION = 8;
export const NEW_AUTHOR_DAYS = 14;
export const NEW_AUTHOR_POSTS = 5;
export const SAMPLING_IMPRESSIONS = 30;
export const EXPLORATION_CAP = 0.2;
export const REPORTED_AT = 2;
export const REPORTED_FACTOR = 0.2;
export const FEED_DIVERSITY = { window: 40, authorShare: 0.2, maxConsecutive: 2, maxTextRun: 3 } as const;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export const closeness = (r: Relation): number => CLOSENESS[r];

export const freshness = (ageHours: number): number => Math.max(FRESHNESS_FLOOR, Math.pow(0.5, Math.max(0, ageHours) / HALF_LIFE_HOURS));

export function affinity(a: Pick<AuthorSignals, 'comments' | 'dms' | 'pollVotes' | 'likes' | 'profileVisits'>): number {
  const W = AFFINITY_WEIGHTS;
  const raw = a.comments * W.comments + a.dms * W.dms + a.pollVotes * W.pollVotes + a.likes * W.likes + a.profileVisits * W.profileVisits;
  return raw / (raw + AFFINITY_SATURATION);
}

export function discussion(p: Pick<RankPost, 'commentCount' | 'isPoll' | 'pollParticipation'>): number {
  const comments = clamp01(Math.log10(1 + Math.max(0, p.commentCount)) / Math.log10(51));
  return 0.6 * comments + 0.4 * (p.isPoll ? clamp01(p.pollParticipation) : 0);
}

export function exploration(a: Pick<AuthorSignals, 'ageDays' | 'lifetimePosts'>, p: Pick<RankPost, 'impressions'>): number {
  let e = 0;
  if (a.ageDays < NEW_AUTHOR_DAYS || a.lifetimePosts < NEW_AUTHOR_POSTS) e += 0.12 * (1 - Math.min(NEW_AUTHOR_POSTS, a.lifetimePosts) / NEW_AUTHOR_POSTS);
  if (p.impressions < SAMPLING_IMPRESSIONS) e += 0.08;
  return Math.min(EXPLORATION_CAP, e);
}

export function scoreFeedPost(a: AuthorSignals, p: RankPost): FeedScore {
  const C = closeness(a.relation);
  const F = freshness(p.ageHours);
  const A = affinity(a);
  const D = discussion(p);
  const E = exploration(a, p);
  let score = FEED_WEIGHTS.C * C + FEED_WEIGHTS.F * F + FEED_WEIGHTS.A * A + FEED_WEIGHTS.D * D + E;
  // Community moderation feeds back in: reported by 2+ people sinks it pending review (screening stays the source of truth).
  if (p.reports >= REPORTED_AT) score *= REPORTED_FACTOR;
  return { postId: p.id, score, C, F, A, D, E };
}

/** Best first in; caps per author (2 in a row, 20% of each 40-slot window); no 4+ text-only run when avoidable. */
export function diversifyFeed<T extends { postId: number; authorId: number; score: number; rich: boolean }>(ranked: T[], limit: number = FEED_DIVERSITY.window): T[] {
  const out: T[] = [];
  const pool = [...ranked];
  const perWindow = Math.max(1, Math.floor(FEED_DIVERSITY.window * FEED_DIVERSITY.authorShare));
  let windowCounts = new Map<number, number>();
  const tail = (n: number): T[] => out.slice(Math.max(0, out.length - n));
  const authorOk = (p: T): boolean => {
    if ((windowCounts.get(p.authorId) ?? 0) >= perWindow) return false;
    const last = tail(FEED_DIVERSITY.maxConsecutive);
    return !(last.length === FEED_DIVERSITY.maxConsecutive && last.every((x) => x.authorId === p.authorId));
  };
  const textOk = (p: T): boolean => {
    if (p.rich) return true;
    const last = tail(FEED_DIVERSITY.maxTextRun);
    return !(last.length === FEED_DIVERSITY.maxTextRun && last.every((x) => !x.rich));
  };
  while (out.length < limit && pool.length) {
    if (out.length > 0 && out.length % FEED_DIVERSITY.window === 0) windowCounts = new Map();
    let idx = pool.findIndex((p) => authorOk(p) && textOk(p));
    if (idx === -1) idx = pool.findIndex(authorOk);
    if (idx === -1) break;
    const pick = pool.splice(idx, 1)[0]!;
    out.push(pick);
    windowCounts.set(pick.authorId, (windowCounts.get(pick.authorId) ?? 0) + 1);
  }
  return out;
}
