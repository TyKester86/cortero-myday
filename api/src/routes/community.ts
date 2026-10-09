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
  type SponsoredItem,
  type VillageCategory,
  type VillagePost,
  type VillageThread,
  type VillageThreadSummary,
  type WebItem,
  FEED_INTERESTS,
  USERNAME_RE,
  type FeedOnboarding,
  type FeedSuggestion,
  type VillageInfo,
} from '@myday/shared';
import { onFeedApp } from '../lib/hosts.js';
import { milestone, notify, notifyMentions } from '../lib/feednotify.js';
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

/**
 * Grown-ups (18+) only. Kids and teens in a household stop here with a 403. The Feed is free and open to
 * anyone with the app: an account without a household gets in too — its age is checked by date of birth
 * when it sets up its Feed profile (18+), and every route after that needs the profile.
 */
export async function adult(req: Request): Promise<Adult> {
  const me = req.member;
  if (!req.user) throw new HttpError(401, 'Not signed in');
  if (me) {
    if (me.kind !== 'adult' || (await isTeen(me.id))) throw new HttpError(403, 'The Feed is for grown-ups (18+) only', 'adults_only');
    if (typeof req.query.member === 'string' && req.query.member !== me.key) throw new HttpError(403, 'The community is always you, never someone you act for');
  }
  return { userId: req.user.id, admin: isAdmin(req) };
}

/** Whole years between a date of birth and today. */
export function ageFrom(dob: string | Date | null): number | null {
  if (!dob) return null;
  const d = typeof dob === 'string' ? new Date(`${dob}T12:00:00Z`) : dob;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a -= 1;
  return a;
}

export interface ProfileRow {
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
  dob: string | null;
  height_in: string | null;
  location: string | null;
  username: string | null;
  interests: string[];
  onboarded_at: Date | null;
}

/** Where MonetizeMe storefronts live (a creator's shop is <base>/creator/?slug=<slug>). */
const shopUrl = (slug: string | null): string | null =>
  slug ? `${(process.env.MONETIZEME_URL || 'https://opsentra.app').replace(/\/$/, '')}/creator/?slug=${encodeURIComponent(slug)}` : null;
const SHOP_SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;

/** The Feed's window: the last week, then "you're caught up". */
const FEED_WINDOW_DAYS = 7;
const FEED_MAX = 60;

export async function profileRow(userId: number): Promise<ProfileRow | null> {
  const { rows } = await pool.query<ProfileRow>('SELECT *, dob::text AS dob FROM social_profiles WHERE user_id = $1', [userId]);
  return rows[0] ?? null;
}

/** Signed-up member (profile + guidelines accepted), not banned. Muted people can still read. */
export async function member(req: Request): Promise<Adult & { profile: ProfileRow }> {
  const a = await adult(req);
  const profile = await profileRow(a.userId);
  if (!profile) throw new HttpError(409, 'Set up your community profile first', 'no_profile');
  if (profile.banned_at) throw new HttpError(403, 'Your community access has been removed', 'banned');
  return { ...a, profile };
}

