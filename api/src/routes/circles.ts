/**
 * Community / Circles: family-safe groups (e.g. ADHD families) with posts,
 * comments and reactions, plus a moderation queue for parents and admins.
 *
 * Circles span households, so these tables are read in system scope and every
 * rule lives HERE (see migrations/009_circles.sql):
 *   - there are no direct messages at all;
 *   - kids under 13: no access; teens (13+): teen-ok circles only, shown as
 *     "Teen member" (no name, no profile), every post/comment waits for a
 *     parent in their own household to approve it;
 *   - parents see all of their teens' circle activity;
 *   - reports → moderation queue (circle moderators + MyDay admins); three open
 *     reports hide the item until someone reviews it.
 */
import { Router, type Request } from 'express';
import {
  CIRCLE_REACTIONS,
  type CircleComment,
  type CirclePost,
  type CircleStatus,
  type CircleSummary,
  type CircleView,
  type HouseholdMember,
  type ModerationItem,
  type ModerationQueue,
  type TeenActivity,
} from '@myday/shared';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { logEvent } from '../lib/events.js';
import { HttpError, idParam, str } from '../lib/http.js';
import { self } from '../lib/members.js';
import { TEEN_AGE } from './kidmoney.js';

export const circlesRouter = Router();
/** Moderation works for MyDay admins without a household, so it mounts before the household gate. */
export const circlesStaffRouter = Router();

const HIDE_AT_REPORTS = 3;

interface Who {
  me: HouseholdMember;
  householdId: number;
  teen: boolean;
  admin: boolean;
}

/** Who's asking. Kids under 13 never get past this. Staff may moderate without a household. */
function who(req: Request, staffOk = false): Who {
  const admin = !!req.user && config.adminEmails.includes(req.user.email.toLowerCase());
  if (staffOk && admin && !req.member) {
    return { me: { id: -1, key: 'myday-admin', name: 'MyDay admin', kind: 'adult', age: null }, householdId: -1, teen: false, admin };
  }
  const me = self(req);
  if (!req.householdId) throw new HttpError(409, 'No household');
  const teen = me.kind === 'kid';
  if (teen && (me.age ?? 0) < TEEN_AGE) throw new HttpError(403, 'Circles are for teens and grown-ups');
  return { me, householdId: req.householdId, teen, admin };
}

function requireGrownUp(w: Who): void {
  if (w.teen) throw new HttpError(403, 'Grown-ups only');
}

/** Author label: first name + household initial for grown-ups; teens are never named. */
const AUTHOR = `CASE WHEN x.author_teen THEN 'Teen member' ELSE m.name || ' · ' || upper(left(h.name, 1)) || '.' END`;

interface CircleRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  teen_ok: boolean;
  members: number;
  role: 'member' | 'moderator' | null;
}

async function circleRows(w: Who, id: number | null = null): Promise<CircleRow[]> {
  const { rows } = await pool.query<CircleRow>(
    `SELECT c.id, c.slug, c.name, c.description, c.teen_ok,
            (SELECT COUNT(*)::int FROM circle_members x WHERE x.circle_id = c.id) AS members,
            (SELECT role FROM circle_members x WHERE x.circle_id = c.id AND x.member_id = $1) AS role
       FROM circles c
      WHERE ($2::boolean = false OR c.teen_ok) AND ($3::int IS NULL OR c.id = $3)
      ORDER BY c.id`,
    [w.me.id, w.teen, id],
  );
  return rows;
}

const toSummary = (r: CircleRow, w: Who): CircleSummary => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  description: r.description,
  teenOk: r.teen_ok,
  members: r.members,
  joined: r.role !== null,
  moderator: r.role === 'moderator' || w.admin,
});

async function circleFor(w: Who, id: number, mustJoin: boolean): Promise<CircleSummary> {
  const r = (await circleRows(w, id))[0];
  if (!r) throw new HttpError(404, 'No such circle');
  const c = toSummary(r, w);
  if (mustJoin && !c.joined && !w.admin) throw new HttpError(403, 'Join the circle first');
  return c;
}

