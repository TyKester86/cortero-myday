-- The Feed: bringing people back and bringing people in — "what you missed" digests (push + email) for people
-- who've been away, people you may know (mutual follows, contacts you choose to share), village invites, and a
-- personal invite link with a rich preview.

-- Who invited this person (their invite link).
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by integer REFERENCES users(id) ON DELETE SET NULL;

-- Digests can be turned off (push and email separately); the email has a one-tap unsubscribe.
ALTER TABLE feed_notification_prefs ADD COLUMN IF NOT EXISTS digests boolean NOT NULL DEFAULT true;
ALTER TABLE feed_notification_prefs ADD COLUMN IF NOT EXISTS digest_email boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS feed_digests (
  id          bigserial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  pushed      integer NOT NULL DEFAULT 0,
  emailed     boolean NOT NULL DEFAULT false,
  summary     text NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_digests_user_idx ON feed_digests (user_id, sent_at DESC);

-- "Let people who have my email find me" (contacts matching). On by default; one switch in settings.
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS findable_by_email boolean NOT NULL DEFAULT true;

-- One-tap village invites.
CREATE TABLE IF NOT EXISTS village_invites (
  village_id  integer NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  from_user   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (village_id, from_user, to_user)
);

-- Two more kinds of notification: a village invite, and "your friend joined from your invite".
ALTER TABLE feed_notifications DROP CONSTRAINT IF EXISTS feed_notifications_kind_check;
ALTER TABLE feed_notifications ADD CONSTRAINT feed_notifications_kind_check
  CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'request', 'village', 'milestone', 'invite', 'joined'));

-- An email sign-in link requested from someone's invite carries who invited them.
ALTER TABLE email_logins ADD COLUMN IF NOT EXISTS ref text;