/** Someone allowed to post: not muted, and under the hourly limit (messages have their own limit: `limit = false`). */
export async function poster(req: Request, limit = true): Promise<Adult & { profile: ProfileRow }> {
  const m = await member(req);
  if (m.profile.muted_until && m.profile.muted_until > new Date()) {
    throw new HttpError(403, `You’re muted until ${m.profile.muted_until.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`, 'muted');
  }
  if (!limit) return m;
  const { rows } = await pool.query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM forum_posts WHERE author_user_id = $1 AND created_at > now() - interval '1 hour')
          + (SELECT COUNT(*) FROM social_posts WHERE author_user_id = $1 AND created_at > now() - interval '1 hour')
          + (SELECT COUNT(*) FROM social_stories WHERE author_user_id = $1 AND created_at > now() - interval '1 hour')
          + (SELECT COUNT(*) FROM social_clips WHERE author_user_id = $1 AND created_at > now() - interval '1 hour')
          + (SELECT COUNT(*) FROM social_clip_comments WHERE author_user_id = $1 AND created_at > now() - interval '1 hour') AS n`,
    [m.userId],
  );
  if (Number(rows[0]?.n ?? 0) >= POSTS_PER_HOUR) throw new HttpError(429, 'That’s a lot of posts this hour — take a breather and come back.', 'post_limit');
  return m;
}

/* ---------- shared bits ---------- */

export const imageUrl = (id: number | null): string | null => (id ? `/api/community/images/${id}` : null);

export const AUTHOR_COLS = `p.user_id AS a_id, p.display_name AS a_name, p.parent_badge AS a_badge,
  CASE WHEN ai.status = 'visible' THEN p.avatar_id END AS a_avatar`;
export const AUTHOR_JOIN = (col: string): string => `JOIN social_profiles p ON p.user_id = ${col} LEFT JOIN community_images ai ON ai.id = p.avatar_id`;

export interface AuthorCols {
  a_id: number;
  a_name: string;
  a_badge: boolean;
  a_avatar: number | null;
}
export const author = (r: AuthorCols): CommunityAuthor => ({ userId: r.a_id, displayName: r.a_name, parentBadge: r.a_badge, avatarUrl: imageUrl(r.a_avatar) });

/** Neither side has blocked the other. $1 = the viewer. */
export const NOT_BLOCKED = (col: string): string =>
  `NOT EXISTS (SELECT 1 FROM social_blocks b WHERE (b.blocker_user_id = $1 AND b.blocked_user_id = ${col}) OR (b.blocker_user_id = ${col} AND b.blocked_user_id = $1))`;

/** What a viewer may see: visible items, plus their own held ones ("under review"). $1 = the viewer. */
export const SEEN = (alias: string): string => `(${alias}.status = 'visible' OR (${alias}.author_user_id = $1 AND ${alias}.status IN ('pending', 'hidden')))`;

export interface Decision {
  status: CommunityStatus;
  priority: number;
  flags: ScreenReason[];
  note: ReviewNote;
}

export async function decide(r: ScreenResult, where: string): Promise<Decision> {
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

export async function block(viewer: number, other: number): Promise<boolean> {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM social_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2) OR (blocker_user_id = $2 AND blocked_user_id = $1)',
    [viewer, other],
  );
  return (rowCount ?? 0) > 0;
}

/* ---------- me + profile ---------- */

export async function profileView(viewer: number, userId: number): Promise<CommunityProfile> {
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
  // Date of birth + height: the Feed profile's own, else the person's household record (health section).
  const { rows: hm } = await asSystem(() =>
    pool.query<{ dob: string | null; height_in: string | null }>(
      'SELECT m.dob::text AS dob, m.height_in FROM users u JOIN household_members m ON m.id = u.member_id WHERE u.id = $1',
      [userId],
    ),
  );
  const dob = p.dob ?? hm[0]?.dob ?? null;
  const heightRaw = p.height_in ?? hm[0]?.height_in ?? null;
  const { rows: ex } = await pool.query<{ clips: number; days: string[]; photos: number; helpful: number; today: string }>(
    `SELECT (now() AT TIME ZONE $2)::date::text AS today,
            (SELECT COUNT(*)::int FROM social_clips WHERE author_user_id = $1 AND status = 'visible') AS clips,
            (SELECT COUNT(*)::int FROM social_posts WHERE author_user_id = $1 AND status = 'visible' AND image_id IS NOT NULL) AS photos,
            (SELECT COALESCE(SUM(helpful_count), 0)::int FROM forum_posts WHERE author_user_id = $1 AND status = 'visible') AS helpful,
            ARRAY(SELECT DISTINCT d::text FROM (
               SELECT (created_at AT TIME ZONE $2)::date AS d FROM social_posts WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM social_clips WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM social_stories WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
               UNION SELECT (created_at AT TIME ZONE $2)::date FROM forum_posts WHERE author_user_id = $1 AND status <> 'removed' AND created_at > now() - interval '400 days'
             ) x) AS days`,
    [userId, config.tz],
  );
  const e = ex[0];
  const days = new Set(e?.days ?? []);
  // Day by day back from today (the database's today, in the app's time zone — the same clock that dated the posts).
  const ymd = (d: Date): string => d.toISOString().slice(0, 10);
  let streak = 0;
  const cursor = new Date(`${e?.today ?? ymd(new Date())}T12:00:00Z`);
  if (!days.has(ymd(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(ymd(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const { rows: prov } = await pool.query<{ license_type: string; license_state: string; license_number: string; specialties: string[]; status: string; submitted_at: Date; verified_at: Date | null; reject_reason: string | null }>(
    'SELECT license_type, license_state, license_number, specialties, status, submitted_at, verified_at, reject_reason FROM provider_credentials WHERE user_id = $1',
    [userId],
  );
  const pc = prov[0];
  const provider =
    pc && pc.status === 'verified' && pc.verified_at
      ? { licenseType: pc.license_type, licenseState: pc.license_state, licenseNumber: pc.license_number, verifiedAt: pc.verified_at.toISOString().slice(0, 10), specialties: pc.specialties }
      : null;
  const achievements: Array<{ key: string; label: string }> = [];
  if (p.created_at < new Date('2027-01-01T00:00:00Z')) achievements.push({ key: 'early', label: 'Early Member' });
  if (streak >= 21) achievements.push({ key: 'streak', label: '21-Day Streak' });
  else if (streak >= 7) achievements.push({ key: 'streak', label: '7-Day Streak' });
  if ((e?.photos ?? 0) > 0) achievements.push({ key: 'photo', label: 'Photo Pick' });
  if ((e?.clips ?? 0) > 0) achievements.push({ key: 'clips', label: 'Clip Creator' });
  if ((e?.helpful ?? 0) >= 3) achievements.push({ key: 'helper', label: 'Community Helper' });
  if (provider) achievements.push({ key: 'provider', label: 'Verified Provider' });
  const me = viewer === userId;
  return {
    userId,
    displayName: p.display_name,
    username: p.username,
    bio: openText(p.bio_enc, p.key_id),
    parentBadge: p.parent_badge,
    avatarUrl: imageUrl(c?.avatar ?? null),
    followers: c?.followers ?? 0,
    following: c?.following ?? 0,
    posts: c?.posts ?? 0,
    shopSlug: p.shop_slug,
    shopUrl: shopUrl(p.shop_slug),
    joinedOn: p.created_at.toISOString().slice(0, 10),
    me,
    followedByMe: c?.followed ?? false,
    blockedByMe: c?.blocked ?? false,
    // The feed shows AGE only, never the date of birth.
    age: ageFrom(dob),
    heightIn: heightRaw === null ? null : Number(heightRaw),
    location: p.location,
    streak,
    clips: e?.clips ?? 0,
    achievements,
    provider,
    ...(me
      ? {
          dob,
          providerStatus: pc
            ? { status: pc.status as 'submitted' | 'verified' | 'rejected', licenseType: pc.license_type, licenseState: pc.license_state, licenseNumber: pc.license_number, specialties: pc.specialties, submittedAt: pc.submitted_at.toISOString(), rejectReason: pc.reject_reason }
            : null,
        }
      : {}),
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
    onboarded: !!p?.onboarded_at,
    birthDateOnFile: !!(await birthDate(a.userId)),
  };
  res.json(out);
});

/** The date of birth checked when this account signed up for the Feed (private), if any. */
async function birthDate(userId: number): Promise<string | null> {
  const { rows } = await asSystem(() => pool.query<{ d: string | null }>('SELECT birth_date::text AS d FROM users WHERE id = $1', [userId]));
  return rows[0]?.d ?? null;
}

/** Names nobody gets to wear: they'd look official. */
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'myday', 'thefeed', 'feed', 'support', 'moderator', 'mod', 'mods', 'staff', 'help', 'root', 'system', 'official', 'hana', 'null', 'undefined', 'me', 'settings', 'security', 'safety']);

/** A valid, unclaimed @username for this person, or why not (HttpError). */
async function checkUsername(raw: unknown, userId: number): Promise<string> {
  const u = String(raw ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!USERNAME_RE.test(u) || /^[0-9_.]+$/.test(u)) throw new HttpError(400, 'Usernames are 3–20 letters, numbers, _ or . (with at least one letter).', 'username_invalid');
  if (RESERVED_USERNAMES.has(u)) throw new HttpError(409, 'That username is taken.', 'username_taken');
  const s = await screenText(u);
  if (s.hold) throw new HttpError(422, 'Pick a different username.', 'username_held');
  const { rowCount } = await pool.query('SELECT 1 FROM social_profiles WHERE username = $1 AND user_id <> $2', [u, userId]);
  if (rowCount) throw new HttpError(409, 'That username is taken.', 'username_taken');
  return u;
}

communityRouter.get('/api/feed/username', async (req, res) => {
  const a = await adult(req);
  try {
    res.json({ available: true, username: await checkUsername(req.query.u, a.userId) });
  } catch (e) {
    if (e instanceof HttpError) res.json({ available: false, reason: e.message });
    else throw e;
  }
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
  // About: date of birth (private — the feed shows age only), height, location. Omitted = unchanged.
  let dob: string | null = existing?.dob ?? null;
  if (b.dob === null || b.dob === '') dob = null;
  else if (b.dob !== undefined) {
    const v = String(b.dob);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Date of birth is a date (yyyy-mm-dd)');
    const age = ageFrom(v);
    if (age === null || age > 120) throw new HttpError(400, 'Check your date of birth');
    if (age < 18) {
      await logEvent('community_underage', {}, null, null);
      throw new HttpError(403, 'The Feed is for grown-ups 18 and older.', 'under_18');
    }
    dob = v;
  }
  // Age checked at sign-up (the Feed app): that date of birth stands; nobody is asked twice.
  if (!existing && !dob) dob = await birthDate(a.userId);
  let username: string | null = existing?.username ?? null;
  if (b.username !== undefined && b.username !== null && b.username !== '') username = await checkUsername(b.username, a.userId);
  if (!existing && !username && onFeedApp(req)) throw new HttpError(400, 'Pick a username — it’s how people find you.', 'username_required');
  // Joined just for the Feed (no household behind the account): the date of birth is the 18+ check.
  if (!existing && !req.member && !dob) throw new HttpError(400, 'Add your date of birth — the Feed is for grown-ups 18 and older.', 'dob_required');
  let heightIn: number | null = existing?.height_in == null ? null : Number(existing.height_in);
  if (b.heightIn === null || b.heightIn === '') heightIn = null;
  else if (b.heightIn !== undefined) {
    const h = Number(b.heightIn);
    if (!Number.isFinite(h) || h < 36 || h > 96) throw new HttpError(400, 'Height is in inches (36–96)');
    heightIn = Math.round(h * 10) / 10;
  }
  let location: string | null = existing?.location ?? null;
  if (b.location !== undefined) {
    location = str(b.location, 'location', 60) || null;
    if (location) {
      const s = await screenText(location);
      if (s.hold) throw new HttpError(422, 'Keep your location general — a city or state.', 'location_held');
    }
  }
  const keyId = currentKeyId();
  await pool.query(
    `INSERT INTO social_profiles (user_id, display_name, bio_enc, key_id, avatar_id, parent_badge, adult_confirmed_at, guidelines_accepted_at, shop_slug, dob, height_in, location, username)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now(), $7, $8, $9, $10, $11)
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, bio_enc = EXCLUDED.bio_enc, key_id = EXCLUDED.key_id,
       avatar_id = EXCLUDED.avatar_id, parent_badge = EXCLUDED.parent_badge, shop_slug = EXCLUDED.shop_slug,
       dob = EXCLUDED.dob, height_in = EXCLUDED.height_in, location = EXCLUDED.location, username = EXCLUDED.username`,
    [a.userId, displayName, bio ? sealText(bio, keyId) : null, keyId, avatarId, b.parentBadge === true, shopSlug, dob, heightIn, location, username],
  ).catch((e: unknown) => {
    // Two people grabbing the same name at once: the second one hears it's taken.
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === '23505') throw new HttpError(409, 'That username is taken.', 'username_taken');
    throw e;
  });
  res.json(await profileView(a.userId, a.userId));
});

/* ---------- photos (avatars + feed photos), sealed at rest ---------- */

export function imageType(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
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

/** Villages: topic forums under the Feed (ADHD Parents, Late Diagnosis, Partners…). */
communityRouter.get('/api/villages', async (req, res) => {
  const m = await member(req);
  res.json({ villages: await villageList(m.userId) });
});

async function villageList(userId: number): Promise<VillageInfo[]> {
  const { rows } = await pool.query<VillageInfo>(
    `SELECT v.slug, v.name, v.description,
            (SELECT COUNT(*)::int FROM forum_threads t WHERE t.village_id = v.id AND ${SEEN('t')}) AS threads,
            (SELECT COUNT(*)::int FROM village_members vm WHERE vm.village_id = v.id) AS members,
            EXISTS (SELECT 1 FROM village_members vm WHERE vm.village_id = v.id AND vm.user_id = $1) AS joined
       FROM villages v ORDER BY v.sort, v.id`,
    [userId],
  );
  return rows;
}

/** Join or leave a village (its activity comes to you). */
communityRouter.post('/api/villages/:slug/members', async (req, res) => {
  const m = await member(req);
  const vid = await villageId(req.params.slug);
  await pool.query('INSERT INTO village_members (village_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [vid, m.userId]);
  res.status(201).json({ villages: await villageList(m.userId) });
});
communityRouter.delete('/api/villages/:slug/members', async (req, res) => {
  const m = await member(req);
  const vid = await villageId(req.params.slug);
  await pool.query('DELETE FROM village_members WHERE village_id = $1 AND user_id = $2', [vid, m.userId]);
  res.json({ villages: await villageList(m.userId) });
});

/* ---------- the Feed app's first run: interests → villages → people (no cold landing) ---------- */

/** People to follow: shared interests and villages first, then whoever the Feed loves; never blocked or banned. */
async function suggestions(userId: number, limit: number): Promise<FeedSuggestion[]> {
  const { rows } = await pool.query<{ user_id: number; display_name: string; username: string | null; avatar_id: number | null; followers: number; shared: string[]; villages: string[]; provider: boolean }>(
    `WITH me AS (SELECT interests FROM social_profiles WHERE user_id = $1)
     SELECT p.user_id, p.display_name, p.username,
            (SELECT id FROM community_images ci WHERE ci.id = p.avatar_id AND ci.status = 'visible') AS avatar_id,
            (SELECT COUNT(*)::int FROM social_follows f WHERE f.followed_user_id = p.user_id) AS followers,
            ARRAY(SELECT unnest(p.interests) INTERSECT SELECT unnest((SELECT interests FROM me))) AS shared,
            ARRAY(SELECT v.name FROM village_members a JOIN village_members b ON b.village_id = a.village_id AND b.user_id = $1
                    JOIN villages v ON v.id = a.village_id WHERE a.user_id = p.user_id) AS villages,
            EXISTS (SELECT 1 FROM provider_credentials pc WHERE pc.user_id = p.user_id AND pc.status = 'verified') AS provider
       FROM social_profiles p
      WHERE p.user_id <> $1 AND p.banned_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = p.user_id)
        AND NOT EXISTS (SELECT 1 FROM social_blocks b WHERE (b.blocker_user_id = $1 AND b.blocked_user_id = p.user_id) OR (b.blocker_user_id = p.user_id AND b.blocked_user_id = $1))
      ORDER BY cardinality(ARRAY(SELECT unnest(p.interests) INTERSECT SELECT unnest((SELECT interests FROM me)))) * 3
             + (SELECT COUNT(*) FROM village_members a JOIN village_members b ON b.village_id = a.village_id AND b.user_id = $1 WHERE a.user_id = p.user_id) * 2
             + ln(1 + (SELECT COUNT(*) FROM social_follows f WHERE f.followed_user_id = p.user_id)) DESC,
               p.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  const label = (k: string): string => FEED_INTERESTS.find((i) => i.key === k)?.label ?? k;
  return rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    username: r.username,
    avatarUrl: imageUrl(r.avatar_id),
    followers: r.followers,
    provider: r.provider,
    reason: r.shared[0] ? `Also into ${label(r.shared[0])}` : r.villages[0] ? `In ${r.villages[0]} with you` : r.provider ? 'Verified provider' : 'Popular in the Feed',
  }));
}

