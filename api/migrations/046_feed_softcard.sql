-- The Feed's Soft Card rebuild: friends (on the follow graph), comments, reactions, polls, feelings, places,
-- per-post audience, cover photos, profile details and a pinned item.

-- Profiles: a cover photo (same photo moderation as avatars), work, who sees your posts by default, a pinned item.
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS cover_id integer REFERENCES community_images(id) ON DELETE SET NULL;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS work text;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS default_audience text NOT NULL DEFAULT 'public' CHECK (default_audience IN ('public', 'friends'));
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS pinned_kind text CHECK (pinned_kind IN ('post', 'clip'));
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS pinned_id integer;

-- Posts: who sees it, who may comment, a feeling and a city-level place.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'friends'));
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS comments_from text NOT NULL DEFAULT 'anyone' CHECK (comments_from IN ('anyone', 'friends', 'nobody'));
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS feeling text;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS place text;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS comment_count integer NOT NULL DEFAULT 0;

-- Reactions: a like is one of four (long-press the heart for the others).
ALTER TABLE social_likes ADD COLUMN IF NOT EXISTS reaction text NOT NULL DEFAULT 'like' CHECK (reaction IN ('like', 'relate', 'helpful', 'funny'));

-- Comments on posts (screened like everything else; sealed at rest), with their own likes.
CREATE TABLE IF NOT EXISTS social_post_comments (
  id              serial PRIMARY KEY,
  post_id         integer NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id       integer REFERENCES social_post_comments(id) ON DELETE CASCADE,
  body_enc        bytea NOT NULL,
  key_id          text NOT NULL,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  like_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS social_post_comments_post_idx ON social_post_comments (post_id, id);
CREATE TABLE IF NOT EXISTS social_post_comment_likes (
  comment_id  integer NOT NULL REFERENCES social_post_comments(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);
CREATE TABLE IF NOT EXISTS social_post_comment_reports (
  comment_id        integer NOT NULL REFERENCES social_post_comments(id) ON DELETE CASCADE,
  reporter_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, reporter_user_id)
);

-- Polls: 2–4 options, one vote per person (can change it).
CREATE TABLE IF NOT EXISTS social_polls (
  post_id  integer PRIMARY KEY REFERENCES social_posts(id) ON DELETE CASCADE,
  options  text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 4)
);
CREATE TABLE IF NOT EXISTS social_poll_votes (
  post_id     integer NOT NULL REFERENCES social_polls(post_id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_idx  smallint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- Friends are mutual follows. A follow that isn't returned is a friend request; "Delete" hides it.
CREATE TABLE IF NOT EXISTS friend_request_dismissals (
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, from_user_id)
);

ALTER TABLE feed_notifications DROP CONSTRAINT IF EXISTS feed_notifications_kind_check;
ALTER TABLE feed_notifications ADD CONSTRAINT feed_notifications_kind_check
  CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'request', 'village', 'milestone', 'invite', 'joined', 'tip', 'supporter', 'friend_request', 'friend_accept'));

-- Friends helpers (mutual follows), used across the Feed's queries.
CREATE OR REPLACE FUNCTION feed_friends(a integer, b integer) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM social_follows WHERE follower_user_id = a AND followed_user_id = b)
     AND EXISTS (SELECT 1 FROM social_follows WHERE follower_user_id = b AND followed_user_id = a)
$$;
CREATE OR REPLACE FUNCTION feed_friend_count(a integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int FROM social_follows f
   WHERE f.follower_user_id = a AND EXISTS (SELECT 1 FROM social_follows g WHERE g.follower_user_id = f.followed_user_id AND g.followed_user_id = a)
$$;
CREATE OR REPLACE FUNCTION feed_mutual_friends(a integer, b integer) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int FROM social_follows f
   WHERE f.follower_user_id = a AND f.followed_user_id <> b
     AND EXISTS (SELECT 1 FROM social_follows g WHERE g.follower_user_id = f.followed_user_id AND g.followed_user_id = a)
     AND feed_friends(b, f.followed_user_id)
$$;
