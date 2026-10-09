-- One person, one account across MyDay and the Feed. A sign-in method (Google, email link, Apple) whose
-- verified email matches an existing account becomes another way into THAT account (no duplicate person).
CREATE TABLE IF NOT EXISTS user_identities (
  sub         text PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

-- Where a person first signed up: the Feed app (free) or MyDay. The free → paid funnel counts real people.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_app text NOT NULL DEFAULT 'myday' CHECK (signup_app IN ('myday', 'feed'));
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
