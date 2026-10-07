/**
 * Community: The Village (parents forum) and The Feed (in-app social network).
 *
 * Hard rules (see migrations/021_community.sql):
 *   - grown-ups only (18+): kid and teen accounts get 403 on every route here,
 *     and there is no nav entry for them; nobody acts "for" someone else;
 *   - keyed by account (users.id), never by kid members, so the social graph
 *     can only ever connect adults;
 *   - nothing from here is read by Circles, the Care team or any shared surface;
 *   - post bodies, titles, bios and photos are sealed at rest (lib/seal.ts);
 *   - every post/reply/photo goes through the pre-screen (lib/screen.ts) first;
 *     held items are "under review" to their author, never silently deleted;
 *     crisis items jump to the top of the queue and the writer sees 988;
 *   - 3 open reports hide an item until a moderator (MyDay admin) reviews it;
 *   - strikes: warn → 7-day mute → ban, all logged.
 */
import express, { Router, type Request } from 'express';
import {
  COMMUNITY_GUIDELINES,
  VILLAGE_CATEGORIES,
  type CommunityAuthor,
  type CommunityMe,
  type CommunityProfile,
  type CommunityQueue,
  type CommunityQueueItem,
  type CommunityStatus,
  type PostCheck,
  type TrustedAnswer,
  type FeedPage,
  type FeedPost,
  type ReviewNote,
  type VillageCategory,
  type VillagePost,
  type VillageThread,
  type VillageThreadSummary,
  type WebItem,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, detached, pool, tx } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { sendMail } from '../lib/mail.js';
import { isTeen } from '../lib/planload.js';
import { SCREEN_REASONS, screenImage, screenText, type ScreenReason, type ScreenResult } from '../lib/screen.js';
import { currentKeyId, openBytes, openText, sealBytes, sealText } from '../lib/seal.js';
import { refreshWebFeeds } from '../lib/webfeed.js';
import { answerQuestion, isQuestion, verifyClaim } from '../lib/verify.js';

export const communityRouter = Router();
/** Moderation is for MyDay admins, with or without a household of their own. */
export const communityStaffRouter = Router();
/** Photo uploads take a raw body. */
export const communityUploadRouter = Router();

const HIDE_AT_REPORTS = 3;
const POSTS_PER_HOUR = 30;
const MUTE_DAYS = 7;
const MAX_IMAGE = 8 * 1024 * 1024;

const isAdmin = (req: Request): boolean => !!req.user && config.adminEmails.includes(req.user.email.toLowerCase());

interface Adult {
  userId: number;
  admin: boolean;
}

/** Grown-ups (18+) only. Kids and teens stop here with a 403. */
async function adult(req: Request): Promise<Adult> {
  const me = req.member;
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (!me || me.kind !== 'adult' || (await isTeen(me.id))) throw new HttpError(403, 'The Village and the Feed are for grown-ups (18+) only', 'adults_only');
  if (typeof req.query.member === 'string' && req.query.member !== me.key) throw new HttpError(403, 'The community is always you, never someone you act for');
  return { userId: req.user.id, admin: isAdmin(req) };
}

interface ProfileRow {
  user_id: number;
  display_name: string;
  bio_enc: Buffer | null;
  key_id: string;
  avatar_id: number | null;
  parent_badge: boolean;
  muted_until: Date | null;
  banned_at: Date | null;
  shop_slug: string | null;
  created_at: Date;
}

/** Where MonetizeMe storefronts live (a creator's shop is <base>/creator/?slug=<slug>). */
const shopUrl = (slug: string | null): string | null =>
  slug ? `${(process.env.MONETIZEME_URL || 'https://opsentra.app').replace(/\/$/, '')}/creator/?slug=${encodeURIComponent(slug)}` : null;
const SHOP_SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** The Feed's window: the last week, then "you're caught up". */
const FEED_WINDOW_DAYS = 7;
const FEED_MAX = 60;

async function profileRow(userId: number): Promise<ProfileRow | null> {
  const { rows } = await pool.query<ProfileRow>('SELECT * FROM social_profiles WHERE user_id = $1', [userId]);
  return rows[0] ?? null;
}

/** Signed-up member (profile + guidelines accepted), not banned. Muted people can still read. */
async function member(req: Request): Promise<Adult & { profile: ProfileRow }> {
  const a = await adult(req);
  const profile = await profileRow(a.userId);
  if (!profile) throw new HttpError(409, 'Set up your community profile first', 'no_profile');
  if (profile.banned_at) throw new HttpError(403, 'Your community access has been removed', 'banned');
  return { ...a, profile };
}

