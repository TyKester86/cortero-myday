/**
 * The Feed's notifications: one row per thing that happened to you (inbox, badge count), pushed to the Feed
 * app with smart timing —
 *  - what's said to YOU (replies, mentions, messages, milestones) goes right away;
 *  - likes, comments, follows and village activity wait a few minutes and arrive grouped
 *    ("Ana and 3 others liked your post"), at most one ping per thing every two hours;
 *  - never in your quiet hours (default 10pm–8am, held until they end), never more than a handful a day,
 *    and only the kinds you left on. The inbox keeps everything either way.
 * Nothing is sent about someone you blocked (or who blocked you), and nothing from held content.
 */
import webpush from 'web-push';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { inQuietHours, localTime, realPush, stubbed } from './push.js';
import { registerJob } from './schedulers.js';

export type FeedNoticeKind = 'like' | 'comment' | 'reply' | 'follow' | 'mention' | 'dm' | 'request' | 'village' | 'milestone' | 'invite' | 'joined' | 'tip' | 'supporter';

const NOW_KINDS = new Set<FeedNoticeKind>(['reply', 'mention', 'dm', 'milestone', 'invite', 'joined', 'tip', 'supporter']);
const BATCH_MINUTES = 15;
const REPING_HOURS = 2;
const DAILY_CAP = 8;
const PREF_OF: Record<FeedNoticeKind, string> = {
  like: 'likes',
  comment: 'comments',
  reply: 'replies',
  follow: 'follows',
  mention: 'mentions',
  dm: 'dms',
  request: 'dms',
  village: 'villages',
  milestone: 'milestones',
  invite: 'villages',
  joined: 'follows',
  tip: 'milestones',
  supporter: 'milestones',
};

export interface Notice {
  to: number;
  kind: FeedNoticeKind;
  actor: number | null;
  /** Same key = same thing (grouped in the inbox, one push). */
  group: string;
  url: string;
  snippet?: string | null;
}

/** Record it (and queue its push). Quietly does nothing for yourself, or across a block either way. */
export async function notify(n: Notice): Promise<void> {
  if (n.actor !== null && n.actor === n.to) return;
  await asSystem(async () => {
    if (n.actor !== null) {
      const { rowCount } = await pool.query(
        'SELECT 1 FROM social_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2) OR (blocker_user_id = $2 AND blocked_user_id = $1)',
        [n.to, n.actor],
      );
      if (rowCount) return;
    }
    const delay = NOW_KINDS.has(n.kind) ? 0 : BATCH_MINUTES;
    await pool.query(
      `INSERT INTO feed_notifications (user_id, kind, actor_user_id, group_key, url, snippet, push_after)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int))
       ON CONFLICT DO NOTHING`,
      [n.to, n.kind, n.actor, n.group, n.url, n.snippet ? n.snippet.slice(0, 120) : null, delay],
    );
  });
}

/** Everyone @mentioned in a piece of text (by username) hears about it. */
export async function notifyMentions(text: string, actor: number, group: string, url: string): Promise<void> {
  const names = [...new Set([...text.matchAll(/(?:^|[^\w@])@([a-z0-9_.]{3,20})/gi)].map((m) => (m[1] ?? '').toLowerCase().replace(/\.$/, '')))].slice(0, 10);
  if (!names.length) return;
  const { rows } = await asSystem(() => pool.query<{ user_id: number }>('SELECT user_id FROM social_profiles WHERE username = ANY($1) AND banned_at IS NULL', [names]));
  for (const r of rows) await notify({ to: r.user_id, kind: 'mention', actor, group, url, snippet: text });
}

/** A once-ever moment worth celebrating (first post, 10 followers, a 30-day streak). */
export async function milestone(userId: number, key: string, text: string, url: string): Promise<void> {
  await notify({ to: userId, kind: 'milestone', actor: null, group: `milestone:${key}`, url, snippet: text });
}

/* ---------- the inbox ---------- */

export interface InboxItem {
  key: string;
  kind: FeedNoticeKind;
  text: string;
  url: string;
  at: string;
  unread: boolean;
  count: number;
  /** The most recent people involved (first names). */
  actors: Array<{ userId: number; name: string }>;
  /** Follows: whether you follow them back (a "Follow back" button). Replies/mentions: "Reply". */
  prompt: 'follow_back' | 'reply' | null;
  followsBack: boolean;
}