async function view(w: Who, id: number): Promise<CircleView> {
  const circle = await circleFor(w, id, true);
  const { rows: posts } = await pool.query<{ id: number; author: string; author_id: number | null; body: string; status: CircleStatus; created_at: Date }>(
    `SELECT x.id, ${AUTHOR} AS author, x.author_id, x.body, x.status, x.created_at
       FROM circle_posts x JOIN household_members m ON m.id = x.author_id JOIN households h ON h.id = x.household_id
      WHERE x.circle_id = $1 AND (x.status = 'visible' OR (x.status = 'pending' AND x.author_id = $2))
      ORDER BY x.created_at DESC, x.id DESC LIMIT 100`,
    [id, w.me.id],
  );
  const ids = posts.map((p) => p.id);
  const { rows: comments } = await pool.query<{ id: number; post_id: number; author: string; author_id: number | null; body: string; status: CircleStatus; created_at: Date }>(
    `SELECT x.id, x.post_id, ${AUTHOR} AS author, x.author_id, x.body, x.status, x.created_at
       FROM circle_comments x JOIN household_members m ON m.id = x.author_id JOIN households h ON h.id = x.household_id
      WHERE x.post_id = ANY($1::int[]) AND (x.status = 'visible' OR (x.status = 'pending' AND x.author_id = $2))
      ORDER BY x.id`,
    [ids, w.me.id],
  );
  const { rows: reacts } = await pool.query<{ post_id: number; emoji: string; n: number; mine: boolean }>(
    `SELECT post_id, emoji, COUNT(*)::int AS n, bool_or(member_id = $2) AS mine
       FROM circle_reactions WHERE post_id = ANY($1::int[]) GROUP BY post_id, emoji`,
    [ids, w.me.id],
  );
  return {
    circle,
    posts: posts.map(
      (p): CirclePost => ({
        id: p.id,
        author: p.author,
        mine: p.author_id === w.me.id,
        body: p.body,
        status: p.status,
        at: p.created_at.toISOString(),
        reactions: CIRCLE_REACTIONS.map((e) => {
          const r = reacts.find((x) => x.post_id === p.id && x.emoji === e);
          return { emoji: e, count: r?.n ?? 0, mine: r?.mine ?? false };
        }),
        comments: comments
          .filter((c) => c.post_id === p.id)
          .map((c): CircleComment => ({ id: c.id, author: c.author, mine: c.author_id === w.me.id, body: c.body, status: c.status, at: c.created_at.toISOString() })),
      }),
    ),
  };
}

const sys = <T>(req: Request, fn: (w: Who) => Promise<T>, staffOk = false): Promise<T> => {
  const w = who(req, staffOk);
  return asSystem(() => fn(w));
};

circlesRouter.get('/api/circles', async (req, res) => {
  res.json({ circles: await sys(req, async (w) => (await circleRows(w)).map((r) => toSummary(r, w))) });
});

/** Grown-ups can start a circle (they moderate it). */
circlesRouter.post('/api/circles', async (req, res) => {
  const out = await sys(req, async (w) => {
    requireGrownUp(w);
    const b = req.body as Record<string, unknown>;
    const name = str(b.name, 'name', 60, true);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'circle';
    const dup = await pool.query('SELECT 1 FROM circles WHERE slug = $1', [slug]);
    if (dup.rowCount) throw new HttpError(409, 'A circle with that name exists');
    const { rows } = await pool.query<{ id: number }>('INSERT INTO circles (slug, name, description, teen_ok, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
      slug, name, str(b.description, 'description', 300), b.teenOk === true, w.me.id,
    ]);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('circle insert returned nothing');
    await pool.query("INSERT INTO circle_members (circle_id, member_id, household_id, role) VALUES ($1, $2, $3, 'moderator')", [id, w.me.id, w.householdId]);
    return circleFor(w, id, false);
  });
  res.status(201).json(out);
});