async function poster(req: Request): Promise<Adult & { profile: ProfileRow }> {
  const m = await member(req);
  if (m.profile.muted_until && m.profile.muted_until > new Date()) {
    throw new HttpError(403, `You’re muted until ${m.profile.muted_until.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`, 'muted');
  }
  const { rows } = await pool.query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM forum_posts WHERE author_user_id = $1 AND created_at > now() - interval '1 hour')
          + (SELECT COUNT(*) FROM social_posts WHERE author_user_id = $1 AND created_at > now() - interval '1 hour') AS n`,
    [m.userId],
  );
  if (Number(rows[0]?.n ?? 0) >= POSTS_PER_HOUR) throw new HttpError(429, 'That’s a lot of posts this hour — take a breather and come back.', 'post_limit');
  return m;
}

/* ---------- shared bits ---------- */

const imageUrl = (id: number | null): string | null => (id ? `/api/community/images/${id}` : null);

const AUTHOR_COLS = `p.user_id AS a_id, p.display_name AS a_name, p.parent_badge AS a_badge,
  CASE WHEN ai.status = 'visible' THEN p.avatar_id END AS a_avatar`;
const AUTHOR_JOIN = (col: string): string => `JOIN social_profiles p ON p.user_id = ${col} LEFT JOIN community_images ai ON ai.id = p.avatar_id`;

interface AuthorCols {
  a_id: number;
  a_name: string;
  a_badge: boolean;
  a_avatar: number | null;
}
const author = (r: AuthorCols): CommunityAuthor => ({ userId: r.a_id, displayName: r.a_name, parentBadge: r.a_badge, avatarUrl: imageUrl(r.a_avatar) });

/** Neither side has blocked the other. $1 = the viewer. */
const NOT_BLOCKED = (col: string): string =>
  `NOT EXISTS (SELECT 1 FROM social_blocks b WHERE (b.blocker_user_id = $1 AND b.blocked_user_id = ${col}) OR (b.blocker_user_id = ${col} AND b.blocked_user_id = $1))`;

/** What a viewer may see: visible items, plus their own held ones ("under review"). $1 = the viewer. */
const SEEN = (alias: string): string => `(${alias}.status = 'visible' OR (${alias}.author_user_id = $1 AND ${alias}.status IN ('pending', 'hidden')))`;

interface Decision {
  status: CommunityStatus;
  priority: number;
  flags: ScreenReason[];
  note: ReviewNote;
}

async function decide(r: ScreenResult, where: string): Promise<Decision> {
  // Blocked (telling others to change medication, dangerous advice): never saved; say why and how to rephrase.
  if (r.block) {
    await logEvent('community_blocked', { where, reasons: r.reasons.join(',') }, null, null);
    throw new HttpError(422, r.explain ?? 'This can’t be posted as written.', 'blocked', { rephrase: r.rephrase ?? null, reasons: r.reasons.map((x) => SCREEN_REASONS[x]) });
  }
  const note: ReviewNote = { underReview: r.hold, crisis: r.crisis, reasons: r.reasons.map((x) => SCREEN_REASONS[x]) };
  if (r.crisis) {
    await logEvent('community_crisis', { where }, null, null);
    // No post text in the email: moderators read it inside the app.
    for (const to of config.adminEmails) {
      await sendMail({
        to,
        subject: 'MyDay community: a post may need urgent attention',
        text: `A ${where} post was held because someone may be in danger. Open the moderation queue now: ${config.publicUrl}/community/moderation`,
      }).catch(() => false);
    }
  } else if (r.hold) await logEvent('community_held', { where, reasons: r.reasons.join(',') }, null, null);
  else await logEvent('community_post', { where }, null, null);
  return { status: r.hold ? 'pending' : 'visible', priority: r.crisis ? 2 : r.hold ? 1 : 0, flags: r.reasons, note };
}

async function block(viewer: number, other: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM social_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2) OR (blocker_user_id = $2 AND blocked_user_id = $1)',
    [viewer, other],
  );
  return (rowCount ?? 0) > 0;
}

/* ---------- me + profile ---------- */

async function profileView(viewer: number, userId: number): Promise<CommunityProfile> {
  const p = await profileRow(userId);
  if (!p || p.banned_at || (viewer !== userId && (await block(viewer, userId)))) throw new HttpError(404, 'No such person');
  const { rows } = await pool.query<{ followers: number; following: number; posts: number; followed: boolean; blocked: boolean; avatar: number | null }>(
    `SELECT (SELECT COUNT(*)::int FROM social_follows WHERE followed_user_id = $2) AS followers,
            (SELECT COUNT(*)::int FROM social_follows WHERE follower_user_id = $2) AS following,
            (SELECT COUNT(*)::int FROM social_posts WHERE author_user_id = $2 AND status = 'visible') AS posts,
            EXISTS (SELECT 1 FROM social_follows WHERE follower_user_id = $1 AND followed_user_id = $2) AS followed,
            EXISTS (SELECT 1 FROM social_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2) AS blocked,
            (SELECT id FROM community_images WHERE id = $3 AND (status = 'visible' OR user_id = $1)) AS avatar`,
    [viewer, userId, p.avatar_id],
  );
  const c = rows[0];
  return {
    userId,
    displayName: p.display_name,
    bio: openText(p.bio_enc, p.key_id),
    parentBadge: p.parent_badge,
    avatarUrl: imageUrl(c?.avatar ?? null),
    followers: c?.followers ?? 0,
    following: c?.following ?? 0,
    posts: c?.posts ?? 0,
    shopSlug: p.shop_slug,
    shopUrl: shopUrl(p.shop_slug),
    joinedOn: p.created_at.toISOString().slice(0, 10),
    me: viewer === userId,
    followedByMe: c?.followed ?? false,
    blockedByMe: c?.blocked ?? false,
  };
}

communityRouter.get('/api/community/me', async (req, res) => {
  const a = await adult(req);
  const p = await profileRow(a.userId);
  const out: CommunityMe = {
    eligible: true,
    profile: p && !p.banned_at ? await profileView(a.userId, a.userId) : null,
    mutedUntil: p?.muted_until && p.muted_until > new Date() ? p.muted_until.toISOString() : null,
    banned: !!p?.banned_at,
    guidelines: COMMUNITY_GUIDELINES,
    isModerator: a.admin,
  };
  res.json(out);
});

/** First name only: one word, letters (plus ' and -). */
const FIRST_NAME = /^\p{L}[\p{L}'’-]{0,23}$/u;

communityRouter.put('/api/community/profile', async (req, res) => {
  const a = await adult(req);
  const b = req.body as Record<string, unknown>;
  const existing = await profileRow(a.userId);
  if (existing?.banned_at) throw new HttpError(403, 'Your community access has been removed', 'banned');
  const displayName = str(b.displayName, 'displayName', 24, true);
  if (!FIRST_NAME.test(displayName)) throw new HttpError(400, 'Use your first name only — one word, no last name.', 'first_name_only');
  const bio = str(b.bio, 'bio', 280);
  if (!existing && (b.adult !== true || b.guidelines !== true)) {
    throw new HttpError(400, 'Confirm you’re 18 or older and accept the community guidelines first', 'guidelines');
  }
  if (bio) {
    const s = await screenText(bio);
    if (s.hold) throw new HttpError(422, `Your bio can’t include: ${s.reasons.map((r) => SCREEN_REASONS[r]).join('; ')}`, 'bio_held');
  }
  let avatarId: number | null = existing?.avatar_id ?? null;
  if (b.avatarId === null) avatarId = null;
  else if (b.avatarId !== undefined) {
    const id = idParam(b.avatarId);
    const { rowCount } = await pool.query("SELECT 1 FROM community_images WHERE id = $1 AND user_id = $2 AND status <> 'removed'", [id, a.userId]);
    if (!rowCount) throw new HttpError(400, 'Upload the photo first');
    avatarId = id;
  }
  // Shop slot: a MonetizeMe storefront slug (letters, numbers, dashes). Omitted = unchanged; '' or null = remove.
  let shopSlug: string | null = existing?.shop_slug ?? null;
  if (b.shopSlug === null || b.shopSlug === '') shopSlug = null;
  else if (b.shopSlug !== undefined) {
    const v = String(b.shopSlug).trim().toLowerCase();
    if (!SHOP_SLUG.test(v)) throw new HttpError(400, 'Your shop name is the part after ?slug= in your MonetizeMe link — letters, numbers and dashes.', 'shop_slug');
    shopSlug = v;
  }
  const keyId = currentKeyId();
  await pool.query(
    `INSERT INTO social_profiles (user_id, display_name, bio_enc, key_id, avatar_id, parent_badge, adult_confirmed_at, guidelines_accepted_at, shop_slug)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now(), $7)
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, bio_enc = EXCLUDED.bio_enc, key_id = EXCLUDED.key_id,
       avatar_id = EXCLUDED.avatar_id, parent_badge = EXCLUDED.parent_badge, shop_slug = EXCLUDED.shop_slug`,
    [a.userId, displayName, bio ? sealText(bio, keyId) : null, keyId, avatarId, b.parentBadge === true, shopSlug],
  );
  res.json(await profileView(a.userId, a.userId));
});

/* ---------- photos (avatars + feed photos), sealed at rest ---------- */

function imageType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

communityUploadRouter.post(
  '/api/community/images',
  express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_IMAGE }),
  async (req: Request, res) => {
    if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
    const m = await poster(req);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = imageType(data);
    if (!mime) throw new HttpError(400, 'Photos must be JPEG, PNG or WebP');
    const s = await screenImage(data, mime);
    const d = await decide(s, 'photo');
    const keyId = currentKeyId();
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO community_images (user_id, data_enc, key_id, mime, status, flags) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [m.userId, sealBytes(data, keyId), keyId, mime, d.status === 'pending' ? 'pending' : 'visible', d.flags],
    );
    const id = rows[0]?.id ?? 0;
    res.status(201).json({ id, url: imageUrl(id), review: d.note });
  },
);

communityRouter.get('/api/community/images/:id', async (req, res) => {
  const m = await member(req);
  const { rows } = await pool.query<{ user_id: number; data_enc: Buffer; key_id: string; mime: string; status: string }>(
    'SELECT user_id, data_enc, key_id, mime, status FROM community_images WHERE id = $1',
    [idParam(req.params.id)],
  );
  const r = rows[0];
  if (!r || r.status === 'removed' || (r.status !== 'visible' && r.user_id !== m.userId && !m.admin) || (await block(m.userId, r.user_id))) {
    throw new HttpError(404, 'Not found');
  }
  res.set('Content-Type', r.mime).set('Cache-Control', 'private, no-store').send(openBytes(r.data_enc, r.key_id));
});

/* ---------- The Village ---------- */

const categoryOf = (v: unknown): VillageCategory => {
  const c = VILLAGE_CATEGORIES.find((x) => x.key === v)?.key;
  if (!c) throw new HttpError(400, 'Pick a category');
  return c;
};

communityRouter.get('/api/village', async (req, res) => {
  const m = await member(req);
  const cat = typeof req.query.category === 'string' && req.query.category ? categoryOf(req.query.category) : null;
  const { rows } = await pool.query<AuthorCols & { id: number; category: VillageCategory; title_enc: Buffer; key_id: string; status: CommunityStatus; last_activity_at: Date; replies: number; author_user_id: number; answered: boolean }>(
    `SELECT t.id, t.category, t.title_enc, t.key_id, t.status, t.last_activity_at, t.author_user_id, ${AUTHOR_COLS},
            (SELECT COUNT(*)::int FROM forum_posts x WHERE x.thread_id = t.id AND NOT x.opening AND x.status = 'visible') AS replies,
            EXISTS (SELECT 1 FROM trusted_answers a WHERE a.kind = 'village' AND a.target_id = t.id) AS answered
       FROM forum_threads t ${AUTHOR_JOIN('t.author_user_id')}
      WHERE ${SEEN('t')} AND ${NOT_BLOCKED('t.author_user_id')} AND ($2::text IS NULL OR t.category = $2)
      ORDER BY t.last_activity_at DESC LIMIT 100`,
    [m.userId, cat],
  );
  const threads: VillageThreadSummary[] = rows.map((r) => ({
    id: r.id,
    category: r.category,
    title: openText(r.title_enc, r.key_id),
    author: author(r),
    replies: r.replies,
    lastActivity: r.last_activity_at.toISOString(),
    answered: r.answered,
    status: r.status,
    mine: r.author_user_id === m.userId,
  }));
  res.json({ threads });
});

async function threadView(viewer: number, id: number): Promise<VillageThread> {
  const { rows: t } = await pool.query<{ id: number; category: VillageCategory; title_enc: Buffer; key_id: string; status: CommunityStatus; author_user_id: number }>(
    `SELECT t.id, t.category, t.title_enc, t.key_id, t.status, t.author_user_id FROM forum_threads t WHERE t.id = $2 AND ${SEEN('t')} AND ${NOT_BLOCKED('t.author_user_id')}`,
    [viewer, id],
  );
  const th = t[0];
  if (!th) throw new HttpError(404, 'No such thread');
  const { rows } = await pool.query<
    AuthorCols & { id: number; opening: boolean; body_enc: Buffer; key_id: string; status: CommunityStatus; created_at: Date; author_user_id: number; helpful_count: number; hearts: number; been: number; mine_r: string[] | null; helped: boolean }
  >(
    `SELECT x.id, x.opening, x.body_enc, x.key_id, x.status, x.created_at, x.author_user_id, x.helpful_count, ${AUTHOR_COLS},
            (SELECT COUNT(*)::int FROM forum_reactions r WHERE r.post_id = x.id AND r.kind = 'heart') AS hearts,
            (SELECT COUNT(*)::int FROM forum_reactions r WHERE r.post_id = x.id AND r.kind = 'been-there') AS been,
            (SELECT array_agg(r.kind) FROM forum_reactions r WHERE r.post_id = x.id AND r.user_id = $1) AS mine_r,
            EXISTS (SELECT 1 FROM forum_helpful h WHERE h.post_id = x.id AND h.user_id = $1) AS helped
       FROM forum_posts x ${AUTHOR_JOIN('x.author_user_id')}
      WHERE x.thread_id = $2 AND ${SEEN('x')} AND ${NOT_BLOCKED('x.author_user_id')}
      ORDER BY x.opening DESC, x.id`,
    [viewer, id],
  );
  const posts: VillagePost[] = rows.map((r) => ({
    id: r.id,
    opening: r.opening,
    author: author(r),
    body: openText(r.body_enc, r.key_id),
    at: r.created_at.toISOString(),
    status: r.status,
    mine: r.author_user_id === viewer,
    reactions: { heart: r.hearts, beenThere: r.been, mine: (r.mine_r ?? []) as Array<'heart' | 'been-there'> },
    helpful: r.helpful_count,
    markedHelpfulByMe: r.helped,
    check: null,
  }));
  const checks = await checksFor('village', posts.map((p) => p.id));
  for (const p of posts) p.check = checks.get(p.id) ?? null;
  const title = openText(th.title_enc, th.key_id);
  const opening = posts.find((p) => p.opening);
  const trusted = (await trustedFor('village', [th.id])).get(th.id) ?? null;
  // A moderator's pick must still be a visible reply.
  const pinned = trusted?.replyPostId && !posts.some((p) => p.id === trusted.replyPostId && p.status === 'visible') ? null : trusted;
  return { id: th.id, category: th.category, title, status: th.status, posts, isQuestion: isQuestion(`${title}\n${opening?.body ?? ''}`), trusted: pinned };
}

communityRouter.get('/api/village/threads/:id', async (req, res) => {
  const m = await member(req);
  res.json(await threadView(m.userId, idParam(req.params.id)));
});

communityRouter.post('/api/village/threads', async (req, res) => {
  const m = await poster(req);
  const b = req.body as Record<string, unknown>;
  const category = categoryOf(b.category);
  const title = str(b.title, 'title', 120, true);
  const body = str(b.body, 'body', 5000, true);
  const d = await decide(await screenText(`${title}\n\n${body}`), 'village');
  const keyId = currentKeyId();
  const id = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      'INSERT INTO forum_threads (category, author_user_id, title_enc, key_id, status) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [category, m.userId, sealText(title, keyId), keyId, d.status],
    );
    const tid = rows[0]?.id ?? 0;
    await c.query('INSERT INTO forum_posts (thread_id, author_user_id, opening, body_enc, key_id, status, priority, flags) VALUES ($1, $2, true, $3, $4, $5, $6, $7)', [
      tid, m.userId, sealText(body, keyId), keyId, d.status, d.priority, d.flags,
    ]);
    return tid;
  });
  if (d.status === 'visible') ensureTrusted('village', id, `${title}\n\n${body}`);
  res.status(201).json({ thread: await threadView(m.userId, id), review: d.note });
});

communityRouter.post('/api/village/threads/:id/replies', async (req, res) => {
  const m = await poster(req);
  const id = idParam(req.params.id);
  const th = await threadView(m.userId, id);
  if (th.status !== 'visible') throw new HttpError(409, 'This thread is under review');
  const body = str((req.body as Record<string, unknown>).body, 'body', 5000, true);
  const d = await decide(await screenText(body), 'village');
  const keyId = currentKeyId();
  await pool.query('INSERT INTO forum_posts (thread_id, author_user_id, body_enc, key_id, status, priority, flags) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    id, m.userId, sealText(body, keyId), keyId, d.status, d.priority, d.flags,
  ]);
  if (d.status === 'visible') await pool.query('UPDATE forum_threads SET last_activity_at = now() WHERE id = $1', [id]);
  res.status(201).json({ thread: await threadView(m.userId, id), review: d.note });
});

/** A visible forum post the viewer may interact with (not their own unless allowOwn). */
async function forumPost(viewer: number, id: number): Promise<{ thread_id: number; author_user_id: number; opening: boolean; status: CommunityStatus }> {
  const { rows } = await pool.query<{ thread_id: number; author_user_id: number; opening: boolean; status: CommunityStatus }>(
    `SELECT x.thread_id, x.author_user_id, x.opening, x.status FROM forum_posts x WHERE x.id = $2 AND ${SEEN('x')} AND ${NOT_BLOCKED('x.author_user_id')}`,
    [viewer, id],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

communityRouter.post('/api/village/posts/:id/react', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const kind = (req.body as Record<string, unknown>).kind;
  if (kind !== 'heart' && kind !== 'been-there') throw new HttpError(400, 'kind is heart or been-there');
  const p = await forumPost(m.userId, id);
  if (p.status !== 'visible') throw new HttpError(409, 'Under review');
  const del = await pool.query('DELETE FROM forum_reactions WHERE post_id = $1 AND user_id = $2 AND kind = $3', [id, m.userId, kind]);
  if (!del.rowCount) await pool.query('INSERT INTO forum_reactions (post_id, user_id, kind) VALUES ($1, $2, $3)', [id, m.userId, kind]);
  res.json(await threadView(m.userId, p.thread_id));
});

communityRouter.post('/api/village/posts/:id/helpful', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const p = await forumPost(m.userId, id);
  if (p.opening || p.author_user_id === m.userId || p.status !== 'visible') throw new HttpError(400, 'Mark someone else’s reply as helpful');
  const del = await pool.query('DELETE FROM forum_helpful WHERE post_id = $1 AND user_id = $2', [id, m.userId]);
  if (!del.rowCount) await pool.query('INSERT INTO forum_helpful (post_id, user_id) VALUES ($1, $2)', [id, m.userId]);
  await pool.query('UPDATE forum_posts SET helpful_count = (SELECT COUNT(*) FROM forum_helpful WHERE post_id = $1) WHERE id = $1', [id]);
  res.json(await threadView(m.userId, p.thread_id));
});

/** Keep a thread's status in step with its opening post. */
async function syncThread(postId: number): Promise<void> {
  await pool.query('UPDATE forum_threads t SET status = x.status FROM forum_posts x WHERE x.id = $1 AND x.opening AND t.id = x.thread_id', [postId]);
}

communityRouter.post('/api/village/posts/:id/report', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const p = await forumPost(m.userId, id);
  if (p.author_user_id === m.userId) throw new HttpError(400, 'You can’t report your own post');
  const reason = str((req.body as Record<string, unknown>).reason, 'reason', 200) || 'Reported';
  await pool.query('INSERT INTO forum_reports (post_id, reporter_user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.userId, reason]);
  const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM forum_reports WHERE post_id = $1 AND status = 'open'", [id]);
  const hidden = (rows[0]?.n ?? 0) >= HIDE_AT_REPORTS;
  if (hidden) {
    await pool.query("UPDATE forum_posts SET status = 'hidden', priority = GREATEST(priority, 1) WHERE id = $1 AND status = 'visible'", [id]);
    await syncThread(id);
  }
  res.status(201).json({ ok: true, hidden });
});

communityRouter.delete('/api/village/posts/:id', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const { rowCount } = await pool.query("UPDATE forum_posts SET status = 'removed' WHERE id = $1 AND author_user_id = $2", [id, m.userId]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  await syncThread(id);
  res.json({ ok: true });
});

/* ---------- The Feed ---------- */

type FeedRow = AuthorCols & { id: number; body_enc: Buffer; key_id: string; image_id: number | null; img_status: string | null; status: CommunityStatus; created_at: Date; author_user_id: number; like_count: number; liked: boolean };

const toFeed = (viewer: number, r: FeedRow): FeedPost => ({
  id: r.id,
  author: author(r),
  body: openText(r.body_enc, r.key_id),
  imageUrl: r.image_id && (r.img_status === 'visible' || r.author_user_id === viewer) ? imageUrl(r.image_id) : null,
  at: r.created_at.toISOString(),
  status: r.status,
  mine: r.author_user_id === viewer,
  likes: r.like_count,
  likedByMe: r.liked,
  check: null,
  isQuestion: isQuestion(openText(r.body_enc, r.key_id)),
  trusted: null,
});

/* ---------- Trusted Answers: shared checks + pinned answers ---------- */

async function checksFor(kind: 'feed' | 'village', ids: number[]): Promise<Map<number, PostCheck>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query<{ post_id: number; result_enc: Buffer; key_id: string }>('SELECT post_id, result_enc, key_id FROM community_checks WHERE kind = $1 AND post_id = ANY($2::int[])', [kind, ids]);
  return new Map(rows.map((r) => [r.post_id, JSON.parse(openText(r.result_enc, r.key_id)) as PostCheck]));
}

async function trustedFor(kind: 'feed' | 'village', ids: number[]): Promise<Map<number, TrustedAnswer>> {
  if (!ids.length) return new Map();
  const { rows } = await pool.query<{ target_id: number; source: TrustedAnswer['source']; body_enc: Buffer; key_id: string; sources: TrustedAnswer['sources']; reply_post_id: number | null; created_at: Date }>(
    'SELECT target_id, source, body_enc, key_id, sources, reply_post_id, created_at FROM trusted_answers WHERE kind = $1 AND target_id = ANY($2::int[])',
    [kind, ids],
  );
  return new Map(
    rows.map((r) => [
      r.target_id,
      {
        source: r.source,
        body: openText(r.body_enc, r.key_id),
        sources: r.sources,
        replyPostId: r.reply_post_id,
        by: r.source === 'moderator' ? 'A moderator' : r.source === 'publisher' ? (r.sources[0]?.label.split(':')[0] ?? 'A trusted publisher') : 'Hana',
        at: r.created_at.toISOString(),
      },
    ]),
  );
}

/** Background: a question that's live gets Hana's (or a publisher's) trusted answer, unless one is already pinned. */
function ensureTrusted(kind: 'feed' | 'village', targetId: number, text: string): void {
  if (!isQuestion(text)) return;
  detached(async () => {
    const has = await asSystem(() => pool.query('SELECT 1 FROM trusted_answers WHERE kind = $1 AND target_id = $2', [kind, targetId]));
    if (has.rowCount) return;
    const a = await answerQuestion(text);
    if (!a) return;
    const keyId = currentKeyId();
    await asSystem(() =>
      pool.query('INSERT INTO trusted_answers (kind, target_id, source, body_enc, key_id, sources) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, target_id) DO NOTHING', [
        kind, targetId, a.source, sealText(a.body, keyId), keyId, JSON.stringify(a.sources),
      ]),
    );
  });
}

const verifyCount = new Map<number, number[]>();
/** Fair use for "Verify with Hana": 30 checks an hour per person (a cached check costs nothing). */
function verifyAllowed(userId: number): boolean {
  const now = Date.now();
  const recent = (verifyCount.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  verifyCount.set(userId, recent);
  return true;
}

async function feedPage(viewer: number, o: { tab: 'following' | 'everyone'; author: number | null; before: number | null; id?: number }): Promise<FeedPage> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT s.id, s.body_enc, s.key_id, s.image_id, i.status AS img_status, s.status, s.created_at, s.author_user_id, s.like_count, ${AUTHOR_COLS},
            EXISTS (SELECT 1 FROM social_likes l WHERE l.post_id = s.id AND l.user_id = $1) AS liked
       FROM social_posts s ${AUTHOR_JOIN('s.author_user_id')} LEFT JOIN community_images i ON i.id = s.image_id
      WHERE ${SEEN('s')} AND ${NOT_BLOCKED('s.author_user_id')} AND p.banned_at IS NULL
        AND ($2::text <> 'following' OR s.author_user_id = $1 OR EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = s.author_user_id))
        AND ($3::int IS NULL OR s.author_user_id = $3)
        AND ($4::int IS NULL OR s.id < $4)
        AND ($5::int IS NULL OR s.id = $5)
        AND ($3::int IS NOT NULL OR $5::int IS NOT NULL OR s.created_at > now() - make_interval(days => $6))
      ORDER BY s.id DESC LIMIT $7`,
    [viewer, o.tab, o.author, o.before, o.id ?? null, FEED_WINDOW_DAYS, o.author !== null ? 30 : FEED_MAX],
  );
  const posts = rows.map((r) => toFeed(viewer, r));
  const ids = posts.map((p) => p.id);
  const [checks, trusted] = await Promise.all([checksFor('feed', ids), trustedFor('feed', ids)]);
  for (const p of posts) {
    p.check = checks.get(p.id) ?? null;
    p.trusted = trusted.get(p.id) ?? null;
  }
  return { posts, next: null, windowDays: o.author !== null ? 0 : FEED_WINDOW_DAYS };
}