function words(kind: FeedNoticeKind, names: string[], count: number, snippet: string | null): string {
  const who = !names.length ? 'Someone' : count <= 1 ? names[0] : count === 2 && names[1] ? `${names[0]} and ${names[1]}` : `${names[0]} and ${count - 1} others`;
  const quote = snippet ? `: “${snippet.length > 80 ? `${snippet.slice(0, 79)}…` : snippet}”` : '';
  switch (kind) {
    case 'like':
      return `${who} liked your post`;
    case 'comment':
      return `${who} commented on your clip${quote}`;
    case 'reply':
      return `${who} replied to you${quote}`;
    case 'follow':
      return `${who} started following you`;
    case 'mention':
      return `${who} mentioned you${quote}`;
    case 'dm':
      return `${who} sent you a message`;
    case 'request':
      return `${who} sent you a message request`;
    case 'village':
      return `New in your village${quote}`;
    case 'milestone':
      return snippet ?? 'A milestone';
    case 'invite':
      return `${who} invited you to ${snippet ?? 'a village'}`;
    case 'joined':
      return `${who} joined The Feed from your invite`;
    case 'tip':
      return `${who} sent you a ${snippet ?? ''} tip`.replace('  ', ' ');
    case 'supporter':
      return `${who} is now supporting you${snippet ? ` (${snippet} a month)` : ''}`;
  }
}

/** Your notifications, newest first, grouped by what they're about (the last two weeks). */
export async function inbox(userId: number, limit = 50): Promise<{ items: InboxItem[]; unread: number }> {
  return asSystem(async () => {
    const { rows } = await pool.query<{
      group_key: string;
      kind: FeedNoticeKind;
      url: string;
      at: Date;
      unread: number;
      n: number;
      snippet: string | null;
      actors: Array<{ id: number; name: string }> | null;
      follows_back: boolean;
    }>(
      `SELECT g.group_key, g.kind, g.url, g.at, g.unread, g.n, g.snippet, g.actors,
              EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = g.last_actor) AS follows_back
         FROM (
           SELECT n.group_key, (array_agg(n.kind ORDER BY n.created_at DESC))[1] AS kind, (array_agg(n.url ORDER BY n.created_at DESC))[1] AS url,
                  max(n.created_at) AS at, COUNT(*) FILTER (WHERE n.read_at IS NULL)::int AS unread,
                  COUNT(DISTINCT COALESCE(n.actor_user_id, -n.id))::int AS n,
                  (array_agg(n.snippet ORDER BY n.created_at DESC))[1] AS snippet,
                  (array_agg(n.actor_user_id ORDER BY n.created_at DESC))[1] AS last_actor,
                  (SELECT json_agg(json_build_object('id', a.user_id, 'name', a.display_name))
                     FROM (SELECT DISTINCT ON (x.actor_user_id) x.actor_user_id, x.created_at FROM feed_notifications x
                            WHERE x.user_id = $1 AND x.group_key = n.group_key AND x.actor_user_id IS NOT NULL ORDER BY x.actor_user_id, x.created_at DESC) d
                     JOIN social_profiles a ON a.user_id = d.actor_user_id) AS actors
             FROM feed_notifications n
            WHERE n.user_id = $1 AND n.created_at > now() - interval '14 days'
            GROUP BY n.group_key
         ) g
        ORDER BY g.at DESC LIMIT $2`,
      [userId, limit],
    );
    const { rows: c } = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM feed_notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    const items = rows.map((r): InboxItem => {
      const actors = (r.actors ?? []).slice(0, 3).map((a) => ({ userId: a.id, name: a.name }));
      return {
        key: r.group_key,
        kind: r.kind,
        text: words(r.kind, actors.map((a) => a.name), r.n, r.snippet),
        url: r.url,
        at: r.at.toISOString(),
        unread: r.unread > 0,
        count: r.n,
        actors,
        prompt: (r.kind === 'follow' || r.kind === 'joined') && !r.follows_back ? 'follow_back' : r.kind === 'reply' || r.kind === 'mention' ? 'reply' : null,
        followsBack: r.follows_back,
      };
    });
    return { items, unread: c[0]?.n ?? 0 };
  });
}