circlesRouter.post('/api/circles/:id/join', async (req, res) => {
  const id = idParam(req.params.id);
  res.json(
    await sys(req, async (w) => {
      await circleFor(w, id, false); // teens: 404 for non-teen circles
      await pool.query('INSERT INTO circle_members (circle_id, member_id, household_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, w.me.id, w.householdId]);
      return view(w, id);
    }),
  );
});

circlesRouter.post('/api/circles/:id/leave', async (req, res) => {
  const id = idParam(req.params.id);
  res.json(
    await sys(req, async (w) => {
      await pool.query('DELETE FROM circle_members WHERE circle_id = $1 AND member_id = $2', [id, w.me.id]);
      return circleFor(w, id, false);
    }),
  );
});

circlesRouter.get('/api/circles/:id', async (req, res) => {
  const id = idParam(req.params.id);
  res.json(await sys(req, (w) => view(w, id)));
});

circlesRouter.post('/api/circles/:id/posts', async (req, res) => {
  const id = idParam(req.params.id);
  const out = await sys(req, async (w) => {
    await circleFor(w, id, true);
    const body = str((req.body as { body?: unknown }).body, 'body', 2000, true);
    await pool.query('INSERT INTO circle_posts (circle_id, author_id, household_id, author_teen, body, status) VALUES ($1, $2, $3, $4, $5, $6)', [
      id, w.me.id, w.householdId, w.teen, body, w.teen ? 'pending' : 'visible',
    ]);
    await logEvent('circle_post', { circle: id, teen: w.teen }, w.me.id, w.householdId);
    return view(w, id);
  });
  res.status(201).json(out);
});

async function postFor(w: Who, postId: number): Promise<{ circle_id: number; status: CircleStatus; author_id: number | null }> {
  const { rows } = await pool.query<{ circle_id: number; status: CircleStatus; author_id: number | null }>('SELECT circle_id, status, author_id FROM circle_posts WHERE id = $1', [postId]);
  const p = rows[0];
  if (!p) throw new HttpError(404, 'No such post');
  await circleFor(w, p.circle_id, true);
  if (p.status !== 'visible' && p.author_id !== w.me.id) throw new HttpError(404, 'No such post');
  return p;
}

circlesRouter.post('/api/circles/posts/:id/comments', async (req, res) => {
  const postId = idParam(req.params.id);
  const out = await sys(req, async (w) => {
    const p = await postFor(w, postId);
    if (p.status !== 'visible') throw new HttpError(409, 'That post isn’t live yet');
    const body = str((req.body as { body?: unknown }).body, 'body', 1000, true);
    await pool.query('INSERT INTO circle_comments (post_id, author_id, household_id, author_teen, body, status) VALUES ($1, $2, $3, $4, $5, $6)', [
      postId, w.me.id, w.householdId, w.teen, body, w.teen ? 'pending' : 'visible',
    ]);
    return view(w, p.circle_id);
  });
  res.status(201).json(out);
});

/** Toggle a reaction (fixed, friendly set — no free-form). */
circlesRouter.post('/api/circles/posts/:id/react', async (req, res) => {
  const postId = idParam(req.params.id);
  res.json(
    await sys(req, async (w) => {
      const emoji = CIRCLE_REACTIONS.find((e) => e === (req.body as { emoji?: unknown }).emoji);
      if (!emoji) throw new HttpError(400, 'Unknown reaction');
      const p = await postFor(w, postId);
      const del = await pool.query('DELETE FROM circle_reactions WHERE post_id = $1 AND member_id = $2 AND emoji = $3', [postId, w.me.id, emoji]);
      if (!del.rowCount) await pool.query('INSERT INTO circle_reactions (post_id, member_id, emoji) VALUES ($1, $2, $3)', [postId, w.me.id, emoji]);
      return view(w, p.circle_id);
    }),
  );
});

/** Authors can take down their own post or comment. */
circlesRouter.delete('/api/circles/:type/:id', async (req, res) => {
  const type = req.params.type === 'posts' ? 'post' : req.params.type === 'comments' ? 'comment' : null;
  if (!type) throw new HttpError(404, 'Not found');
  const id = idParam(req.params.id);
  res.json(
    await sys(req, async (w) => {
      const table = type === 'post' ? 'circle_posts' : 'circle_comments';
      const r = await pool.query(`UPDATE ${table} SET status = 'removed' WHERE id = $1 AND author_id = $2`, [id, w.me.id]);
      if (!r.rowCount) throw new HttpError(404, 'Not yours to remove');
      return { ok: true };
    }),
  );
});

async function circleOf(type: 'post' | 'comment', id: number): Promise<number> {
  const { rows } = await pool.query<{ circle_id: number }>(
    type === 'post' ? 'SELECT circle_id FROM circle_posts WHERE id = $1' : 'SELECT p.circle_id FROM circle_comments c JOIN circle_posts p ON p.id = c.post_id WHERE c.id = $1',
    [id],
  );
  const c = rows[0]?.circle_id;
  if (c === undefined) throw new HttpError(404, 'Not found');
  return c;
}

circlesRouter.post('/api/circles/report', async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const type = b.type === 'post' || b.type === 'comment' ? b.type : null;
  if (!type) throw new HttpError(400, 'type is post or comment');
  const id = idParam(b.id);
  res.status(201).json(
    await sys(req, async (w) => {
      const circleId = await circleOf(type, id);
      await circleFor(w, circleId, true);
      await pool.query('INSERT INTO circle_reports (target_type, target_id, circle_id, reporter_id, reason) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [
        type, id, circleId, w.me.id, str(b.reason, 'reason', 200),
      ]);
      const { rows } = await pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM circle_reports WHERE target_type = $1 AND target_id = $2 AND status = 'open'", [type, id]);
      const hidden = (rows[0]?.n ?? 0) >= HIDE_AT_REPORTS;
      if (hidden) await pool.query(`UPDATE ${type === 'post' ? 'circle_posts' : 'circle_comments'} SET status = 'hidden' WHERE id = $1 AND status = 'visible'`, [id]);
      return { ok: true, hidden };
    }),
  );
});