communityRouter.get('/api/feed/onboarding', async (req, res) => {
  const m = await member(req);
  const picked = new Set(m.profile.interests);
  const fromInterests = new Set<string>(FEED_INTERESTS.filter((i) => picked.has(i.key)).map((i) => i.village));
  const out: FeedOnboarding = {
    interests: m.profile.interests,
    villages: (await villageList(m.userId)).map((v) => ({ ...v, suggested: fromInterests.has(v.slug) })),
    people: await suggestions(m.userId, 12),
    done: !!m.profile.onboarded_at,
  };
  res.json(out);
});

/** Interests (from the catalog only). */
communityRouter.put('/api/feed/onboarding', async (req, res) => {
  const m = await member(req);
  const raw = (req.body as { interests?: unknown }).interests;
  if (!Array.isArray(raw)) throw new HttpError(400, 'Pick from the list');
  const keys = new Set<string>(FEED_INTERESTS.map((i) => i.key));
  const interests = [...new Set(raw.filter((x): x is string => typeof x === 'string' && keys.has(x)))];
  await pool.query('UPDATE social_profiles SET interests = $2 WHERE user_id = $1', [m.userId, interests]);
  res.json({ interests });
});

/** First run finished (or skipped): the Feed itself from now on. */
communityRouter.post('/api/feed/onboarding/done', async (req, res) => {
  const m = await member(req);
  await pool.query('UPDATE social_profiles SET onboarded_at = COALESCE(onboarded_at, now()) WHERE user_id = $1', [m.userId]);
  res.json({ done: true });
});

