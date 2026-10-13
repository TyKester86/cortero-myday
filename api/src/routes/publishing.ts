/**
 * The Feed Publishing API, v1 (https://app.thefeedsocial.com/api/v1). Every call authenticates with a
 * bearer access token (routes/oauth.ts `bearer`) and acts as the person who authorized the app -- never
 * anyone else. Breaking changes go under /api/v2; v1 only ever gains fields and endpoints.
 *
 * Posting goes through the very same functions as The Feed's own composer and photo uploader
 * (createFeedPost / storeFeedImage in routes/community.ts): same 18+/profile/ban/mute checks, same
 * screening, same "under review" holds, same crisis escalation. There is no other way in.
 *
 * Where an app can post: the main Feed (18+), as the person, and nowhere else. No Villages, no Circles,
 * nothing a kid or teen can see -- there is no parameter for it under any scope.
 */
import express, { Router, type Request } from 'express';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError, idParam } from '../lib/http.js';
import { openText } from '../lib/seal.js';
import { createFeedPost, member, storeFeedImage, type Via } from './community.js';
import { bearer, needScope } from './oauth.js';

export const feedApiV1Router = Router();

feedApiV1Router.use('/api/v1', bearer);

const via = (req: Request): Via => ({ appId: req.apiAuth!.appId, name: req.apiAuth!.appName });

/** profile.read: who the token acts for. */
feedApiV1Router.get('/api/v1/me', async (req, res) => {
  needScope(req, res, 'profile.read');
  const m = await member(req);
  res.json({
    id: m.userId,
    displayName: m.profile.display_name,
    username: m.profile.username,
    profileUrl: m.profile.username && config.feedAppUrl ? `${config.feedAppUrl}/u/${m.profile.username}` : null,
  });
});

/* ---------- media ---------- */

const MAX_MEDIA = 8 * 1024 * 1024;

/**
 * Upload one photo (raw bytes; JPEG, PNG or WebP; up to 8 MB). It is screened right here, like a photo
 * added in the app. Returns its media id for POST /posts. Video: The Feed's posts carry photos only.
 */
feedApiV1Router.post('/api/v1/media', express.raw({ type: () => true, limit: MAX_MEDIA }), async (req, res) => {
  needScope(req, res, 'posts.write');
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('video/')) throw new HttpError(415, 'Feed posts carry photos only — video isn’t supported (v1)', 'unsupported_media');
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!data.length) throw new HttpError(400, 'Send the photo’s bytes as the request body', 'empty_media');
  const p = await storeFeedImage(req, data, via(req));
  res.status(201).json({ id: p.id, status: p.decision.status === 'visible' ? 'ready' : 'held' });
});

/* ---------- posts ---------- */

/** What an app sees of a post: its own, made for this person. Status is the truth, as of this request. */
type ApiPostStatus = 'published' | 'held' | 'removed';
interface ApiPost {
  id: number;
  status: ApiPostStatus;
  text: string;
  mediaIds: number[];
  audience: 'public' | 'friends';
  createdAt: string;
  url: string | null;
  via: { appId: number; name: string };
}

// visible = on The Feed; pending = held by screening for a moderator; hidden = taken down by reports
// until a moderator decides (also "held"); removed = deleted by the author/app or removed by moderators.
const STATUS: Record<string, ApiPostStatus> = { visible: 'published', pending: 'held', hidden: 'held', removed: 'removed' };