/* ---------- moderation: parents (teen approvals) + moderators/admins (reports) ---------- */

async function queue(w: Who): Promise<ModerationQueue> {
  requireGrownUp(w);
  const items: ModerationItem[] = [];
  for (const type of ['post', 'comment'] as const) {
    const table = type === 'post' ? 'circle_posts' : 'circle_comments';
    const circleJoin = type === 'post' ? 'JOIN circles c ON c.id = x.circle_id' : 'JOIN circle_posts pp ON pp.id = x.post_id JOIN circles c ON c.id = pp.circle_id';
    // Teen items waiting for THEIR parents (named for the parent: it's their own kid).
    const { rows: teen } = await pool.query<{ id: number; circle: string; author: string; body: string; status: CircleStatus; created_at: Date }>(
      `SELECT x.id, c.name AS circle, m.name AS author, x.body, x.status, x.created_at
         FROM ${table} x ${circleJoin} JOIN household_members m ON m.id = x.author_id
        WHERE x.status = 'pending' AND x.author_teen AND x.household_id = $1 ORDER BY x.id`,
      [w.householdId],
    );
    for (const r of teen) items.push({ type, id: r.id, circle: r.circle, author: r.author, body: r.body, status: r.status, at: r.created_at.toISOString(), reason: 'teen_approval', reports: [] });
    // Reported items in circles I moderate (all circles for admins).
    const { rows: rep } = await pool.query<{ id: number; circle: string; author: string; body: string; status: CircleStatus; created_at: Date; reports: Array<{ id: number; reason: string }> }>(
      `SELECT x.id, c.name AS circle, ${AUTHOR} AS author, x.body, x.status, x.created_at,
              json_agg(json_build_object('id', r.id, 'reason', r.reason) ORDER BY r.id) AS reports
         FROM circle_reports r JOIN ${table} x ON x.id = r.target_id ${circleJoin}
         JOIN household_members m ON m.id = x.author_id JOIN households h ON h.id = x.household_id
        WHERE r.target_type = $1 AND r.status = 'open'
          AND ($2::boolean OR EXISTS (SELECT 1 FROM circle_members cm WHERE cm.circle_id = c.id AND cm.member_id = $3 AND cm.role = 'moderator'))
        GROUP BY x.id, c.name, m.name, h.name, x.author_teen, x.body, x.status, x.created_at ORDER BY x.id`,
      [type, w.admin, w.me.id],
    );
    for (const r of rep) items.push({ type, id: r.id, circle: r.circle, author: r.author, body: r.body, status: r.status, at: r.created_at.toISOString(), reason: 'reported', reports: r.reports });
  }
  return { items, isAdmin: w.admin };
}

