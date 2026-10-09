/**
 * The Feed's growth loops, gently: digests for people who've been away, people you may know (mutual follows,
 * and contacts you choose to share — matched, never stored), one-tap village invites, and a personal invite
 * link with a rich preview.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { FeedSuggestion } from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { runFeedDigests, unsubscribeSig } from '../lib/feeddigest.js';
import { notify } from '../lib/feednotify.js';
import { HttpError, idParam } from '../lib/http.js';
import { rateLimiter } from '../lib/pin.js';
import { imageUrl, member, NOT_BLOCKED } from './community.js';

export const feedGrowthRouter = Router();
/** No sign-in: the digest email's unsubscribe link, and an invite link's "who invited you". */
export const feedGrowthPublicRouter = Router();

const feedOrigin = (): string => config.feedAppUrl || config.publicUrl;

/* ---------- digests ---------- */

feedGrowthRouter.post('/api/dev/feed/digests', async (req, res) => {
  if (config.production || !config.devLoginToken || req.query.token !== config.devLoginToken) throw new HttpError(404, 'Not found');
  res.json({ sent: await runFeedDigests(typeof req.query.at === 'string' ? new Date(req.query.at) : undefined) });
});

feedGrowthPublicRouter.get('/api/feed/unsubscribe', async (req, res) => {
  const id = Number(req.query.u);
  const t = String(req.query.t ?? '');
  const want = Number.isInteger(id) && id > 0 ? unsubscribeSig(id) : '';
  const ok = !!want && t.length === want.length && timingSafeEqual(Buffer.from(t), Buffer.from(want));
  if (ok) {
    await asSystem(() =>
      pool.query(
        `INSERT INTO feed_notification_prefs (user_id, digest_email) VALUES ($1, false)
         ON CONFLICT (user_id) DO UPDATE SET digest_email = false, updated_at = now()`,
        [id],
      ),
    );
  }
  res
    .status(ok ? 200 : 400)
    .type('html')
    .send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Feed</title>
<body style="font:17px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#12100e;color:#f3e9dc;display:grid;place-items:center;min-height:90vh;margin:0;padding:0 16px">
<main style="max-width:30rem;text-align:center"><h1 style="font-weight:600">${ok ? 'You’re unsubscribed' : 'That link didn’t work'}</h1>
<p>${ok ? 'No more “what you missed” emails. You can turn them back on in the Feed’s notification settings.' : 'Open the Feed’s notification settings to turn the emails off.'}</p>
<p><a style="color:#e9a35d" href="${feedOrigin()}/notifications">Open The Feed</a></p></main></body>`,
    );
});

/* ---------- people you may know: contacts (matched, never stored) ---------- */

const matchLimit = rateLimiter(6, 60 * 60_000);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

feedGrowthRouter.post('/api/feed/contacts/match', async (req, res) => {
  const m = await member(req);
  if (!matchLimit(`u${m.userId}`)) throw new HttpError(429, 'That’s a lot of looking up — try again in a bit.');
  const raw = (req.body as { emails?: unknown }).emails;
  if (!Array.isArray(raw)) throw new HttpError(400, 'Send the email addresses to look for');
  const emails = [...new Set(raw.filter((e): e is string => typeof e === 'string').map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e) && e.length <= 200))].slice(0, 500);
  if (!emails.length) {
    res.json({ people: [], checked: 0 });
    return;
  }
  // Only people who let others find them by email; never you, never across a block, never banned.
  const { rows } = await pool.query<{ user_id: number; display_name: string; username: string | null; avatar: number | null; followers: number; followed: boolean }>(
    `SELECT p.user_id, p.display_name, p.username,
            (SELECT id FROM community_images ci WHERE ci.id = p.avatar_id AND ci.status = 'visible') AS avatar,
            (SELECT COUNT(*)::int FROM social_follows f WHERE f.followed_user_id = p.user_id) AS followers,
            EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = p.user_id) AS followed
       FROM social_profiles p JOIN users u ON u.id = p.user_id
      WHERE lower(u.email) = ANY($2) AND p.user_id <> $1 AND p.banned_at IS NULL AND p.findable_by_email AND ${NOT_BLOCKED('p.user_id')}
      LIMIT 100`,
    [m.userId, emails],
  );
  const people: Array<FeedSuggestion & { followedByMe: boolean }> = rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    username: r.username,
    avatarUrl: imageUrl(r.avatar),
    followers: r.followers,
    provider: false,
    reason: 'In your contacts',
    followedByMe: r.followed,
  }));
  // The list itself is not kept anywhere.
  res.json({ people, checked: emails.length });
});

feedGrowthRouter.get('/api/feed/privacy', async (req, res) => {
  const m = await member(req);
  res.json({ findableByEmail: m.profile.findable_by_email !== false });
});

feedGrowthRouter.put('/api/feed/privacy', async (req, res) => {
  const m = await member(req);
  const v = (req.body as { findableByEmail?: unknown }).findableByEmail;
  if (typeof v !== 'boolean') throw new HttpError(400, 'On or off?');
  await pool.query('UPDATE social_profiles SET findable_by_email = $2 WHERE user_id = $1', [m.userId, v]);
  res.json({ findableByEmail: v });
});

/* ---------- village invites (one tap) ---------- */

async function villageOf(slug: string): Promise<{ id: number; name: string }> {
  const { rows } = await pool.query<{ id: number; name: string }>('SELECT id, name FROM villages WHERE slug = $1', [slug]);
  if (!rows[0]) throw new HttpError(404, 'No such village');
  return rows[0];
}

/** Your people (you follow them or they follow you) who aren't in this village yet. */
feedGrowthRouter.get('/api/villages/:slug/invitees', async (req, res) => {
  const m = await member(req);
  const v = await villageOf(String(req.params.slug));
  const { rows } = await pool.query<{ user_id: number; display_name: string; username: string | null; invited: boolean }>(
    `SELECT p.user_id, p.display_name, p.username,
            EXISTS (SELECT 1 FROM village_invites i WHERE i.village_id = $2 AND i.from_user = $1 AND i.to_user = p.user_id) AS invited
       FROM social_profiles p
      WHERE p.user_id <> $1 AND p.banned_at IS NULL AND ${NOT_BLOCKED('p.user_id')}
        AND (EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = p.user_id)
             OR EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = p.user_id AND f.followed_user_id = $1))
        AND NOT EXISTS (SELECT 1 FROM village_members vm WHERE vm.village_id = $2 AND vm.user_id = p.user_id)
      ORDER BY p.display_name LIMIT 100`,
    [m.userId, v.id],
  );
  res.json({ village: v.name, people: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, username: r.username, invited: r.invited })) });
});

feedGrowthRouter.post('/api/villages/:slug/invite', async (req, res) => {
  const m = await member(req);
  const slug = String(req.params.slug);
  const v = await villageOf(slug);
  const raw = (req.body as { userIds?: unknown }).userIds;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Pick who to invite');
  let invited = 0;
  for (const x of raw.slice(0, 50)) {
    const to = idParam(x);
    if (to === m.userId) continue;
    const ok = await pool.query(`SELECT 1 FROM social_profiles p WHERE p.user_id = $2 AND p.banned_at IS NULL AND ${NOT_BLOCKED('p.user_id')}`, [m.userId, to]);
    if (!ok.rowCount) continue;
    const r = await pool.query('INSERT INTO village_invites (village_id, from_user, to_user) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [v.id, m.userId, to]);
    if (!r.rowCount) continue;
    await notify({ to, kind: 'invite', actor: m.userId, group: `invite:${slug}`, url: `/village?v=${slug}`, snippet: v.name });
    invited++;
  }
  res.status(201).json({ invited });
});

/* ---------- your invite link ---------- */

feedGrowthRouter.get('/api/feed/invite', async (req, res) => {
  const m = await member(req);
  const { rows } = await asSystem(() => pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM users WHERE referred_by = $1', [m.userId]));
  const u = m.profile.username;
  res.json({ link: u ? `${feedOrigin()}/invite/${encodeURIComponent(u)}` : `${feedOrigin()}/?join=1`, joined: rows[0]?.n ?? 0 });
});

/** Who's inviting you (an invite link's page, signed out): first name only. */
feedGrowthPublicRouter.get('/api/public/invite/:username', async (req, res) => {
  const { rows } = await asSystem(() =>
    pool.query<{ display_name: string }>('SELECT display_name FROM social_profiles WHERE username = $1 AND banned_at IS NULL', [String(req.params.username).toLowerCase()]),
  );
  if (!rows[0]) throw new HttpError(404, 'No such invite');
  res.set('Cache-Control', 'public, max-age=300').json({ name: rows[0].display_name });
});
