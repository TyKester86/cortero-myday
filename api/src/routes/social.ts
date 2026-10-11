/**
 * The Feed's social sections: Stories (24 hours), Clips (short vertical videos), Messages (1:1), and
 * verified Provider credentials. Same hard rules as routes/community.ts — grown-ups (18+) only, keyed by
 * account, sealed at rest, every word and picture through the pre-screen (held = "under review", crisis =
 * top of the moderation queue + 988 for the writer), blocks respected everywhere. The Feed is free: no
 * subscription check anywhere here.
 */
import express, { Router, type Request } from 'express';
import type { ClipComment, ClipItem, DmMessage, DmThread, DmThreadSummary, ReviewNote, StoryItem, StoryRailItem } from '@myday/shared';
import { pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { notify, notifyMentions } from '../lib/feednotify.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { screenText } from '../lib/screen.js';
import { currentKeyId, openBytes, openText, sealBytes, sealText } from '../lib/seal.js';
import { adult, AUTHOR_COLS, AUTHOR_JOIN, author, sponsorHook, block, decide, imageUrl, member, NOT_BLOCKED, poster, profileRow, rankOutcome, SEEN, staff, type AuthorCols } from './community.js';

export const socialRouter = Router();
/** Video uploads take a raw body. */
export const socialUploadRouter = Router();
/** Provider verification (MyDay admins). */
export const socialStaffRouter = Router();

const MAX_VIDEO = 30 * 1024 * 1024;
const MAX_CLIP_SECONDS = 90;
const MESSAGES_PER_HOUR = 60;

/** An image the person uploaded (screened on upload) that isn't removed. */
async function ownImage(userId: number, id: unknown): Promise<{ id: number; status: string } | null> {
  if (id === undefined || id === null) return null;
  const { rows } = await pool.query<{ id: number; status: string }>("SELECT id, status FROM community_images WHERE id = $1 AND user_id = $2 AND status <> 'removed'", [idParam(id), userId]);
  if (!rows[0]) throw new HttpError(400, 'Upload the photo first');
  return rows[0];
}

/** What the writer is told: the text screen's note, marked "under review" when a photo (or an unscreenable video) held it. */
function heldNote(note: ReviewNote | undefined, held: boolean, why: 'photo' | 'video' | null): ReviewNote {
  const base = note ?? { underReview: false, crisis: false, reasons: [] };
  if (!held || base.underReview) return base;
  return { ...base, underReview: true, reasons: why ? [...base.reasons, why === 'photo' ? 'a moderator checks the picture first' : 'a moderator watches it first'] : base.reasons };
}

/* ======================= Stories ======================= */

const STORY_BG = new Set(['amber', 'sage', 'terracotta', 'charcoal']);

socialRouter.get('/api/social/stories', async (req, res) => {
  const m = await member(req);
  const { rows } = await pool.query<AuthorCols & { n: number; latest: Date; unseen: number; followed: boolean }>(
    `SELECT ${AUTHOR_COLS}, COUNT(*)::int AS n, max(s.created_at) AS latest,
            COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM social_story_views v WHERE v.story_id = s.id AND v.viewer_user_id = $1))::int AS unseen,
            EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = s.author_user_id) AS followed
       FROM social_stories s ${AUTHOR_JOIN('s.author_user_id')}
      WHERE s.expires_at > now() AND ${SEEN('s')} AND ${NOT_BLOCKED('s.author_user_id')} AND p.banned_at IS NULL
      GROUP BY p.user_id, p.display_name, p.parent_badge, p.avatar_id, ai.status, s.author_user_id
      ORDER BY (s.author_user_id = $1) DESC,
               ((COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM social_story_views v WHERE v.story_id = s.id AND v.viewer_user_id = $1)) > 0) AND feed_friends($1, s.author_user_id)) DESC,
               (COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM social_story_views v WHERE v.story_id = s.id AND v.viewer_user_id = $1)) > 0) DESC,
               max(s.created_at) DESC
      LIMIT 40`,
    [m.userId],
  );
  const rail: StoryRailItem[] = rows.map((r) => ({ author: author(r), count: r.n, unseen: r.unseen > 0 && r.a_id !== m.userId, latestAt: r.latest.toISOString(), me: r.a_id === m.userId }));
  res.json({ rail });
});

socialRouter.get('/api/social/stories/:userId', async (req, res) => {
  const m = await member(req);
  const who = idParam(req.params.userId);
  if (who !== m.userId && (await block(m.userId, who))) throw new HttpError(404, 'No stories');
  const { rows } = await pool.query<AuthorCols & { id: number; image_id: number | null; text_enc: Buffer | null; key_id: string; bg: string; status: string; created_at: Date; expires_at: Date; views: number }>(
    `SELECT s.id, s.image_id, s.text_enc, s.key_id, s.bg, s.status, s.created_at, s.expires_at, ${AUTHOR_COLS},
            (SELECT COUNT(*)::int FROM social_story_views v WHERE v.story_id = s.id AND v.viewer_user_id <> s.author_user_id) AS views
       FROM social_stories s ${AUTHOR_JOIN('s.author_user_id')}
      WHERE s.author_user_id = $2 AND s.expires_at > now() AND ${SEEN('s')} AND p.banned_at IS NULL
      ORDER BY s.id`,
    [m.userId, who],
  );
  if (!rows[0]) throw new HttpError(404, 'No stories');
  const stories: StoryItem[] = rows.map((r) => ({
    id: r.id,
    imageUrl: imageUrl(r.image_id),
    text: r.text_enc ? openText(r.text_enc, r.key_id) : null,
    bg: r.bg,
    at: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    status: r.status as StoryItem['status'],
    views: who === m.userId ? r.views : null,
  }));
  res.json({ author: author(rows[0]), stories });
});

socialRouter.post('/api/social/stories', async (req, res) => {
  const m = await poster(req);
  const b = req.body as Record<string, unknown>;
  const img = await ownImage(m.userId, b.imageId);
  const text = str(b.text, 'text', 200);
  if (!img && !text) throw new HttpError(400, 'Add a photo or a few words');
  const bg = typeof b.bg === 'string' && STORY_BG.has(b.bg) ? b.bg : 'amber';
  const d = text ? await decide(await screenText(text), 'story') : null;
  const held = (d && d.status === 'pending') || img?.status === 'pending';
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>(
    'INSERT INTO social_stories (author_user_id, image_id, text_enc, key_id, bg, status, priority, flags) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
    [m.userId, img?.id ?? null, text ? sealText(text, keyId) : null, keyId, bg, held ? 'pending' : 'visible', d?.priority ?? (held ? 1 : 0), d?.flags ?? []],
  );
  await logEvent('social_story', { held }, null, null);
  res.status(201).json({ id: rows[0]?.id, review: heldNote(d?.note, held, img?.status === 'pending' ? 'photo' : null) });
});

socialRouter.post('/api/social/stories/:id/view', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const { rows } = await pool.query<{ author_user_id: number }>(`SELECT s.author_user_id FROM social_stories s WHERE s.id = $2 AND s.expires_at > now() AND ${SEEN('s')}`, [m.userId, id]);
  if (!rows[0] || (await block(m.userId, rows[0].author_user_id))) throw new HttpError(404, 'Not found');
  await pool.query('INSERT INTO social_story_views (story_id, viewer_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m.userId]);
  res.json({ ok: true });
});

socialRouter.delete('/api/social/stories/:id', async (req, res) => {
  const m = await member(req);
  const { rowCount } = await pool.query("UPDATE social_stories SET status = 'removed' WHERE id = $1 AND author_user_id = $2", [idParam(req.params.id), m.userId]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

/* ======================= Clips ======================= */

/** What the bytes are: MP4/MOV (ISO base media "ftyp") or WebM (EBML). */
function videoType(b: Buffer): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp') return b.toString('ascii', 8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  if (b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
}

socialUploadRouter.post('/api/social/videos', express.raw({ type: () => true, limit: MAX_VIDEO }), async (req: Request, res) => {
  if (req.headers['x-myday-upload'] !== '1') throw new HttpError(400, 'Missing upload header');
  const m = await poster(req);
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const mime = videoType(data);
  if (!mime) throw new HttpError(415, 'Clips can be MP4, MOV or WebM videos');
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>('INSERT INTO community_videos (user_id, data_enc, key_id, mime, size) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
    m.userId, sealBytes(data, keyId), keyId, mime, data.length,
  ]);
  res.status(201).json({ id: rows[0]?.id });
});

const videoUrl = (id: number): string => `/api/social/videos/${id}`;

// A few recently played videos, decrypted, so a player's range requests don't each unseal the whole file.
const videoCache = new Map<number, { mime: string; data: Buffer }>();
function cacheVideo(id: number, v: { mime: string; data: Buffer }): void {
  videoCache.delete(id);
  videoCache.set(id, v);
  while (videoCache.size > 4) videoCache.delete(videoCache.keys().next().value as number);
}

socialRouter.get('/api/social/videos/:id', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const { rows } = await pool.query<{ user_id: number; status: string | null }>(
    `SELECT v.user_id, (SELECT c.status FROM social_clips c WHERE c.video_id = v.id ORDER BY c.id DESC LIMIT 1) AS status FROM community_videos v WHERE v.id = $1`,
    [id],
  );
  const r = rows[0];
  const ok = r && (r.user_id === m.userId || m.admin || (r.status === 'visible' && !(await block(m.userId, r.user_id))));
  if (!ok) throw new HttpError(404, 'Not found');
  let v = videoCache.get(id);
  if (!v) {
    const { rows: d } = await pool.query<{ mime: string; data_enc: Buffer; key_id: string }>('SELECT mime, data_enc, key_id FROM community_videos WHERE id = $1', [id]);
    if (!d[0]) throw new HttpError(404, 'Not found');
    v = { mime: d[0].mime, data: openBytes(d[0].data_enc, d[0].key_id) };
  }
  cacheVideo(id, v);
  const size = v.data.length;
  res.set('Content-Type', v.mime).set('Accept-Ranges', 'bytes').set('Cache-Control', 'private, no-store');
  const range = typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.status(416).set('Content-Range', `bytes */${size}`).end();
      return;
    }
    res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`).set('Content-Length', String(end - start + 1)).send(v.data.subarray(start, end + 1));
    return;
  }
  res.set('Content-Length', String(size)).send(v.data);
});

const HASHTAG = /#([\p{L}\p{N}_]{2,30})/gu;

interface ClipRow extends AuthorCols {
  id: number;
  video_id: number;
  poster_id: number | null;
  caption_enc: Buffer | null;
  key_id: string;
  hashtags: string[];
  duration_s: string | null;
  like_count: number;
  comment_count: number;
  view_count: number;
  share_count: number;
  status: string;
  created_at: Date;
  author_user_id: number;
  liked: boolean;
}
const CLIP_COLS = `c.id, c.video_id, c.poster_id, c.caption_enc, c.key_id, c.hashtags, c.duration_s, c.like_count, c.comment_count, c.view_count, c.share_count,
  c.status, c.created_at, c.author_user_id, ${AUTHOR_COLS}, EXISTS (SELECT 1 FROM social_clip_likes l WHERE l.clip_id = c.id AND l.user_id = $1) AS liked`;
const toClip = (viewer: number, r: ClipRow): ClipItem => ({
  id: r.id,
  author: author(r),
  videoUrl: videoUrl(r.video_id),
  posterUrl: imageUrl(r.poster_id),
  caption: r.caption_enc ? openText(r.caption_enc, r.key_id) : '',
  hashtags: r.hashtags,
  durationS: r.duration_s === null ? null : Number(r.duration_s),
  likes: r.like_count,
  likedByMe: r.liked,
  comments: r.comment_count,
  views: r.view_count,
  shares: r.share_count,
  at: r.created_at.toISOString(),
  status: r.status as ClipItem['status'],
  mine: r.author_user_id === viewer,
});

socialRouter.post('/api/social/clips', async (req, res) => {
  const m = await poster(req);
  const b = req.body as Record<string, unknown>;
  const videoId = idParam(b.videoId);
  const { rows: v } = await pool.query('SELECT 1 FROM community_videos WHERE id = $1 AND user_id = $2', [videoId, m.userId]);
  if (!v[0]) throw new HttpError(400, 'Upload the video first');
  const { rows: used } = await pool.query('SELECT 1 FROM social_clips WHERE video_id = $1', [videoId]);
  if (used[0]) throw new HttpError(409, 'That video is already a clip');
  // The poster frame and sample frames from the video were each screened when uploaded.
  const posterImg = await ownImage(m.userId, b.posterId);
  const frames = Array.isArray(b.frameIds) ? b.frameIds.slice(0, 3) : [];
  const frameImgs = [];
  for (const f of frames) frameImgs.push(await ownImage(m.userId, f));
  const caption = str(b.caption, 'caption', 300);
  const duration = b.durationS === undefined || b.durationS === null ? null : Number(b.durationS);
  if (duration !== null && (!Number.isFinite(duration) || duration <= 0 || duration > MAX_CLIP_SECONDS)) throw new HttpError(400, `Clips are up to ${MAX_CLIP_SECONDS} seconds`);
  const d = caption ? await decide(await screenText(caption), 'clip') : null;
  // No frames to look at = nothing was screened: a moderator watches it first.
  const imagesHeld = !posterImg || [posterImg, ...frameImgs].some((i) => i?.status === 'pending');
  const held = (d && d.status === 'pending') || imagesHeld;
  const hashtags = [...new Set([...(caption.matchAll(HASHTAG) ?? [])].map((x) => (x[1] ?? '').toLowerCase()))].slice(0, 10);
  const keyId = currentKeyId();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO social_clips (author_user_id, video_id, poster_id, caption_enc, key_id, hashtags, duration_s, status, priority, flags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [m.userId, videoId, posterImg?.id ?? null, caption ? sealText(caption, keyId) : null, keyId, hashtags, duration, held ? 'pending' : 'visible', d?.priority ?? (held ? 1 : 0), d?.flags ?? []],
  );
  await logEvent('social_clip', { held }, null, null);
  res.status(201).json({ clip: await clipFor(m.userId, rows[0]?.id ?? 0), review: heldNote(d?.note, held, imagesHeld ? (posterImg ? 'photo' : 'video') : null) });
});

export async function clipFor(viewer: number, id: number): Promise<ClipItem> {
  const { rows } = await pool.query<ClipRow>(
    `SELECT ${CLIP_COLS} FROM social_clips c ${AUTHOR_JOIN('c.author_user_id')} WHERE c.id = $2 AND ${SEEN('c')} AND ${NOT_BLOCKED('c.author_user_id')} AND p.banned_at IS NULL`,
    [viewer, id],
  );
  if (!rows[0]) throw new HttpError(404, 'No such clip');
  return toClip(viewer, rows[0]);
}

/** Newest first, 10 at a time (?before=<id>); ?user=<id> for one person's clips. */
socialRouter.get('/api/social/clips', async (req, res) => {
  const m = await member(req);
  const before = typeof req.query.before === 'string' ? idParam(req.query.before) : null;
  const user = typeof req.query.user === 'string' ? idParam(req.query.user) : null;
  const tag = typeof req.query.tag === 'string' ? req.query.tag.replace(/^#/, '').toLowerCase().slice(0, 30) : null;
  const { rows } = await pool.query<ClipRow>(
    `SELECT ${CLIP_COLS} FROM social_clips c ${AUTHOR_JOIN('c.author_user_id')}
      WHERE ${SEEN('c')} AND ${NOT_BLOCKED('c.author_user_id')} AND p.banned_at IS NULL
        AND ($2::int IS NULL OR c.id < $2) AND ($3::int IS NULL OR c.author_user_id = $3) AND ($4::text IS NULL OR $4 = ANY(c.hashtags))
      ORDER BY c.id DESC LIMIT 10`,
    [m.userId, before, user, tag],
  );
  // One sponsored clip on the first, unfiltered page (labelled; grown-ups only, like everything here).
  const sponsored = before === null && user === null && tag === null && sponsorHook.clips ? await sponsorHook.clips(m.userId) : null;
  res.json({ clips: rows.map((r) => toClip(m.userId, r)), next: rows.length === 10 ? rows[rows.length - 1]?.id ?? null : null, sponsored });
});

socialRouter.get('/api/social/clips/:id', async (req, res) => {
  const m = await member(req);
  res.json({ clip: await clipFor(m.userId, idParam(req.params.id)) });
});

socialRouter.post('/api/social/clips/:id/like', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const c = await clipFor(m.userId, id);
  if (c.status !== 'visible') throw new HttpError(409, 'Under review');
  const del = await pool.query('DELETE FROM social_clip_likes WHERE clip_id = $1 AND user_id = $2', [id, m.userId]);
  if (!del.rowCount) {
    await pool.query('INSERT INTO social_clip_likes (clip_id, user_id) VALUES ($1, $2)', [id, m.userId]);
    const { rows: ca } = await pool.query<{ author_user_id: number }>('SELECT author_user_id FROM social_clips WHERE id = $1', [id]);
    if (ca[0]) await notify({ to: ca[0].author_user_id, kind: 'like', actor: m.userId, group: `like:clip:${id}`, url: '/clips' });
  }
  await pool.query('UPDATE social_clips SET like_count = (SELECT COUNT(*) FROM social_clip_likes WHERE clip_id = $1) WHERE id = $1', [id]);
  res.json({ clip: await clipFor(m.userId, id) });
});

socialRouter.post('/api/social/clips/:id/view', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const c = await clipFor(m.userId, id);
  if (!c.mine && c.status === 'visible') {
    const ins = await pool.query('INSERT INTO social_clip_views (clip_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, m.userId]);
    if (ins.rowCount) await pool.query('UPDATE social_clips SET view_count = view_count + 1 WHERE id = $1', [id]);
  }
  res.json({ ok: true });
});

socialRouter.post('/api/social/clips/:id/share', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const c = await clipFor(m.userId, id);
  if (c.status === 'visible') await pool.query('UPDATE social_clips SET share_count = share_count + 1 WHERE id = $1', [id]);
  res.json({ ok: true, path: `/clips?c=${id}` });
});

socialRouter.post('/api/social/clips/:id/report', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  const c = await clipFor(m.userId, id);
  if (c.mine) throw new HttpError(400, 'That’s your clip');
  const reason = str((req.body as Record<string, unknown>).reason, 'reason', 200) || 'Reported';
  await pool.query('INSERT INTO social_clip_reports (clip_id, reporter_user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, m.userId, reason]);
  const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM social_clip_reports WHERE clip_id = $1 AND status = 'open'", [id]);
  if ((rows[0]?.n ?? 0) >= 3) await pool.query("UPDATE social_clips SET status = 'hidden' WHERE id = $1 AND status = 'visible'", [id]);
  res.status(201).json({ ok: true });
});

socialRouter.delete('/api/social/clips/:id', async (req, res) => {
  const m = await member(req);
  const { rowCount } = await pool.query("UPDATE social_clips SET status = 'removed' WHERE id = $1 AND author_user_id = $2", [idParam(req.params.id), m.userId]);
  if (!rowCount) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
});

socialRouter.get('/api/social/clips/:id/comments', async (req, res) => {
  const m = await member(req);
  const id = idParam(req.params.id);
  await clipFor(m.userId, id);
  const { rows } = await pool.query<AuthorCols & { id: number; body_enc: Buffer; key_id: string; status: string; created_at: Date; author_user_id: number }>(
    `SELECT x.id, x.body_enc, x.key_id, x.status, x.created_at, x.author_user_id, ${AUTHOR_COLS}
       FROM social_clip_comments x ${AUTHOR_JOIN('x.author_user_id')}
      WHERE x.clip_id = $2 AND ${SEEN('x')} AND ${NOT_BLOCKED('x.author_user_id')} AND p.banned_at IS NULL ORDER BY x.id LIMIT 200`,
    [m.userId, id],
  );
  const comments: ClipComment[] = rows.map((r) => ({ id: r.id, author: author(r), body: openText(r.body_enc, r.key_id), at: r.created_at.toISOString(), status: r.status as ClipComment['status'], mine: r.author_user_id === m.userId }));
  res.json({ comments });
});

socialRouter.post('/api/social/clips/:id/comments', async (req, res) => {
  const m = await poster(req);
  const id = idParam(req.params.id);
  const c = await clipFor(m.userId, id);
  if (c.status !== 'visible') throw new HttpError(409, 'Under review');
  const body = str((req.body as Record<string, unknown>).body, 'body', 1000, true);
  const d = await decide(await screenText(body), 'clip comment');
  const keyId = currentKeyId();
  await pool.query('INSERT INTO social_clip_comments (clip_id, author_user_id, body_enc, key_id, status, priority, flags) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    id, m.userId, sealText(body, keyId), keyId, d.status, d.priority, d.flags,
  ]);
  await pool.query("UPDATE social_clips SET comment_count = (SELECT COUNT(*) FROM social_clip_comments WHERE clip_id = $1 AND status = 'visible') WHERE id = $1", [id]);
  if (d.status === 'visible') {
    const { rows: ca } = await pool.query<{ author_user_id: number }>('SELECT author_user_id FROM social_clips WHERE id = $1', [id]);
    if (ca[0]) await notify({ to: ca[0].author_user_id, kind: 'comment', actor: m.userId, group: `comment:clip:${id}`, url: '/clips', snippet: body });
    await notifyMentions(body, m.userId, `mention:clip:${id}`, '/clips');
  }
  res.status(201).json({ review: d.note });
});

/* ======================= Messages (1:1) ======================= */

const pair = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);

/** Someone you can message: a grown-up with a Feed profile, not banned, no block either way. */
async function messageable(viewer: number, other: number): Promise<void> {
  if (other === viewer) throw new HttpError(400, 'That’s you');
  const p = await profileRow(other);
  if (!p || p.banned_at) throw new HttpError(404, 'No such person');
}

async function threadId(viewer: number, other: number, create: boolean): Promise<number | null> {
  const [a, b] = pair(viewer, other);
  if (create) {
    const { rows } = await pool.query<{ id: number }>(
      'INSERT INTO dm_threads (user_a, user_b) VALUES ($1, $2) ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = EXCLUDED.user_a RETURNING id',
      [a, b],
    );
    return rows[0]?.id ?? null;
  }
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM dm_threads WHERE user_a = $1 AND user_b = $2', [a, b]);
  return rows[0]?.id ?? null;
}

/**
 * A message request (for viewer $1 in thread t, with the other person p.user_id): they wrote, you never have, you
 * don't follow them, and you haven't accepted. Strangers land in Requests, not your inbox.
 */
const IS_REQUEST = `(NOT EXISTS (SELECT 1 FROM dm_messages x WHERE x.thread_id = t.id AND x.sender_user_id = $1)
  AND NOT EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = p.user_id)
  AND st.request IS DISTINCT FROM 'accepted')`;

/** Is this conversation a (not yet answered) request for `viewer`? 'declined' when they turned it down. */
async function requestState(viewer: number, other: number, threadId: number): Promise<'request' | 'declined' | null> {
  const { rows } = await pool.query<{ request: string | null; sent: boolean; follows: boolean }>(
    `SELECT (SELECT request FROM dm_thread_state WHERE thread_id = $3 AND user_id = $1) AS request,
            EXISTS (SELECT 1 FROM dm_messages x WHERE x.thread_id = $3 AND x.sender_user_id = $1) AS sent,
            EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = $2) AS follows`,
    [viewer, other, threadId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.request === 'declined') return 'declined';
  return !r.sent && !r.follows && r.request !== 'accepted' ? 'request' : null;
}

/** What a viewer sees of a thread: everything visible, plus their own held messages ("under review"). */
const DM_SEEN = `(m.status = 'visible' OR (m.sender_user_id = $1 AND m.status IN ('pending', 'hidden')))`;

socialRouter.get('/api/social/messages', async (req, res) => {
  // Before the community profile exists there's simply nothing here yet (the Feed's section bar asks).
  if (!(await profileRow((await adult(req)).userId))) {
    res.json({ threads: [], unread: 0 });
    return;
  }
  const m = await member(req);
  const { rows } = await pool.query<AuthorCols & { id: number; muted: boolean | null; last_body: Buffer | null; last_key: string | null; last_at: Date | null; last_sender: number | null; unread: number; is_request: boolean }>(
    `SELECT t.id, st.muted, ${AUTHOR_COLS}, ${IS_REQUEST} AS is_request,
            lm.body_enc AS last_body, lm.key_id AS last_key, lm.created_at AS last_at, lm.sender_user_id AS last_sender,
            (SELECT COUNT(*)::int FROM dm_messages m WHERE m.thread_id = t.id AND m.status = 'visible' AND m.sender_user_id <> $1 AND m.id > COALESCE(st.last_read_id, 0)) AS unread
       FROM dm_threads t
       ${AUTHOR_JOIN('(CASE WHEN t.user_a = $1 THEN t.user_b ELSE t.user_a END)')}
       LEFT JOIN dm_thread_state st ON st.thread_id = t.id AND st.user_id = $1
       LEFT JOIN LATERAL (SELECT m.body_enc, m.key_id, m.created_at, m.sender_user_id FROM dm_messages m WHERE m.thread_id = t.id AND ${DM_SEEN} ORDER BY m.id DESC LIMIT 1) lm ON true
      WHERE (t.user_a = $1 OR t.user_b = $1) AND lm.created_at IS NOT NULL
        AND p.banned_at IS NULL AND ${NOT_BLOCKED('p.user_id')} AND st.request IS DISTINCT FROM 'declined'
      ORDER BY lm.created_at DESC LIMIT 100`,
    [m.userId],
  );
  const all: DmThreadSummary[] = rows.map((r) => ({
    other: author(r),
    last: r.last_body && r.last_key && r.last_at ? { body: openText(r.last_body, r.last_key), at: r.last_at.toISOString(), mine: r.last_sender === m.userId } : null,
    unread: r.muted || r.is_request ? 0 : r.unread,
    muted: r.muted ?? false,
    request: r.is_request,
  }));
  const threads = all.filter((t) => !t.request);
  const requests = all.filter((t) => t.request);
  res.json({ threads, requests, unread: threads.reduce((n, t) => n + t.unread, 0) });
});

async function threadView(viewer: number, other: number): Promise<DmThread> {
  await messageable(viewer, other);
  const p = await profileRow(other);
  const { rows: who } = await pool.query<AuthorCols>(`SELECT ${AUTHOR_COLS} FROM social_profiles p LEFT JOIN community_images ai ON ai.id = p.avatar_id WHERE p.user_id = $1`, [other]);
  if (!p || !who[0]) throw new HttpError(404, 'No such person');
  const blocked = await block(viewer, other);
  const id = await threadId(viewer, other, false);
  let messages: DmMessage[] = [];
  let muted = false;
  if (id) {
    const { rows } = await pool.query<{ id: number; sender_user_id: number; body_enc: Buffer; key_id: string; status: string; created_at: Date }>(
      `SELECT m.id, m.sender_user_id, m.body_enc, m.key_id, m.status, m.created_at FROM dm_messages m WHERE m.thread_id = $2 AND ${DM_SEEN} ORDER BY m.id DESC LIMIT 200`,
      [viewer, id],
    );
    messages = rows.reverse().map((r) => ({ id: r.id, mine: r.sender_user_id === viewer, body: openText(r.body_enc, r.key_id), at: r.created_at.toISOString(), status: r.status as DmMessage['status'] }));
    const last = messages.filter((x) => !x.mine).at(-1)?.id ?? 0;
    const { rows: st } = await pool.query<{ muted: boolean }>(
      `INSERT INTO dm_thread_state (thread_id, user_id, last_read_id) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_id = GREATEST(dm_thread_state.last_read_id, EXCLUDED.last_read_id) RETURNING muted`,
      [id, viewer, last],
    );
    muted = st[0]?.muted ?? false;
  }
  // Blocked people can't see each other's messages either.
  const request = id !== null && messages.some((x) => !x.mine) && (await requestState(viewer, other, id)) === 'request';
  return { other: author(who[0]), messages: blocked ? [] : messages, muted, blocked, request };
}

socialRouter.get('/api/social/messages/:userId', async (req, res) => {
  const m = await member(req);
  res.json(await threadView(m.userId, idParam(req.params.userId)));
});

socialRouter.post('/api/social/messages/:userId', async (req, res) => {
  const m = await poster(req, false);
  const other = idParam(req.params.userId);
  await messageable(m.userId, other);
  if (await block(m.userId, other)) throw new HttpError(403, 'You can’t message this person', 'blocked_user');
  const { rows: n } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM dm_messages WHERE sender_user_id = $1 AND created_at > now() - interval '1 hour'", [m.userId]);
  if ((n[0]?.n ?? 0) >= MESSAGES_PER_HOUR) throw new HttpError(429, 'That’s a lot of messages this hour — take a breather.', 'message_limit');
  const body = str((req.body as Record<string, unknown>).body, 'body', 2000, true);
  // Screened like every post: blocked never sends; held waits for a moderator (the other person doesn't see it);
  // crisis goes to the top of the queue and the writer sees 988.
  const d = await decide(await screenText(body), 'message');
  const id = await threadId(m.userId, other, true);
  const { rowCount: saidBefore } = await pool.query('SELECT 1 FROM dm_messages WHERE thread_id = $1 AND sender_user_id = $2 LIMIT 1', [id, m.userId]);
  const keyId = currentKeyId();
  if (!saidBefore) await rankOutcome(m.userId, null, other, 'dm');
  await pool.query('INSERT INTO dm_messages (thread_id, sender_user_id, body_enc, key_id, status, priority, flags) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    id, m.userId, sealText(body, keyId), keyId, d.status, d.priority, d.flags,
  ]);
  if (d.status === 'visible') {
    await pool.query('UPDATE dm_threads SET last_at = now() WHERE id = $1', [id]);
    // A message is for them: right away (unless they muted this conversation). Never the words themselves.
    // From a stranger it's a request: a quieter note, nothing at all if they declined.
    const { rows: mu } = await pool.query<{ muted: boolean }>('SELECT muted FROM dm_thread_state WHERE thread_id = $1 AND user_id = $2', [id, other]);
    const theirs = id === null ? null : await requestState(other, m.userId, id);
    if (theirs === 'request') await notify({ to: other, kind: 'request', actor: m.userId, group: `dmreq:${id}`, url: '/messages?requests=1' });
    else if (theirs === null && !mu[0]?.muted) await notify({ to: other, kind: 'dm', actor: m.userId, group: `dm:${id}`, url: `/messages/${m.userId}` });
  }
  await logEvent('social_message', { held: d.status !== 'visible' }, null, null);
  res.status(201).json({ thread: await threadView(m.userId, other), review: d.note });
});

/** A message request: accept (it moves to your inbox) or decline (hidden; they aren't told). Block is on profiles. */
for (const [action, state] of [['accept', 'accepted'], ['decline', 'declined']] as const) {
  socialRouter.post(`/api/social/messages/:userId/${action}`, async (req, res) => {
    const m = await member(req);
    const other = idParam(req.params.userId);
    const id = await threadId(m.userId, other, false);
    if (!id) throw new HttpError(404, 'No such conversation');
    await pool.query(
      `INSERT INTO dm_thread_state (thread_id, user_id, request) VALUES ($1, $2, $3)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET request = EXCLUDED.request`,
      [id, m.userId, state],
    );
    res.json(state === 'accepted' ? await threadView(m.userId, other) : { ok: true });
  });
}

socialRouter.post('/api/social/messages/:userId/mute', async (req, res) => {
  const m = await member(req);
  const other = idParam(req.params.userId);
  await messageable(m.userId, other);
  const id = await threadId(m.userId, other, true);
  const muted = (req.body as Record<string, unknown>).muted !== false;
  await pool.query(
    'INSERT INTO dm_thread_state (thread_id, user_id, muted) VALUES ($1, $2, $3) ON CONFLICT (thread_id, user_id) DO UPDATE SET muted = EXCLUDED.muted',
    [id, m.userId, muted],
  );
  res.json(await threadView(m.userId, other));
});

socialRouter.post('/api/social/messages/report/:messageId', async (req, res) => {
  const m = await member(req);
  const mid = idParam(req.params.messageId);
  const { rows } = await pool.query<{ sender_user_id: number; user_a: number; user_b: number }>(
    "SELECT m.sender_user_id, t.user_a, t.user_b FROM dm_messages m JOIN dm_threads t ON t.id = m.thread_id WHERE m.id = $1 AND m.status = 'visible'",
    [mid],
  );
  const r = rows[0];
  if (!r || (r.user_a !== m.userId && r.user_b !== m.userId) || r.sender_user_id === m.userId) throw new HttpError(404, 'Not found');
  const reason = str((req.body as Record<string, unknown>).reason, 'reason', 200) || 'Reported';
  await pool.query('INSERT INTO dm_reports (message_id, reporter_user_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [mid, m.userId, reason]);
  res.status(201).json({ ok: true });
});

/* ======================= Providers: credentials, verified by MyDay ======================= */

const STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(' '));

/** Submit (or resubmit) license credentials. A provider page only exists once MyDay verifies them. */
socialRouter.put('/api/social/provider', async (req, res) => {
  const m = await member(req);
  const b = req.body as Record<string, unknown>;
  const licenseType = str(b.licenseType, 'licenseType', 80, true);
  const licenseState = str(b.licenseState, 'licenseState', 2, true).toUpperCase();
  if (!STATES.has(licenseState)) throw new HttpError(400, 'Pick the state that issued the license');
  const licenseNumber = str(b.licenseNumber, 'licenseNumber', 40, true);
  if (!/^[A-Za-z0-9-./ ]{2,40}$/.test(licenseNumber)) throw new HttpError(400, 'Check the license number');
  const specialties = (Array.isArray(b.specialties) ? b.specialties : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6).map((x) => x.slice(0, 30));
  await pool.query(
    `INSERT INTO provider_credentials (user_id, license_type, license_state, license_number, specialties, status, submitted_at, verified_at, verified_by, reject_reason)
     VALUES ($1, $2, $3, $4, $5, 'submitted', now(), NULL, NULL, NULL)
     ON CONFLICT (user_id) DO UPDATE SET license_type = EXCLUDED.license_type, license_state = EXCLUDED.license_state, license_number = EXCLUDED.license_number,
       specialties = EXCLUDED.specialties, status = 'submitted', submitted_at = now(), verified_at = NULL, verified_by = NULL, reject_reason = NULL`,
    [m.userId, licenseType, licenseState, licenseNumber, specialties],
  );
  await logEvent('provider_submitted', {}, null, null);
  res.json({ status: 'submitted' });
});

socialStaffRouter.get('/api/social/providers/queue', async (req, res) => {
  staff(req);
  const { rows } = await pool.query<{ user_id: number; display_name: string | null; email: string; license_type: string; license_state: string; license_number: string; specialties: string[]; submitted_at: Date }>(
    `SELECT c.user_id, sp.display_name, u.email, c.license_type, c.license_state, c.license_number, c.specialties, c.submitted_at
       FROM provider_credentials c JOIN users u ON u.id = c.user_id LEFT JOIN social_profiles sp ON sp.user_id = c.user_id
      WHERE c.status = 'submitted' ORDER BY c.submitted_at`,
  );
  res.json({ providers: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, email: r.email, licenseType: r.license_type, licenseState: r.license_state, licenseNumber: r.license_number, specialties: r.specialties, submittedAt: r.submitted_at.toISOString() })) });
});

for (const action of ['verify', 'reject'] as const) {
  socialStaffRouter.post(`/api/social/providers/:userId/${action}`, async (req, res) => {
    staff(req);
    const id = idParam(req.params.userId);
    const reason = action === 'reject' ? str((req.body as Record<string, unknown> | undefined)?.reason, 'reason', 200) || 'We couldn’t verify that license' : null;
    const { rowCount } = await pool.query(
      `UPDATE provider_credentials SET status = $2, verified_at = CASE WHEN $2 = 'verified' THEN now() END, verified_by = $3, reject_reason = $4 WHERE user_id = $1 AND status = 'submitted'`,
      [id, action === 'verify' ? 'verified' : 'rejected', req.user?.id ?? null, reason],
    );
    if (!rowCount) throw new HttpError(404, 'Nothing waiting for review');
    await logEvent('provider_reviewed', { action }, null, null);
    res.json({ ok: true, status: action === 'verify' ? 'verified' : 'rejected' });
  });
}

/* ======================= The Feed's public landing page (no sign-in) ======================= */

/** Public, no sign-in: what the landing page shows. Never a member's post — those stay behind the 18+ app gate. */
export const socialPublicRouter = Router();

socialPublicRouter.get('/api/public/feed-preview', async (_req, res) => {
  const { rows: stats } = await pool.query<{ members: number; posts: number }>(
    `SELECT (SELECT COUNT(*)::int FROM social_profiles WHERE banned_at IS NULL) AS members,
            ((SELECT COUNT(*) FROM social_posts WHERE status = 'visible' AND created_at > now() - interval '7 days')
             + (SELECT COUNT(*) FROM forum_posts WHERE status = 'visible' AND created_at > now() - interval '7 days'))::int AS posts`,
  );
  const { rows: web } = await pool.query<{ publisher: string; title: string; url: string; published_at: Date }>(
    `SELECT publisher, title, url, published_at FROM web_items WHERE status = 'visible' AND published_at > now() - interval '90 days' ORDER BY published_at DESC LIMIT 3`,
  );
  const { rows: villages } = await pool.query<{ name: string; description: string }>('SELECT name, description FROM villages ORDER BY sort, id');
  res.set('Cache-Control', 'public, max-age=300').json({
    members: stats[0]?.members ?? 0,
    postsThisWeek: stats[0]?.posts ?? 0,
    web: web.map((w) => ({ publisher: w.publisher, title: w.title, url: w.url, publishedAt: w.published_at.toISOString() })),
    villages,
  });
});