communityRouter.get('/api/feed', async (req, res) => {
  const m = await member(req);
  const tab = req.query.tab === 'following' ? 'following' : 'everyone';
  const authorId = typeof req.query.author === 'string' && req.query.author ? idParam(req.query.author) : null;
  const before = typeof req.query.before === 'string' && req.query.before ? idParam(req.query.before) : null;
  res.json(await feedPage(m.userId, { tab, author: authorId, before }));
});

/** "Verify with Hana": a shared, inline fact-check of a visible post (made once, then everyone sees it). */
communityRouter.post('/api/community/verify', async (req, res) => {
  const m = await member(req);
  const b = req.body as { kind?: unknown; id?: unknown };
  const kind = b.kind === 'village' ? 'village' : b.kind === 'feed' ? 'feed' : null;
  if (!kind) throw new HttpError(400, 'Which post?');
  const id = idParam(b.id);
  const table = kind === 'feed' ? 'social_posts' : 'forum_posts';
  const { rows } = await pool.query<{ body_enc: Buffer; key_id: string }>(
    `SELECT s.body_enc, s.key_id FROM ${table} s WHERE s.id = $2 AND s.status = 'visible' AND ${NOT_BLOCKED('s.author_user_id')}`,
    [m.userId, id],
  );
  const post = rows[0];
  if (!post) throw new HttpError(404, 'Not found');
  const have = (await checksFor(kind, [id])).get(id);
  if (have) {
    res.json({ check: have });
    return;
  }
  const text = openText(post.body_enc, post.key_id);
  if (!text.trim()) throw new HttpError(400, 'There’s nothing written to check');
  if (!verifyAllowed(m.userId)) throw new HttpError(429, 'That’s a lot of checks this hour — try again a bit later.');
  const check = await verifyClaim(text);
  const keyId = currentKeyId();
  await pool.query('INSERT INTO community_checks (kind, post_id, verdict, result_enc, key_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (kind, post_id) DO NOTHING', [
    kind, id, check.verdict, sealText(JSON.stringify(check), keyId), keyId, m.userId,
  ]);
  res.json({ check: (await checksFor(kind, [id])).get(id) ?? check });
});

