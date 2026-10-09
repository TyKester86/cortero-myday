/**
 * "What you missed": for people who haven't opened the Feed in two days, one gentle digest — replies to them,
 * friends' activity, and their villages ("Creatives misses you: 3 new conversations") — by push and by email.
 * At most one every three days, only when there's something real to say, never in quiet hours, and both
 * channels can be turned off (the email has a one-tap unsubscribe).
 */
import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { asSystem, pool } from '../db.js';
import { pushTo } from './feednotify.js';
import { mailOn, sendMail } from './mail.js';
import { inQuietHours, localTime } from './push.js';
import { registerJob } from './schedulers.js';

const AWAY_HOURS = 48;
const EVERY_HOURS = 72;

/** The Feed's own address (the Feed app's domain when there is one). */
const feedOrigin = (): string => config.feedAppUrl || config.publicUrl;

export const unsubscribeSig = (userId: number): string => createHmac('sha256', config.sessionSecret).update(`feed-digest-unsub:${userId}`).digest('base64url').slice(0, 24);

export interface DigestSent {
  userId: number;
  body: string;
  pushed: number;
  emailed: boolean;
}

/** One pass: everyone who's due gets their digest. `at` = run "as if" at that time (tests). */
export async function runFeedDigests(at?: Date): Promise<DigestSent[]> {
  return asSystem(async () => {
    const now = at ?? (await pool.query<{ n: Date }>('SELECT now() AS n')).rows[0]?.n ?? new Date();
    const { rows: due } = await pool.query<{ user_id: number; email: string; name: string; since: Date; quiet_start: string | null; quiet_end: string | null; push_on: boolean | null; email_on: boolean | null }>(
      `SELECT p.user_id, u.email, p.display_name AS name,
              GREATEST(COALESCE(p.last_feed_at, p.created_at), COALESCE((SELECT max(d.sent_at) FROM feed_digests d WHERE d.user_id = p.user_id), 'epoch')) AS since,
              np.quiet_start, np.quiet_end, np.digests AS push_on, np.digest_email AS email_on
         FROM social_profiles p JOIN users u ON u.id = p.user_id
         LEFT JOIN feed_notification_prefs np ON np.user_id = p.user_id
        WHERE p.banned_at IS NULL
          AND COALESCE(p.last_feed_at, p.created_at) < $1::timestamptz - make_interval(hours => $2::int)
          AND NOT EXISTS (SELECT 1 FROM feed_digests d WHERE d.user_id = p.user_id AND d.sent_at > $1::timestamptz - make_interval(hours => $3::int))
          AND (np.digests IS NULL OR np.digests OR np.digest_email)`,
      [now, AWAY_HOURS, EVERY_HOURS],
    );
    const hhmm = localTime(now);
    const sent: DigestSent[] = [];
    for (const u of due) {
      if (inQuietHours(hhmm, u.quiet_start ?? '22:00', u.quiet_end ?? '08:00')) continue;
      const { rows: k } = await pool.query<{ to_you: number; who: string | null; followers: number; friend_posts: number; friend: string | null; village: string | null; village_new: number }>(
        `SELECT (SELECT COUNT(*)::int FROM feed_notifications n WHERE n.user_id = $1 AND n.kind IN ('reply', 'mention', 'comment', 'dm') AND n.created_at > $2 AND n.read_at IS NULL) AS to_you,
                (SELECT a.display_name FROM feed_notifications n JOIN social_profiles a ON a.user_id = n.actor_user_id
                  WHERE n.user_id = $1 AND n.kind IN ('reply', 'mention', 'comment', 'dm') AND n.created_at > $2 ORDER BY n.created_at DESC LIMIT 1) AS who,
                (SELECT COUNT(*)::int FROM social_follows f WHERE f.followed_user_id = $1 AND f.created_at > $2) AS followers,
                (SELECT COUNT(*)::int FROM social_posts s WHERE s.status = 'visible' AND s.created_at > $2
                   AND EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = s.author_user_id)) AS friend_posts,
                (SELECT a.display_name FROM social_posts s JOIN social_profiles a ON a.user_id = s.author_user_id WHERE s.status = 'visible' AND s.created_at > $2
                   AND EXISTS (SELECT 1 FROM social_follows f WHERE f.follower_user_id = $1 AND f.followed_user_id = s.author_user_id) ORDER BY s.like_count DESC LIMIT 1) AS friend,
                (SELECT v.name FROM forum_threads t JOIN village_members vm ON vm.village_id = t.village_id AND vm.user_id = $1 JOIN villages v ON v.id = t.village_id
                  WHERE t.status = 'visible' AND t.created_at > $2 AND t.author_user_id <> $1 GROUP BY v.name ORDER BY COUNT(*) DESC LIMIT 1) AS village,
                (SELECT COUNT(*)::int FROM forum_threads t JOIN village_members vm ON vm.village_id = t.village_id AND vm.user_id = $1
                  WHERE t.status = 'visible' AND t.created_at > $2 AND t.author_user_id <> $1) AS village_new`,
        [u.user_id, u.since],
      );
      const c = k[0];
      if (!c) continue;
      const bits: string[] = [];
      if (c.to_you) bits.push(c.who && c.to_you === 1 ? `${c.who} replied to you` : `${c.to_you} replies and messages for you${c.who ? ` (${c.who} and more)` : ''}`);
      if (c.friend_posts) bits.push(`${c.friend_posts} new post${c.friend_posts === 1 ? '' : 's'} from people you follow${c.friend ? `, like ${c.friend}’s` : ''}`);
      if (c.village && c.village_new) bits.push(`${c.village} misses you: ${c.village_new} new conversation${c.village_new === 1 ? '' : 's'}`);
      if (c.followers) bits.push(`${c.followers} new follower${c.followers === 1 ? '' : 's'}`);
      if (!bits.length) continue; // nothing real to say → no digest
      const body = bits.join(' · ');
      const pushed = u.push_on === false ? 0 : await pushTo(u.user_id, { title: 'What you missed on The Feed', body, url: '/feed', tag: 'feed-digest', icon: '/icons/feed-icon-192.png', app: 'feed' });
      let emailed = false;
      const realEmail = !!u.email && !u.email.endsWith('@invalid') && u.email.includes('@');
      if (u.email_on !== false && realEmail && mailOn()) {
        const unsub = `${feedOrigin()}/api/feed/unsubscribe?u=${u.user_id}&t=${unsubscribeSig(u.user_id)}`;
        emailed = await sendMail({
          to: u.email,
          subject: 'What you missed on The Feed',
          text: `Hi ${u.name},\n\nWhile you were away:\n\n${bits.map((b) => `• ${b}`).join('\n')}\n\nCatch up: ${feedOrigin()}/feed\n\n—\nThe Feed · a calm community for ADHD adults\nDon’t want these emails? ${unsub}`,
        }).catch(() => false);
      }
      await pool.query('INSERT INTO feed_digests (user_id, sent_at, pushed, emailed, summary) VALUES ($1, $2, $3, $4, $5)', [u.user_id, now, pushed, emailed, body]);
      sent.push({ userId: u.user_id, body, pushed, emailed });
    }
    return sent;
  });
}

registerJob({ name: 'feed-digests', everyMs: 30 * 60 * 1000, run: async () => void (await runFeedDigests()) });