circlesStaffRouter.get('/api/circles/moderation/queue', async (req, res) => {
  res.json(await sys(req, queue, true));
});

/** approve | remove | dismiss. Teen items: their parent decides. Reported items: moderators/admins. */
circlesStaffRouter.post('/api/circles/moderation/:type/:id/:action', async (req, res) => {
  const type = req.params.type === 'post' || req.params.type === 'comment' ? req.params.type : null;
  const action = ['approve', 'remove', 'dismiss'].find((a) => a === req.params.action);
  if (!type || !action) throw new HttpError(404, 'Not found');
  const id = idParam(req.params.id);
  res.json(
    await sys(req, async (w) => {
      requireGrownUp(w);
      const table = type === 'post' ? 'circle_posts' : 'circle_comments';
      const { rows } = await pool.query<{ status: CircleStatus; author_teen: boolean; household_id: number }>(`SELECT status, author_teen, household_id FROM ${table} WHERE id = $1`, [id]);
      const item = rows[0];
      if (!item) throw new HttpError(404, 'Not found');
      const circleId = await circleOf(type, id);
      const mod =
        w.admin ||
        ((await pool.query("SELECT 1 FROM circle_members WHERE circle_id = $1 AND member_id = $2 AND role = 'moderator'", [circleId, w.me.id])).rowCount ?? 0) > 0;
      const parent = item.author_teen && item.household_id === w.householdId;
      const teenPending = item.status === 'pending' && item.author_teen;
      if (teenPending ? !parent : !mod) throw new HttpError(403, teenPending ? 'Only the teen’s parent approves this' : 'Moderators only');
      if (action === 'approve') await pool.query(`UPDATE ${table} SET status = 'visible' WHERE id = $1`, [id]);
      if (action === 'remove') await pool.query(`UPDATE ${table} SET status = 'removed' WHERE id = $1`, [id]);
      await pool.query("UPDATE circle_reports SET status = 'resolved', resolution = $3 WHERE target_type = $1 AND target_id = $2 AND status = 'open'", [type, id, action]);
      if (w.me.id > 0) await logEvent('circle_moderation', { type, action, by: parent ? 'parent' : 'moderator' }, w.me.id, w.householdId);
      else await logEvent('circle_moderation', { type, action, by: 'admin' }, null, null);
      return queue(w);
    }, true),
  );
});

/** Parents see everything their teens do in circles. */
circlesRouter.get('/api/circles/activity/teens', async (req, res) => {
  res.json(
    await sys(req, async (w): Promise<TeenActivity> => {
      requireGrownUp(w);
      const { rows } = await pool.query<{ teen: string; circle: string; type: 'post' | 'comment' | 'reaction'; body: string; status: CircleStatus; at: Date }>(
        `SELECT m.name AS teen, c.name AS circle, 'post' AS type, x.body, x.status, x.created_at AS at
           FROM circle_posts x JOIN circles c ON c.id = x.circle_id JOIN household_members m ON m.id = x.author_id
          WHERE x.author_teen AND x.household_id = $1
         UNION ALL
         SELECT m.name, c.name, 'comment', x.body, x.status, x.created_at
           FROM circle_comments x JOIN circle_posts p ON p.id = x.post_id JOIN circles c ON c.id = p.circle_id JOIN household_members m ON m.id = x.author_id
          WHERE x.author_teen AND x.household_id = $1
         UNION ALL
         SELECT m.name, c.name, 'reaction', r.emoji || ' on: ' || left(p.body, 60), 'visible', p.created_at
           FROM circle_reactions r JOIN household_members m ON m.id = r.member_id JOIN circle_posts p ON p.id = r.post_id JOIN circles c ON c.id = p.circle_id
          WHERE m.household_id = $1 AND m.kind = 'kid'
         ORDER BY at DESC LIMIT 200`,
        [w.householdId],
      );
      return { items: rows.map((r) => ({ ...r, at: r.at.toISOString() })) };
    }),
  );
});