/** Moderators: mark a reply as the question's trusted answer (it's pinned above every other reply). */
communityStaffRouter.post('/api/village/posts/:id/trusted', async (req, res) => {
  staff(req);
  const by = req.user?.id ?? null;
  const id = idParam(req.params.id);
  const { rows } = await pool.query<{ thread_id: number; body_enc: Buffer; key_id: string }>(
    "SELECT thread_id, body_enc, key_id FROM forum_posts WHERE id = $1 AND NOT opening AND status = 'visible'",
    [id],
  );
  const reply = rows[0];
  if (!reply) throw new HttpError(404, 'Pick a visible reply');
  const keyId = currentKeyId();
  await pool.query(
    `INSERT INTO trusted_answers (kind, target_id, source, body_enc, key_id, sources, reply_post_id, marked_by) VALUES ('village', $1, 'moderator', $2, $3, '[]', $4, $5)
     ON CONFLICT (kind, target_id) DO UPDATE SET source = 'moderator', body_enc = EXCLUDED.body_enc, key_id = EXCLUDED.key_id, sources = '[]',
       reply_post_id = EXCLUDED.reply_post_id, marked_by = EXCLUDED.marked_by, created_at = now()`,
    [reply.thread_id, sealText(openText(reply.body_enc, reply.key_id), keyId), keyId, id, by],
  );
  await logEvent('community_moderation', { kind: 'village', action: 'trusted' }, null, null);
  res.json(await threadView(by ?? 0, reply.thread_id));
});