communityRouter.get('/api/feed/suggestions', async (req, res) => {
  const m = await member(req);
  res.json({ people: await suggestions(m.userId, Math.min(Number(req.query.limit) || 10, 30)) });
});

/** The village a request is about (?village=slug; default ADHD Parents, the original Village). */
async function villageId(slug: unknown): Promise<number> {
  const s = typeof slug === 'string' && slug ? slug : 'adhd-parents';
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM villages WHERE slug = $1', [s]);
  if (!rows[0]) throw new HttpError(404, 'No such village');
  return rows[0].id;
}

communityRouter.get('/api/village', async (req, res) => {
  const m = await member(req);
  const cat = typeof req.query.category === 'string' && req.query.category ? categoryOf(req.query.category) : null;
  const vid = await villageId(req.query.village);
  const { rows } = await pool.query<AuthorCols & { id: number; category: VillageCategory; title_enc: Buffer; key_id: string; status: CommunityStatus; last_activity_at: Date; replies: number; author_user_id: number; answered: boolean }>(
    `SELECT t.id, t.category, t.title_enc, t.key_id, t.status, t.last_activity_at, t.author_user_id, ${AUTHOR_COLS},
            (SELECT COUNT(*)::int FROM forum_posts x WHERE x.thread_id = t.id AND NOT x.opening AND x.status = 'visible') AS replies,
            EXISTS (SELECT 1 FROM trusted_answers a WHERE a.kind = 'village' AND a.target_id = t.id) AS answered
       FROM forum_threads t ${AUTHOR_JOIN('t.author_user_id')}
      WHERE ${SEEN('t')} AND ${NOT_BLOCKED('t.author_user_id')} AND ($2::text IS NULL OR t.category = $2) AND t.village_id = $3
      ORDER BY t.last_activity_at DESC LIMIT 100`,
    [m.userId, cat, vid],
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
  const vid = await villageId(b.village);
  const title = str(b.title, 'title', 120, true);
  const body = str(b.body, 'body', 5000, true);
  const d = await decide(await screenText(`${title}\n\n${body}`), 'village');
  const keyId = currentKeyId();
  const id = await tx(async (c) => {
    const { rows } = await c.query<{ id: number }>(
      'INSERT INTO forum_threads (category, author_user_id, title_enc, key_id, status, village_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [category, m.userId, sealText(title, keyId), keyId, d.status, vid],
    );
    const tid = rows[0]?.id ?? 0;
    await c.query('INSERT INTO forum_posts (thread_id, author_user_id, opening, body_enc, key_id, status, priority, flags) VALUES ($1, $2, true, $3, $4, $5, $6, $7)', [
      tid, m.userId, sealText(body, keyId), keyId, d.status, d.priority, d.flags,
    ]);
    return tid;
  });
  if (d.status === 'visible') {
    ensureTrusted('village', id, `${title}\n\n${body}`);
    const { rows: vm } = await pool.query<{ user_id: number; slug: string }>(
      'SELECT vm.user_id, v.slug FROM village_members vm JOIN villages v ON v.id = vm.village_id WHERE vm.village_id = $1 AND vm.user_id <> $2',
      [vid, m.userId],
    );
    const day = new Date().toISOString().slice(0, 10);
    for (const r of vm) await notify({ to: r.user_id, kind: 'village', actor: m.userId, group: `village:${r.slug}:${day}`, url: `/village/${id}`, snippet: title });
    await notifyMentions(`${title}\n${body}`, m.userId, `mention:thread:${id}`, `/village/${id}`);
    await firstPost(m.userId);
  }
  res.status(201).json({ thread: await threadView(m.userId, id), review: d.note });
});

/** Reciprocity: a person's first post deserves a welcome. */
async function firstPost(userId: number): Promise<void> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM social_posts WHERE author_user_id = $1 AND status = 'visible')
          + (SELECT COUNT(*) FROM forum_posts WHERE author_user_id = $1 AND status = 'visible') AS n`,
    [userId],
  );
  if (Number(rows[0]?.n ?? 0) === 1) await milestone(userId, 'first-post', 'Your first post is live — welcome to the Feed. People can see it now.', `/people/${userId}`);
  const streak = (await profileView(userId, userId)).streak;
  if (streak >= 30) await milestone(userId, 'streak-30', 'A 30-day streak. Thirty days of showing up — that’s real.', `/people/${userId}`);
}

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
  if (d.status === 'visible') {
    await pool.query('UPDATE forum_threads SET last_activity_at = now() WHERE id = $1', [id]);
    const { rows: au } = await pool.query<{ author_user_id: number }>('SELECT author_user_id FROM forum_threads WHERE id = $1', [id]);
    const to = au[0]?.author_user_id;
    if (to) await notify({ to, kind: 'reply', actor: m.userId, group: `reply:thread:${id}`, url: `/village/${id}`, snippet: body });
    await notifyMentions(body, m.userId, `mention:thread:${id}`, `/village/${id}`);
    await firstPost(m.userId);
  }
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

type FeedRow = AuthorCols & { id: number; body_enc: Buffer; key_id: string; image_id: number | null; img_status: string | null; status: CommunityStatus; created_at: Date; author_user_id: number; like_count: number; liked: boolean; following: boolean };

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
  following: r.following,
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

/** The Business Suite (routes/business.ts) plugs its sponsored item in here, so this module never imports it (no cycle). */
export const sponsorHook: { feed: ((viewer: number) => Promise<SponsoredItem | null>) | null; clips: ((viewer: number) => Promise<SponsoredItem | null>) | null } = { feed: null, clips: null };

export async function feedPage(viewer: number, o: { tab: 'following' | 'everyone'; author: number | null; before: number | null; id?: number }): Promise<FeedPage> {
  const { rows } = await pool.query<FeedRow>(
    `SELECT s.id, s.body_enc, s.key_id, s.image_id, i.status AS img_status, s.status, s.created_at, s.author_user_id, s.like_count, ${AUTHOR_COLS},
            EXISTS (SELECT 1 FROM social_likes l WHERE l.post_id = s.id AND l.user_id = $1) AS liked,
            EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = s.author_user_id) AS following
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
  const page = await feedPage(m.userId, { tab, author: authorId, before });
  // Seen: once per person per day (the writers' analytics). Not your own.
  const others = page.posts.filter((p) => !p.mine && p.status === 'visible').map((p) => p.id);
  if (others.length) {
    await pool.query('INSERT INTO social_post_views (post_id, viewer_user_id, day) SELECT unnest($1::int[]), $2, (now() AT TIME ZONE $3)::date ON CONFLICT DO NOTHING', [others, m.userId, config.tz]);
  }
  // One sponsored item on the Feed's tabs (never on a person's profile list).
  if (authorId === null && before === null && sponsorHook.feed) page.sponsored = await sponsorHook.feed(m.userId);
  res.json(page);
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

