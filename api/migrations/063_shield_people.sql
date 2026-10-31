-- Hana v2, Q9 (first pair): JP6 the shield and JP5 people dossiers.
--
-- shield_alerts: scam and safety warnings, surfaced to parents in plain words — family-emergency
--   ("grandparent") scams, phishing, lures aimed at the kids, real account-security alerts, and
--   first-time large charges at the bank. She WARNS; nothing is ever blocked or deleted — the mail
--   stays in the inbox. A parent marks each one fine or a scam.
-- people / person_members: the household's people — teachers, doctors, coaches, kin, sitters —
--   for dossiers built from what the household already holds (mail, loops, the family memory,
--   the calendar). Parents only; never leaves the household.

CREATE TABLE shield_alerts (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('impersonation', 'phishing', 'kid_target', 'account_security', 'money')),
  ref           text NOT NULL,
  email_id      integer REFERENCES inbox_emails(id) ON DELETE CASCADE,
  about_member  integer REFERENCES household_members(id) ON DELETE SET NULL,
  text          text NOT NULL,
  signals       text[] NOT NULL DEFAULT '{}',
  verdict       text CHECK (verdict IN ('fine', 'scam')),
  decided_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('shield_alerts');
CREATE UNIQUE INDEX shield_alerts_ref_idx ON shield_alerts (household_id, ref);

CREATE TABLE people (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  role        text NOT NULL CHECK (role IN ('teacher', 'doctor', 'coach', 'kin', 'sitter', 'other')),
  email       text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  org         text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('people');

CREATE TABLE person_members (
  person_id  integer NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, member_id)
);
SELECT myday_tenant('person_members');
