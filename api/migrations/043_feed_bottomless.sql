-- The Feed: bottomless scrolling, memories, participation streaks (with a rest day), personal stats, and a
-- "while you were away" catch-up for people coming back.

-- A daily check-in ("how's today?") keeps a streak going on days without a post.
CREATE TABLE IF NOT EXISTS feed_checkins (
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day         date NOT NULL,
  mood        text NOT NULL CHECK (mood IN ('great', 'good', 'okay', 'rough', 'hard')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- When this person last opened the Feed, and the visit before (the catch-up covers the gap).
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS last_feed_at timestamptz;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS prev_feed_at timestamptz;
-- Memories / catch-up dismissed today (shown once a day at most).
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS memories_seen_on date;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS catchup_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS social_posts_author_created_idx ON social_posts (author_user_id, created_at);
CREATE INDEX IF NOT EXISTS forum_threads_activity_idx ON forum_threads (last_activity_at DESC);
