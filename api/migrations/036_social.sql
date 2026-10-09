-- The Feed as the umbrella for all social (Oct 2026): Stories, Clips, Messages, Circles and Villages
-- under one Feed home; in-depth Profiles; verified Provider pages. Same hard rules as 021_community:
-- grown-ups (18+) only, keyed by account (users.id) — never kid members; everything people write or
-- upload is sealed at rest (lib/seal.ts) and goes through the pre-screen; held items are "under
-- review"; crisis items go to the top of the moderation queue and the writer sees 988.
-- The Feed is free: none of this checks a subscription.

-- About you (the health section and profile editing): date of birth and height, per person.
ALTER TABLE household_members ADD COLUMN dob date, ADD COLUMN height_in numeric;
-- Feed profiles: the same for people who joined just for the Feed (no household). The feed shows AGE
-- only (from the date of birth), never the date itself.
ALTER TABLE social_profiles ADD COLUMN dob date, ADD COLUMN height_in numeric, ADD COLUMN location text;

/* ---------- Stories: 24 hours, then gone ---------- */
CREATE TABLE social_stories (
  id              serial PRIMARY KEY,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id        integer REFERENCES community_images(id) ON DELETE CASCADE,
  text_enc        bytea,
  key_id          text NOT NULL,
  bg              text NOT NULL DEFAULT 'amber',
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  CHECK (image_id IS NOT NULL OR text_enc IS NOT NULL)
);
CREATE INDEX social_stories_live_idx ON social_stories (author_user_id, expires_at);
CREATE TABLE social_story_views (
  story_id        integer NOT NULL REFERENCES social_stories(id) ON DELETE CASCADE,
  viewer_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_user_id)
);

/* ---------- Clips: short vertical videos ---------- */
CREATE TABLE community_videos (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data_enc    bytea NOT NULL,
  key_id      text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE social_clips (
  id              serial PRIMARY KEY,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id        integer NOT NULL REFERENCES community_videos(id) ON DELETE CASCADE,
  poster_id       integer REFERENCES community_images(id) ON DELETE SET NULL,
  caption_enc     bytea,
  key_id          text NOT NULL,
  hashtags        text[] NOT NULL DEFAULT '{}',
  duration_s      numeric,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  like_count      integer NOT NULL DEFAULT 0,
  comment_count   integer NOT NULL DEFAULT 0,
  view_count      integer NOT NULL DEFAULT 0,
  share_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_clips_feed_idx ON social_clips (id DESC) WHERE status = 'visible';
CREATE INDEX social_clips_author_idx ON social_clips (author_user_id, id DESC);
CREATE TABLE social_clip_likes (
  clip_id     integer NOT NULL REFERENCES social_clips(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, user_id)
);
CREATE TABLE social_clip_views (
  clip_id     integer NOT NULL REFERENCES social_clips(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, user_id)
);
CREATE TABLE social_clip_comments (
  id              serial PRIMARY KEY,
  clip_id         integer NOT NULL REFERENCES social_clips(id) ON DELETE CASCADE,
  author_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_enc        bytea NOT NULL,
  key_id          text NOT NULL,
  status          text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority        smallint NOT NULL DEFAULT 0,
  flags           text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX social_clip_comments_idx ON social_clip_comments (clip_id, id);
CREATE TABLE social_clip_reports (
  id                serial PRIMARY KEY,
  clip_id           integer NOT NULL REFERENCES social_clips(id) ON DELETE CASCADE,
  reporter_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clip_id, reporter_user_id)
);

/* ---------- Messages: 1:1 between grown-ups ---------- */
CREATE TABLE dm_threads (
  id          serial PRIMARY KEY,
  user_a      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),
  UNIQUE (user_a, user_b)
);
CREATE TABLE dm_messages (
  id               serial PRIMARY KEY,
  thread_id        integer NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  sender_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body_enc         bytea NOT NULL,
  key_id           text NOT NULL,
  status           text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  priority         smallint NOT NULL DEFAULT 0,
  flags            text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dm_messages_thread_idx ON dm_messages (thread_id, id);
CREATE TABLE dm_thread_state (
  thread_id     integer NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted         boolean NOT NULL DEFAULT false,
  last_read_id  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE dm_reports (
  id                serial PRIMARY KEY,
  message_id        integer NOT NULL REFERENCES dm_messages(id) ON DELETE CASCADE,
  reporter_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_user_id)
);

/* ---------- Villages: topic forums (the Village, now several) ---------- */
CREATE TABLE villages (
  id           serial PRIMARY KEY,
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  sort         integer NOT NULL DEFAULT 0
);
INSERT INTO villages (slug, name, description, sort) VALUES
  ('adhd-parents', 'ADHD Parents', 'Moms and dads with ADHD, raising kids with ADHD.', 1),
  ('late-diagnosis', 'Late Diagnosis', 'Found out as an adult? You’re in good company.', 2),
  ('partners', 'Partners', 'For partners of someone with ADHD — and couples figuring it out together.', 3);
ALTER TABLE forum_threads ADD COLUMN village_id integer NOT NULL DEFAULT 1 REFERENCES villages(id);
CREATE INDEX forum_threads_village_idx ON forum_threads (village_id, last_activity_at DESC);

/* ---------- Providers: licensed, verified by MyDay before a provider page exists ---------- */
CREATE TABLE provider_credentials (
  user_id          integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_type     text NOT NULL,
  license_state    text NOT NULL,
  license_number   text NOT NULL,
  specialties      text[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'verified', 'rejected')),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  verified_at      timestamptz,
  verified_by      integer REFERENCES users(id) ON DELETE SET NULL,
  reject_reason    text
);
CREATE INDEX provider_credentials_queue_idx ON provider_credentials (status) WHERE status = 'submitted';