/** Around the Web: trusted publishers' articles (screened), newest first, the last 30 days (publishers post less often than people). */
communityRouter.get('/api/feed/web', async (req, res) => {
  await member(req);
  const { rows } = await pool.query<{ id: number; publisher: string; title: string; summary: string; url: string; published_at: Date }>(
    `SELECT id, publisher, title, summary, url, published_at FROM web_items
      WHERE status = 'visible' AND published_at > now() - interval '30 days' ORDER BY published_at DESC LIMIT 30`,
  );
  const items: WebItem[] = rows.map((r) => ({ id: r.id, publisher: r.publisher, title: r.title, summary: r.summary, url: r.url, publishedAt: r.published_at.toISOString() }));
  res.json({ items });
});

/** Moderators: read the publishers' feeds now (it also runs every few hours). */
communityStaffRouter.post('/api/feed/web/refresh', async (req, res) => {
  if (!req.user || !config.adminEmails.includes(req.user.email.toLowerCase())) throw new HttpError(403, 'Moderators only');
  res.json(await refreshWebFeeds());
});

async function onePost(viewer: number, id: number): Promise<FeedPost> {
  const p = (await feedPage(viewer, { tab: 'everyone', author: null, before: null, id })).posts[0];
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

communityRouter.post('/api/feed/posts', async (req, res) => {
  const m = await poster(req);
  const b = req.body as Record<string, unknown>;
  const body = str(b.body, 'body', 2000);
  let imageId: number | null = null;
  let imagePending = false;
  if (b.imageId != null) {
    imageId = idParam(b.imageId);
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM community_images WHERE id = $1 AND user_id = $2 AND status <> 'removed'", [imageId, m.userId]);
    if (!rows[0]) throw new HttpError(400, 'Upload the photo first');
    imagePending = rows[0].status === 'pending';
  }
  if (!body && !imageId) throw new HttpError(400, 'Write something or add a photo');
  const s = body ? await screenText(body) : { hold: false, crisis: false, reasons: [] };
  if (imagePending) s.hold = true;
  if (imagePending && !s.reasons.includes('image')) s.reasons.push('image');
  const d = await decide(s, 'feed');
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO social_posts (author_user_id, body_enc, key_id, image_id, status, priority, flags) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [m.userId, sealText(body, keyId), keyId, imageId, d.status, d.priority, d.flags],
  );
  if (d.status === 'visible' && body) ensureTrusted('feed', rows[0]?.id ?? 0, body);
  res.status(201).json({ post: await onePost(m.userId, rows[0]?.id ?? 0), review: d.note });
});

