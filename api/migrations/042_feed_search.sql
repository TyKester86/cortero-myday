-- The Feed: search (people, posts, villages), hashtags/topics, and message requests.

-- #hashtags written in a post, kept in the clear (the post itself stays sealed) so topics are searchable.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS hashtags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS social_posts_hashtags_idx ON social_posts USING gin (hashtags);

-- Messages from people you don't follow (and haven't answered) wait in Requests until you accept or decline.
ALTER TABLE dm_thread_state ADD COLUMN IF NOT EXISTS request text CHECK (request IN ('accepted', 'declined'));

-- "Ana sent you a message request" is its own kind of notification (quieter than a message).
ALTER TABLE feed_notifications DROP CONSTRAINT IF EXISTS feed_notifications_kind_check;
ALTER TABLE feed_notifications ADD CONSTRAINT feed_notifications_kind_check
  CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'request', 'village', 'milestone'));
