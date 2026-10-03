-- Sign-in without Google: a one-time email link (15 minutes) or Sign in with
-- Apple. users.google_sub holds the identity key for every provider
-- ("google sub", "email:<address>", "apple:<sub>") — unique per person.
CREATE TABLE IF NOT EXISTS email_logins (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  invite      text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_logins_email_idx ON email_logins (email, created_at);

-- Trial reminder email sent (once).
ALTER TABLE households ADD COLUMN IF NOT EXISTS trial_notice_at timestamptz;