async function socialPost(viewer: number, id: number): Promise<{ author_user_id: number; status: CommunityStatus }> {
  const { rows } = await pool.query<{ author_user_id: number; status: CommunityStatus }>(
    `SELECT s.author_user_id, s.status FROM social_posts s WHERE s.id = $2 AND ${SEEN('s')} AND ${NOT_BLOCKED('s.author_user_id')}`,
    [viewer, id],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Not found');
  return p;
}

communityRouter.post('/api/feed/posts/:id/like', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const p = await socialPost(m.userId, id);
  if (p.status !== 'visible') throw new HttpError(409, 'Under review');
  const del = await pool.query('DELETE FROM social_likes WHERE post_id = $1 AND user_id = $2', [id, m.userId]);
  if (!del.rowCount) await pool.query('INSERT INTO social_likes (post_id, user_id) VALUES ($1, $2)', [id, m.userId]);
  await pool.query('UPDATE social_posts SET like_count = (SELECT COUNT(*) FROM social_likes WHERE post_id = $1) WHERE id = $1', [id]);
  res.json(await onePost(m.userId, id));
});

communityRouter.post('/api/feed/posts/:id/report', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const p = await socialPost(m.userId, id);
  if (p.author_user_id === m.userId) throw new HttpError(400, 'You can’t report your own post');
  const reason = str((req.body as Record<string, unknown>).reason, 'reason', 200) || 'Reported';
  await pool.query('INSERT INTO social_reports (post_id, reporter_user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.userId, reason]);
  const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM social_reports WHERE post_id = $1 AND status = 'open'", [id]);
  const hidden = (rows[0]?.n ?? 0) >= HIDE_AT_REPORTS;
  if (hidden) await pool.query("UPDATE social_posts SET status = 'hidden', priority = GREATEST(priority, 1) WHERE id = $1 AND status = 'visible'", [id]);
  res.status(201).json({ ok: true, hidden });
});

