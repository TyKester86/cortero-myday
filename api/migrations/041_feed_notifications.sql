-- The Feed's notifications: an inbox (grouped), badge counts, and push to the Feed app — likes, comments,
-- replies, follows, mentions, messages, village activity and milestones. Keyed by account (Feed people may have
-- no household), so separate from MyDay's household push.

CREATE TABLE IF NOT EXISTS feed_push_subscriptions (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_push_subscriptions_user_idx ON feed_push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS feed_notifications (
  id             bigserial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'village', 'milestone')),
  actor_user_id  integer REFERENCES users(id) ON DELETE CASCADE,
  -- Notifications about the same thing group together ("Ana and 3 others liked your post").
  group_key      text NOT NULL,
  url            text NOT NULL,
  snippet        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  read_at        timestamptz,
  -- Push: waiting (pending, not before push_after), sent, or skipped (off in settings, already pinged, daily cap).
  push_state     text NOT NULL DEFAULT 'pending' CHECK (push_state IN ('pending', 'sent', 'skipped')),
  push_after     timestamptz NOT NULL DEFAULT now(),
  pushed_at      timestamptz
);
CREATE INDEX IF NOT EXISTS feed_notifications_user_idx ON feed_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_notifications_due_idx ON feed_notifications (push_after) WHERE push_state = 'pending';
-- A milestone happens once per person.
CREATE UNIQUE INDEX IF NOT EXISTS feed_notifications_milestone_idx ON feed_notifications (user_id, group_key) WHERE kind = 'milestone';

CREATE TABLE IF NOT EXISTS feed_notification_prefs (
  user_id      integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  push         boolean NOT NULL DEFAULT true,
  likes        boolean NOT NULL DEFAULT true,
  comments     boolean NOT NULL DEFAULT true,
  replies      boolean NOT NULL DEFAULT true,
  follows      boolean NOT NULL DEFAULT true,
  mentions     boolean NOT NULL DEFAULT true,
  dms          boolean NOT NULL DEFAULT true,
  villages     boolean NOT NULL DEFAULT true,
  milestones   boolean NOT NULL DEFAULT true,
  quiet_start  text NOT NULL DEFAULT '22:00' CHECK (quiet_start ~ '^\d{2}:\d{2}$'),
  quiet_end    text NOT NULL DEFAULT '08:00' CHECK (quiet_end ~ '^\d{2}:\d{2}$'),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