async function ownPost(req: Request, id: number): Promise<ApiPost> {
  const a = req.apiAuth!;
  const { rows } = await pool.query<{ id: number; body_enc: Buffer; key_id: string; image_id: number | null; status: string; audience: 'public' | 'friends'; created_at: Date }>(
    'SELECT id, body_enc, key_id, image_id, status, audience, created_at FROM social_posts WHERE id = $1 AND via_app_id = $2 AND author_user_id = $3',
    [id, a.appId, a.userId],
  );
  const r = rows[0];
  // Another app's post, another person's post, a post made in The Feed itself: all simply "not found".
  if (!r) throw new HttpError(404, 'No such post made by this app for this person', 'not_found');
  const status = STATUS[r.status] ?? 'held';
  return {
    id: r.id,
    status,
    text: status === 'removed' ? '' : openText(r.body_enc, r.key_id),
    mediaIds: r.image_id ? [r.image_id] : [],
    audience: r.audience,
    createdAt: r.created_at.toISOString(),
    url: config.feedAppUrl ? `${config.feedAppUrl}/feed/post/${r.id}` : `/feed/post/${r.id}`,
    via: { appId: a.appId, name: a.appName },
  };
}

const FIELDS = new Set(['text', 'mediaIds', 'audience']);
// Anything that names another place to post. The answer is always no.
const OTHER_SURFACES = /^(village|villageid|circle|circleid|thread|threadid|forum|surface|kid|kids|teen|household|member|memberid|group|story|clip)$/i;

feedApiV1Router.post('/api/v1/posts', express.json({ limit: '64kb' }), async (req, res) => {
  needScope(req, res, 'posts.write');
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const keys = Object.keys(b);
  const elsewhere = keys.filter((k) => OTHER_SURFACES.test(k));
  if (elsewhere.length) {
    throw new HttpError(403, 'Apps can publish to the main Feed (18+) only — never to Villages, Circles, stories, clips or any space a kid or teen can see.', 'surface_not_allowed', { fields: elsewhere });
  }
  const unknown = keys.filter((k) => !FIELDS.has(k));
  if (unknown.length) throw new HttpError(400, `Unknown field(s): ${unknown.join(', ')}`, 'unknown_field', { fields: unknown });
  if (b.text !== undefined && typeof b.text !== 'string') throw new HttpError(400, 'text must be a string', 'invalid_text');
  const text = typeof b.text === 'string' ? b.text : '';
  if (text.length > 2000) throw new HttpError(400, 'text is limited to 2000 characters', 'text_too_long');
  let imageId: number | null = null;
  if (b.mediaIds !== undefined) {
    if (!Array.isArray(b.mediaIds)) throw new HttpError(400, 'mediaIds must be an array of media ids', 'invalid_media');
    if (b.mediaIds.length > 1) throw new HttpError(400, 'A Feed post carries one photo', 'too_many_media');
    imageId = b.mediaIds.length ? idParam(b.mediaIds[0]) : null;
  }
  if (b.audience !== undefined && b.audience !== 'public' && b.audience !== 'friends') throw new HttpError(400, 'audience is "public" or "friends"', 'invalid_audience');
  if (!text.trim() && !imageId) throw new HttpError(400, 'A post needs text or a photo', 'empty_post');
  const p = await createFeedPost(req, { body: text, imageId, audience: b.audience }, via(req));
  res.status(201).json({ post: await ownPost(req, p.id) });
});

feedApiV1Router.get('/api/v1/posts/:id', async (req, res) => {
  needScope(req, res, 'posts.write');
  res.json({ post: await ownPost(req, idParam(req.params.id)) });
});

/** The owning app deletes a post it made (the author can always delete it in The Feed too). */
feedApiV1Router.delete('/api/v1/posts/:id', async (req, res) => {
  needScope(req, res, 'posts.write');
  const a = req.apiAuth!;
  const { rowCount } = await pool.query(
    "UPDATE social_posts SET status = 'removed' WHERE id = $1 AND via_app_id = $2 AND author_user_id = $3 AND status <> 'removed'",
    [idParam(req.params.id), a.appId, a.userId],
  );
  if (!rowCount) throw new HttpError(404, 'No such post made by this app for this person', 'not_found');
  res.json({ ok: true });
});

// Nothing else lives under /api/v1: an unknown path stops here (it never reaches the session routes).
feedApiV1Router.use('/api/v1', () => {
  throw new HttpError(404, 'No such endpoint in the Feed API v1', 'not_found');
});