communityRouter.delete('/api/feed/posts/:id', async (req, res) => {
  const m = await member(req);
  const { rowCount } = await pool.query("UPDATE social_posts SET status = 'removed' WHERE id = $1 AND author_user_id = $2", [idParam(req.params.id), m.userId]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

/* ---------- people: profiles, follows, blocks, reports ---------- */

communityRouter.get('/api/community/people/:id', async (req, res) => {
  const m = await member(req);
  res.json(await profileView(m.userId, idParam(req.params.id)));
});

communityRouter.post('/api/community/people/:id/follow', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  if (id === m.userId) throw new HttpError(400, 'You can’t follow yourself');
  await profileView(m.userId, id); // must be a visible, unblocked grown-up's profile
  await pool.query('INSERT INTO social_follows (follower_user_id, followed_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.userId, id]);
  res.json(await profileView(m.userId, id));
});

communityRouter.delete('/api/community/people/:id/follow', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  await pool.query('DELETE FROM social_follows WHERE follower_user_id = $1 AND followed_user_id = $2', [m.userId, id]);
  res.json(await profileView(m.userId, id));
});

for (const which of ['followers', 'following'] as const) {
  communityRouter.get(`/api/community/people/:id/${which}`, async (req, res) => {
    const m = await member(req);
    const id = idParam(req.params.id);
    await profileView(m.userId, id);
    const [me, them] = which === 'followers' ? ['f.follower_user_id', 'f.followed_user_id'] : ['f.followed_user_id', 'f.follower_user_id'];
    const { rows } = await pool.query<AuthorCols>(
      `SELECT ${AUTHOR_COLS} FROM social_follows f ${AUTHOR_JOIN(me)}
        WHERE ${them} = $2 AND p.banned_at IS NULL AND ${NOT_BLOCKED(me)} ORDER BY f.created_at DESC LIMIT 500`,
      [m.userId, id],
    );
    res.json({ people: rows.map(author) });
  });
}

communityRouter.post('/api/community/people/:id/block', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  if (id === m.userId) throw new HttpError(400, 'You can’t block yourself');
  if (!(await profileRow(id))) throw new HttpError(404, 'No such person');
  await pool.query('INSERT INTO social_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.userId, id]);
  await pool.query('DELETE FROM social_follows WHERE (follower_user_id = $1 AND followed_user_id = $2) OR (follower_user_id = $2 AND followed_user_id = $1)', [m.userId, id]);
  res.json({ ok: true, blocked: true });
});

communityRouter.delete('/api/community/people/:id/block', async (req, res) => {
  const m = await member(req);
  await pool.query('DELETE FROM social_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2', [m.userId, idParam(req.params.id)]);
  res.json({ ok: true, blocked: false });
});

communityRouter.post('/api/community/people/:id/report', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  if (id === m.userId) throw new HttpError(400, 'You can’t report yourself');
  await profileView(m.userId, id);
  const reason = str((req.body as Record<string, unknown>).reason, 'reason', 200) || 'Reported';
  await pool.query('INSERT INTO social_reports (profile_user_id, reporter_user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.userId, reason]);
  res.status(201).json({ ok: true });
});

/* ---------- moderation (MyDay admins) ---------- */

function staff(req: Request): string {
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (!isAdmin(req)) throw new HttpError(403, 'Moderators only');
  return req.user.email;
}

interface QueueRow {
  id: number;
  user_id: number;
  display_name: string | null;
  email: string;
  strikes: number;
  title_enc: Buffer | null;
  title_key: string | null;
  body_enc: Buffer | null;
  key_id: string;
  image_id: number | null;
  status: CommunityStatus;
  priority: number;
  flags: string[];
  reports: string[] | null;
  created_at: Date;
}

const WHO = `JOIN users u ON u.id = q.user_id LEFT JOIN social_profiles sp ON sp.user_id = q.user_id`;
const WHO_COLS = `sp.display_name, u.email, (SELECT COUNT(*)::int FROM social_strikes k WHERE k.user_id = q.user_id) AS strikes`;

async function queue(): Promise<CommunityQueue> {
  const items: CommunityQueueItem[] = [];
  const push = (kind: CommunityQueueItem['kind'], r: QueueRow): void => {
    items.push({
      kind,
      id: r.id,
      author: { userId: r.user_id, displayName: r.display_name ?? '(no profile)', email: r.email, strikes: r.strikes },
      title: r.title_enc && r.title_key ? openText(r.title_enc, r.title_key) : null,
      body: r.body_enc ? openText(r.body_enc, r.key_id) : '',
      imageUrl: imageUrl(r.image_id),
      status: r.status,
      priority: r.priority,
      reasons: r.flags.map((f) => SCREEN_REASONS[f as ScreenReason] ?? f),
      reports: r.reports ?? [],
      at: r.created_at.toISOString(),
    });
  };
  const { rows: forum } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, CASE WHEN q.opening THEN t.title_enc END AS title_enc, t.key_id AS title_key, q.body_enc, q.key_id, NULL::int AS image_id,
            q.status, q.priority, q.flags, q.created_at,
            (SELECT array_agg(r.reason ORDER BY r.id) FROM forum_reports r WHERE r.post_id = q.id AND r.status = 'open') AS reports
       FROM (SELECT x.*, x.author_user_id AS user_id FROM forum_posts x) q JOIN forum_threads t ON t.id = q.thread_id ${WHO}
      WHERE q.status IN ('pending', 'hidden') OR EXISTS (SELECT 1 FROM forum_reports r WHERE r.post_id = q.id AND r.status = 'open')`,
  );
  for (const r of forum) push('village', r);
  const { rows: feed } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, q.body_enc, q.key_id, q.image_id, q.status, q.priority, q.flags, q.created_at,
            (SELECT array_agg(r.reason ORDER BY r.id) FROM social_reports r WHERE r.post_id = q.id AND r.status = 'open') AS reports
       FROM (SELECT s.*, s.author_user_id AS user_id FROM social_posts s) q ${WHO}
      WHERE q.status IN ('pending', 'hidden') OR EXISTS (SELECT 1 FROM social_reports r WHERE r.post_id = q.id AND r.status = 'open')`,
  );
  for (const r of feed) push('feed', r);
  const { rows: imgs } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, NULL::bytea AS body_enc, q.key_id, q.id AS image_id,
            q.status, 1 AS priority, q.flags, q.created_at, NULL::text[] AS reports
       FROM community_images q ${WHO}
      WHERE q.status = 'pending' AND NOT EXISTS (SELECT 1 FROM social_posts s WHERE s.image_id = q.id)`,
  );
  for (const r of imgs) push('image', r);
  const { rows: profs } = await pool.query<QueueRow>(
    `SELECT q.user_id AS id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, sp.bio_enc AS body_enc, COALESCE(sp.key_id, 's') AS key_id,
            sp.avatar_id AS image_id, 'visible' AS status, 0 AS priority, '{}'::text[] AS flags, min(q.created_at) AS created_at,
            array_agg(q.reason ORDER BY q.id) AS reports
       FROM (SELECT r.*, r.profile_user_id AS user_id FROM social_reports r WHERE r.profile_user_id IS NOT NULL AND r.status = 'open') q ${WHO}
      GROUP BY q.user_id, sp.display_name, u.email, sp.bio_enc, sp.key_id, sp.avatar_id`,
  );
  for (const r of profs) push('profile', r);
  items.sort((a, b) => b.priority - a.priority || a.at.localeCompare(b.at));
  return { items };
}

communityStaffRouter.get('/api/community/moderation/queue', async (req, res) => {
  staff(req);
  res.json(await queue());
});

/** warn → 7-day mute → ban, by how many strikes they already have. */
async function strike(userId: number, reason: string, source: string, by: string): Promise<'warn' | 'mute' | 'ban'> {
  const { rows } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM social_strikes WHERE user_id = $1', [userId]);
  const n = rows[0]?.n ?? 0;
  const kind = n === 0 ? 'warn' : n === 1 ? 'mute' : 'ban';
  await pool.query('INSERT INTO social_strikes (user_id, kind, reason, source, by_email) VALUES ($1, $2, $3, $4, $5)', [userId, kind, reason, source, by]);
  if (kind === 'mute') await pool.query(`UPDATE social_profiles SET muted_until = now() + interval '${MUTE_DAYS} days' WHERE user_id = $1`, [userId]);
  if (kind === 'ban') await pool.query('UPDATE social_profiles SET banned_at = now() WHERE user_id = $1', [userId]);
  await logEvent('community_strike', { kind, source }, null, null);
  return kind;
}

/** approve | remove | strike (remove + strike) | dismiss (close reports, leave as is). */
communityStaffRouter.post('/api/community/moderation/:kind/:id/:action', async (req, res) => {
  const by = staff(req);
  const kind = req.params.kind;
  const action = ['approve', 'remove', 'strike', 'dismiss'].find((a) => a === req.params.action);
  const id = idParam(req.params.id);
  if (!action || !['village', 'feed', 'image', 'profile'].includes(kind)) throw new HttpError(404, 'Not found');
  const reason = str((req.body as Record<string, unknown> | undefined)?.reason, 'reason', 200) || 'Broke the community guidelines';
  let author: number | null = null;
  if (kind === 'village' || kind === 'feed') {
    const [table, reports] = kind === 'village' ? ['forum_posts', 'forum_reports'] : ['social_posts', 'social_reports'];
    const { rows } = await pool.query<{ author_user_id: number }>(`SELECT author_user_id FROM ${table} WHERE id = $1`, [id]);
    author = rows[0]?.author_user_id ?? null;
    if (author === null) throw new HttpError(404, 'Not found');
    if (action === 'approve') await pool.query(`UPDATE ${table} SET status = 'visible', priority = 0 WHERE id = $1`, [id]);
    if (action === 'remove' || action === 'strike') await pool.query(`UPDATE ${table} SET status = 'removed', priority = 0 WHERE id = $1`, [id]);
    if (action === 'approve' && kind === 'feed') await pool.query("UPDATE community_images i SET status = 'visible' FROM social_posts s WHERE s.id = $1 AND i.id = s.image_id AND i.status = 'pending'", [id]);
    await pool.query(`UPDATE ${reports} SET status = 'resolved', resolution = $2 WHERE post_id = $1 AND status = 'open'`, [id, action]);
    if (action === 'approve') {
      if (kind === 'feed') {
        const { rows: p } = await pool.query<{ body_enc: Buffer; key_id: string }>('SELECT body_enc, key_id FROM social_posts WHERE id = $1', [id]);
        if (p[0]) ensureTrusted('feed', id, openText(p[0].body_enc, p[0].key_id));
      } else {
        const { rows: p } = await pool.query<{ thread_id: number; body_enc: Buffer; key_id: string; title_enc: Buffer; tkey: string }>(
          'SELECT x.thread_id, x.body_enc, x.key_id, t.title_enc, t.key_id AS tkey FROM forum_posts x JOIN forum_threads t ON t.id = x.thread_id WHERE x.id = $1 AND x.opening',
          [id],
        );
        if (p[0]) ensureTrusted('village', p[0].thread_id, `${openText(p[0].title_enc, p[0].tkey)}\n\n${openText(p[0].body_enc, p[0].key_id)}`);
      }
    }
    if (kind === 'village') {
      await syncThread(id);
      if (action === 'approve') await pool.query('UPDATE forum_threads t SET last_activity_at = now() FROM forum_posts x WHERE x.id = $1 AND t.id = x.thread_id', [id]);
    }
  } else if (kind === 'image') {
    const { rows } = await pool.query<{ user_id: number }>('SELECT user_id FROM community_images WHERE id = $1', [id]);
    author = rows[0]?.user_id ?? null;
    if (author === null) throw new HttpError(404, 'Not found');
    if (action === 'approve') await pool.query("UPDATE community_images SET status = 'visible' WHERE id = $1", [id]);
    if (action === 'remove' || action === 'strike') await pool.query("UPDATE community_images SET status = 'removed' WHERE id = $1", [id]);
  } else {
    author = id;
    if (action === 'remove') throw new HttpError(400, 'Profiles: dismiss or strike');
    await pool.query("UPDATE social_reports SET status = 'resolved', resolution = $2 WHERE profile_user_id = $1 AND status = 'open'", [id, action]);
  }
  const struck = action === 'strike' ? await strike(author, reason, kind, by) : null;
  await logEvent('community_moderation', { kind, action }, null, null);
  res.json({ ...(await queue()), struck });
});

/* ---------- your data (account export) ---------- */

export async function communityExport(userId: number): Promise<Record<string, unknown>> {
  const p = await profileRow(userId);
  const { rows: forum } = await pool.query<{ id: number; thread_id: number; opening: boolean; body_enc: Buffer; key_id: string; status: string; created_at: Date }>(
    'SELECT id, thread_id, opening, body_enc, key_id, status, created_at FROM forum_posts WHERE author_user_id = $1 ORDER BY id',
    [userId],
  );
  const { rows: feed } = await pool.query<{ id: number; body_enc: Buffer; key_id: string; status: string; created_at: Date }>(
    'SELECT id, body_enc, key_id, status, created_at FROM social_posts WHERE author_user_id = $1 ORDER BY id',
    [userId],
  );
  const { rows: strikes } = await pool.query('SELECT kind, reason, created_at FROM social_strikes WHERE user_id = $1 ORDER BY id', [userId]);
  return {
    profile: p ? { displayName: p.display_name, bio: openText(p.bio_enc, p.key_id), parentBadge: p.parent_badge } : null,
    villagePosts: forum.map((r) => ({ id: r.id, thread: r.thread_id, opening: r.opening, body: openText(r.body_enc, r.key_id), status: r.status, at: r.created_at })),
    feedPosts: feed.map((r) => ({ id: r.id, body: openText(r.body_enc, r.key_id), status: r.status, at: r.created_at })),
    strikes,
  };
}