export async function unreadCount(userId: number): Promise<number> {
  const { rows } = await asSystem(() => pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM feed_notifications WHERE user_id = $1 AND read_at IS NULL', [userId]));
  return rows[0]?.n ?? 0;
}

/* ---------- push: smart timing ---------- */

interface PrefRow {
  push: boolean;
  quiet_start: string;
  quiet_end: string;
  [k: string]: boolean | string;
}
const DEFAULT_PREFS: PrefRow = { push: true, likes: true, comments: true, replies: true, follows: true, mentions: true, dms: true, villages: true, milestones: true, quiet_start: '22:00', quiet_end: '08:00' };

/** The next time the clock (in the app's time zone) reads hh:mm. */
function nextLocal(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const cur = localTime(now).split(':').map(Number) as [number, number];
  let mins = h * 60 + m - (cur[0] * 60 + cur[1]);
  if (mins <= 0) mins += 24 * 60;
  return new Date(now.getTime() + mins * 60_000);
}

/** Send the pushes that are due (by the database's clock — the one that dated them, unless told otherwise). */
export async function deliverDue(at?: Date): Promise<number> {
  return asSystem(async () => {
    const now = at ?? (await pool.query<{ n: Date }>('SELECT now() AS n')).rows[0]?.n ?? new Date();
    const { rows } = await pool.query<{ user_id: number; group_key: string; kind: FeedNoticeKind; ids: string[]; url: string; snippet: string | null; names: string[]; n: number }>(
      `SELECT n.user_id, n.group_key, (array_agg(n.kind ORDER BY n.created_at DESC))[1] AS kind, array_agg(n.id) AS ids,
              (array_agg(n.url ORDER BY n.created_at DESC))[1] AS url, (array_agg(n.snippet ORDER BY n.created_at DESC))[1] AS snippet,
              ARRAY(SELECT p.display_name FROM feed_notifications x JOIN social_profiles p ON p.user_id = x.actor_user_id
                     WHERE x.user_id = n.user_id AND x.group_key = n.group_key AND x.push_state = 'pending' GROUP BY p.display_name ORDER BY max(x.created_at) DESC LIMIT 3) AS names,
              COUNT(DISTINCT COALESCE(n.actor_user_id, -n.id))::int AS n
         FROM feed_notifications n
        WHERE n.push_state = 'pending' AND n.push_after <= $1
        GROUP BY n.user_id, n.group_key`,
      [now],
    );
    let sent = 0;
    const hhmm = localTime(now);
    for (const g of rows) {
      const ids = g.ids.map(Number);
      const mark = (state: 'sent' | 'skipped'): Promise<unknown> =>
        pool.query(`UPDATE feed_notifications SET push_state = $2, pushed_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz ELSE pushed_at END WHERE id = ANY($1::bigint[])`, [ids, state, now]);
      const { rows: pr } = await pool.query<PrefRow>('SELECT * FROM feed_notification_prefs WHERE user_id = $1', [g.user_id]);
      const prefs = pr[0] ?? DEFAULT_PREFS;
      if (!prefs.push || prefs[PREF_OF[g.kind]] === false) {
        await mark('skipped');
        continue;
      }
      // Quiet hours: hold it until they end.
      if (inQuietHours(hhmm, prefs.quiet_start, prefs.quiet_end)) {
        await pool.query('UPDATE feed_notifications SET push_after = $2 WHERE id = ANY($1::bigint[])', [ids, nextLocal(prefs.quiet_end, now)]);
        continue;
      }
      // One ping per thing every couple of hours (likes keep landing in the inbox), and a daily ceiling.
      const recent = await pool.query(
        `SELECT 1 FROM feed_notifications WHERE user_id = $1 AND group_key = $2 AND push_state = 'sent'
            AND pushed_at > $3::timestamptz - make_interval(hours => $4::int) AND pushed_at <= $3::timestamptz LIMIT 1`,
        [g.user_id, g.group_key, now, REPING_HOURS],
      );
      const { rows: day } = await pool.query<{ n: number }>(
        `SELECT COUNT(DISTINCT group_key)::int AS n FROM feed_notifications
          WHERE user_id = $1 AND push_state = 'sent' AND pushed_at > $2::timestamptz - interval '24 hours' AND pushed_at <= $2::timestamptz`,
        [g.user_id, now],
      );
      if ((recent.rowCount && !NOW_KINDS.has(g.kind)) || ((day[0]?.n ?? 0) >= DAILY_CAP && g.kind !== 'dm')) {
        await mark('skipped');
        continue;
      }
      const badge = await unreadCount(g.user_id);
      const msg = { title: 'The Feed', body: words(g.kind, g.names, g.n, g.snippet), url: g.url, tag: g.group_key, badge, icon: '/icons/feed-icon-192.png', app: 'feed' };
      const delivered = await pushTo(g.user_id, msg);
      await mark('sent');
      if (delivered > 0) sent++;
    }
    return sent;
  });
}

/** To every Feed-app device of this person. Returns how many accepted it. */
export async function pushTo(userId: number, msg: Record<string, unknown>): Promise<number> {
  const { rows } = await pool.query<{ id: number; endpoint: string; p256dh: string; auth: string }>('SELECT id, endpoint, p256dh, auth FROM feed_push_subscriptions WHERE user_id = $1', [userId]);
  if (!realPush()) {
    if (stubbed()) stubLog.push({ userId, devices: rows.length, ...msg });
    return stubbed() ? rows.length : 0;
  }
  let ok = 0;
  for (const s of rows) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 24 * 3600, urgency: 'normal' });
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await pool.query('DELETE FROM feed_push_subscriptions WHERE id = $1', [s.id]);
      else console.error('feed push failed', code ?? (e instanceof Error ? e.message : e));
    }
  }
  return ok;
}

/** Local/tests only: what would have been pushed (PUSH_STUB=1). */
export const stubLog: Array<Record<string, unknown>> = [];

registerJob({ name: 'feed-push', everyMs: 60 * 1000, run: async () => void (await deliverDue()) });

void config;