/** Around the Web: trusted publishers' articles (screened), newest first, the newest 20 from the last 90 days (publishers post far less often than people). */
communityRouter.get('/api/feed/web', async (req, res) => {
  await member(req);
  const { rows } = await pool.query<{ id: number; publisher: string; title: string; summary: string; url: string; published_at: Date }>(
    `SELECT id, publisher, title, summary, url, published_at FROM web_items
      WHERE status = 'visible' AND published_at > now() - interval '90 days' ORDER BY published_at DESC LIMIT 20`,
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
  if (d.status === 'visible') {
    if (body) await notifyMentions(body, m.userId, `mention:post:${rows[0]?.id ?? 0}`, `/people/${m.userId}`);
    await firstPost(m.userId);
  }
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
  if (!del.rowCount) {
    await pool.query('INSERT INTO social_likes (post_id, user_id) VALUES ($1, $2)', [id, m.userId]);
    await notify({ to: p.author_user_id, kind: 'like', actor: m.userId, group: `like:post:${id}`, url: `/people/${p.author_user_id}` });
  }
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
  const id = idParam(req.params.id);
  const view = await profileView(m.userId, id);
  // A profile view (once per person per day) for the provider's analytics.
  if (id !== m.userId) await pool.query('INSERT INTO social_profile_views (profile_user_id, viewer_user_id, day) VALUES ($1, $2, (now() AT TIME ZONE $3)::date) ON CONFLICT DO NOTHING', [id, m.userId, config.tz]);
  res.json(view);
});

communityRouter.post('/api/community/people/:id/follow', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  if (id === m.userId) throw new HttpError(400, 'You can’t follow yourself');
  await profileView(m.userId, id); // must be a visible, unblocked grown-up's profile
  const f = await pool.query('INSERT INTO social_follows (follower_user_id, followed_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.userId, id]);
  if (f.rowCount) {
    await notify({ to: id, kind: 'follow', actor: m.userId, group: `follow:${new Date().toISOString().slice(0, 10)}`, url: `/people/${m.userId}` });
    const { rows: fc } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM social_follows WHERE followed_user_id = $1', [id]);
    if ((fc[0]?.n ?? 0) >= 10) await milestone(id, 'followers-10', 'You just reached 10 followers. People are glad you’re here.', `/people/${id}`);
  }
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

export function staff(req: Request): string {
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
  // The Feed's other sections: stories, clips (+ comments), messages.
  const { rows: stories } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, q.text_enc AS body_enc, q.key_id, q.image_id, q.status, q.priority, q.flags, q.created_at, NULL::text[] AS reports
       FROM (SELECT s.*, s.author_user_id AS user_id FROM social_stories s) q ${WHO}
      WHERE q.status IN ('pending', 'hidden') AND q.expires_at > now()`,
  );
  for (const r of stories) push('story', r);
  const { rows: clips } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, q.caption_enc AS body_enc, q.key_id, q.poster_id AS image_id, q.status, q.priority, q.flags, q.created_at,
            (SELECT array_agg(r.reason ORDER BY r.id) FROM social_clip_reports r WHERE r.clip_id = q.id AND r.status = 'open') AS reports
       FROM (SELECT c.*, c.author_user_id AS user_id FROM social_clips c) q ${WHO}
      WHERE q.status IN ('pending', 'hidden') OR EXISTS (SELECT 1 FROM social_clip_reports r WHERE r.clip_id = q.id AND r.status = 'open')`,
  );
  for (const r of clips) push('clip', r);
  const { rows: ccom } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, q.body_enc, q.key_id, NULL::int AS image_id, q.status, q.priority, q.flags, q.created_at, NULL::text[] AS reports
       FROM (SELECT x.*, x.author_user_id AS user_id FROM social_clip_comments x) q ${WHO}
      WHERE q.status IN ('pending', 'hidden')`,
  );
  for (const r of ccom) push('clip-comment', r);
  const { rows: dms } = await pool.query<QueueRow>(
    `SELECT q.id, q.user_id, ${WHO_COLS}, NULL::bytea AS title_enc, NULL AS title_key, q.body_enc, q.key_id, NULL::int AS image_id, q.status, q.priority, q.flags, q.created_at,
            (SELECT array_agg(r.reason ORDER BY r.id) FROM dm_reports r WHERE r.message_id = q.id AND r.status = 'open') AS reports
       FROM (SELECT m.*, m.sender_user_id AS user_id FROM dm_messages m) q ${WHO}
      WHERE q.status IN ('pending', 'hidden') OR EXISTS (SELECT 1 FROM dm_reports r WHERE r.message_id = q.id AND r.status = 'open')`,
  );
  for (const r of dms) push('message', r);
  items.sort((a, b) => b.priority - a.priority || a.at.localeCompare(b.at));
  return { items };
}

communityStaffRouter.get('/api/community/moderation/queue', async (req, res) => {
  staff(req);
  res.json(await queue());
});

/** warn → 7-day mute → ban, by how many strikes they already have. */
export async function strike(userId: number, reason: string, source: string, by: string): Promise<'warn' | 'mute' | 'ban'> {
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
  if (!action || !['village', 'feed', 'image', 'profile', 'story', 'clip', 'clip-comment', 'message'].includes(kind)) throw new HttpError(404, 'Not found');
  const reason = str((req.body as Record<string, unknown> | undefined)?.reason, 'reason', 200) || 'Broke the community guidelines';
  let author: number | null = null;
  const SOCIAL: Record<string, { table: string; by: string; reports?: [string, string] }> = {
    story: { table: 'social_stories', by: 'author_user_id' },
    clip: { table: 'social_clips', by: 'author_user_id', reports: ['social_clip_reports', 'clip_id'] },
    'clip-comment': { table: 'social_clip_comments', by: 'author_user_id' },
    message: { table: 'dm_messages', by: 'sender_user_id', reports: ['dm_reports', 'message_id'] },
  };
  const sk = SOCIAL[kind];
  if (sk) {
    const { rows } = await pool.query<{ author: number }>(`SELECT ${sk.by} AS author FROM ${sk.table} WHERE id = $1`, [id]);
    author = rows[0]?.author ?? null;
    if (author === null) throw new HttpError(404, 'Not found');
    if (action === 'approve') await pool.query(`UPDATE ${sk.table} SET status = 'visible', priority = 0 WHERE id = $1`, [id]);
    if (action === 'remove' || action === 'strike') await pool.query(`UPDATE ${sk.table} SET status = 'removed', priority = 0 WHERE id = $1`, [id]);
    if (sk.reports) await pool.query(`UPDATE ${sk.reports[0]} SET status = 'resolved' WHERE ${sk.reports[1]} = $1 AND status = 'open'`, [id]);
    if (action === 'approve' && kind === 'clip') await pool.query("UPDATE community_images i SET status = 'visible' FROM social_clips c WHERE c.id = $1 AND i.id = c.poster_id AND i.status = 'pending'", [id]);
    if (action === 'approve' && kind === 'story') await pool.query("UPDATE community_images i SET status = 'visible' FROM social_stories s WHERE s.id = $1 AND i.id = s.image_id AND i.status = 'pending'", [id]);
    if (kind === 'clip-comment') {
      await pool.query("UPDATE social_clips c SET comment_count = (SELECT COUNT(*) FROM social_clip_comments x WHERE x.clip_id = c.id AND x.status = 'visible') FROM social_clip_comments y WHERE y.id = $1 AND c.id = y.clip_id", [id]);
    }
    if (action === 'approve' && kind === 'message') await pool.query('UPDATE dm_threads t SET last_at = now() FROM dm_messages m WHERE m.id = $1 AND t.id = m.thread_id', [id]);
  } else if (kind === 'village' || kind === 'feed') {
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
