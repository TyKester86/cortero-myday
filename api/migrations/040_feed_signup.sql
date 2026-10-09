-- The Feed app's sign-up: age is checked before any account exists; then a username, a profile and a
-- first-run (interests, villages, people to follow) so nobody lands in an empty feed.

-- The date of birth checked at sign-up (the Feed is 18+). Private: profiles show age only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date date;
-- An email sign-in link requested from the Feed's sign-up carries that checked date of birth.
ALTER TABLE email_logins ADD COLUMN IF NOT EXISTS birth_date date;

-- @username: unique (any case), letters/numbers/underscore/dot.
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS username text CHECK (username ~ '^[a-z0-9_.]{3,20}$');
CREATE UNIQUE INDEX IF NOT EXISTS social_profiles_username_idx ON social_profiles (username) WHERE username IS NOT NULL;
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS onboarded_at timestamptz;

-- Villages you've joined (their activity comes to you; "find your people").
CREATE TABLE IF NOT EXISTS village_members (
  village_id  integer NOT NULL REFERENCES villages(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (village_id, user_id)
);
CREATE INDEX IF NOT EXISTS village_members_user_idx ON village_members (user_id);

-- More villages, so the interests picked at sign-up each have a place to land.
INSERT INTO villages (slug, name, description, sort) VALUES
  ('work-career', 'Work & Career', 'Deadlines, meetings, job hunts and bosses — with an ADHD brain.', 4),
  ('routines', 'Routines & Habits', 'Systems that stick (and the ones that didn’t). Small wins count.', 5),
  ('creatives', 'Creatives', 'Artists, makers, writers, musicians — hyperfocus welcome.', 6),
  ('students', 'Students', 'College, grad school, going back to school: studying with ADHD.', 7),
  ('move', 'Move', 'Walks, lifting, sports, getting outside — movement that helps.', 8),
  ('money-matters', 'Money Matters', 'Bills, budgets, impulse buys and getting back on track — no judgment.', 9)
ON CONFLICT (slug) DO NOTHING;
