-- Community: The Village (parents forum) and The Feed (in-app social network).
--
-- Grown-ups only (18+). Keyed by users (accounts), never by kid members; kid
-- and teen accounts can't reach any of this (enforced in routes/community.ts,
-- which reads these cross-household tables in system scope, like Circles).
-- Nothing here is shown in Circles, the Care team or any kid/shared surface.
--
-- What people write is encrypted at rest (AES-256-GCM, lib/seal.ts): post
-- bodies, thread titles, bios and photos. Display names stay plain (first
-- name only). key_id says which key sealed a row.
--
-- Status everywhere: visible | pending (held by the pre-screen: "under
-- review") | hidden (3 open reports) | removed. priority 2 = crisis (top of
-- the moderation queue), 1 = held by the screen, 0 = normal.

CREATE TABLE social_profiles (
  user_id                 integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name            text NOT NULL,
  bio_enc                 bytea,
  key_id                  text NOT NULL DEFAULT 's',
  avatar_id               integer,
  parent_badge            boolean NOT NULL DEFAULT false,
  adult_confirmed_at      timestamptz NOT NULL,
  guidelines_accepted_at  timestamptz NOT NULL,
  muted_until             timestamptz,
  banned_at               timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_images (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_enc    bytea NOT NULL,
  key_id      text NOT NULL,
  mime        text NOT NULL,
  status      text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'removed')),
  flags       text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE social_profiles ADD CONSTRAINT social_profiles_avatar_fk FOREIGN KEY (avatar_id) REFERENCES community_images(id) ON DELETE SET NULL;

/* ---------- The Village ---------- */

CREATE TABLE forum_threads (
  id                serial PRIMARY KEY,
  category          text NOT NULL CHECK (category IN ('wins', 'tough-days', 'school', 'routines', 'ask')),
  author_user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_enc         bytea NOT NULL,
  key_id            text NOT NULL,
  status            text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_threads_list_idx ON forum_threads (category, last_activity_at DESC);

CREATE TABLE forum_posts (
  id              serial PRIMARY KEY,
  thread_id       integer NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opening         boolean NOT NULL DEFAULT false,
  body_enc        bytea NOT NULL,
  key_id          text NOT NULL,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  helpful_count   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX forum_posts_thread_idx ON forum_posts (thread_id, id);
CREATE INDEX forum_posts_queue_idx ON forum_posts (status) WHERE status IN ('pending', 'hidden');

CREATE TABLE forum_reactions (
  post_id     integer NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('heart', 'been-there')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, kind)
);

CREATE TABLE forum_helpful (
  post_id     integer NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE forum_reports (
  id                serial PRIMARY KEY,
  post_id           integer NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  reporter_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_user_id)
);

/* ---------- The Feed ---------- */

CREATE TABLE social_posts (
  id              serial PRIMARY KEY,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_enc        bytea NOT NULL,
  key_id          text NOT NULL,
  image_id        integer REFERENCES community_images(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  like_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_posts_feed_idx ON social_posts (id DESC) WHERE status = 'visible';
CREATE INDEX social_posts_author_idx ON social_posts (author_user_id, id DESC);

CREATE TABLE social_follows (
  follower_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, followed_user_id),
  CHECK (follower_user_id <> followed_user_id)
);
CREATE INDEX social_follows_followed_idx ON social_follows (followed_user_id);

CREATE TABLE social_likes (
  post_id     integer NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE social_reports (
  id                serial PRIMARY KEY,
  post_id           integer REFERENCES social_posts(id) ON DELETE CASCADE,
  profile_user_id   integer REFERENCES users(id) ON DELETE CASCADE,
  reporter_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((post_id IS NULL) <> (profile_user_id IS NULL))
);
CREATE UNIQUE INDEX social_reports_post_once ON social_reports (post_id, reporter_user_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX social_reports_profile_once ON social_reports (profile_user_id, reporter_user_id) WHERE profile_user_id IS NOT NULL;

CREATE TABLE social_blocks (
  blocker_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

/* Strikes cover both the Village and the Feed: warn → 7-day mute → ban. */
CREATE TABLE social_strikes (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('warn', 'mute', 'ban')),
  reason      text NOT NULL,
  source      text NOT NULL,
  by_email    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_strikes_user_idx ON social_strikes (user_id);
