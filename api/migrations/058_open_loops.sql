-- Hana v2, Q3: C4 open loops, and C1 triage for the mail that reaches her (forwarded mail today;
-- connected Gmail / Outlook when those are set up).
--
-- open_loops: every commitment — ours or theirs ("the school will send the form"; "I'll bring the
--   check Thursday") — with what, who owes it, by when, and where it came from. It closes only on
--   evidence (closed_evidence says which: a parent marked it, a reply arrived, the homework was
--   done) and never on its own; past its date it stays open and ages, visibly.
--   owed_by_member: someone in the household; owed_by_name: anyone else ("the school").
--   private: opened from one grown-up's own chat — theirs alone until they share it.
-- inbox_emails.class / summary_enc: Hana's triage of a message (school, medical, money,
--   logistics, people, noise) and a one-line summary, sealed like the mail itself.
CREATE TABLE open_loops (
  id               serial PRIMARY KEY,
  what             text NOT NULL,
  owed_by_member   integer REFERENCES household_members(id) ON DELETE SET NULL,
  owed_by_name     text,
  -- Ours to do (someone in the family, or the family as a whole) vs. theirs (the school, the doctor).
  ours             boolean NOT NULL DEFAULT true,
  about_member     integer REFERENCES household_members(id) ON DELETE SET NULL,
  due              date,
  source           text NOT NULL CHECK (source IN ('chat', 'manual', 'calendar', 'email')),
  source_ref       text,
  opened_by        integer REFERENCES household_members(id) ON DELETE SET NULL,
  private          boolean NOT NULL DEFAULT false,
  closed_at        timestamptz,
  closed_by        integer REFERENCES household_members(id) ON DELETE SET NULL,
  closed_evidence  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (owed_by_member IS NOT NULL OR owed_by_name IS NOT NULL)
);
SELECT myday_tenant('open_loops');
CREATE INDEX open_loops_open_idx ON open_loops (household_id, due) WHERE closed_at IS NULL;
-- One loop per detected source item (a calendar event's day, an email's commitment).
CREATE UNIQUE INDEX open_loops_source_idx ON open_loops (household_id, source, source_ref) WHERE source_ref IS NOT NULL;

ALTER TABLE inbox_emails
  ADD COLUMN IF NOT EXISTS class text CHECK (class IN ('school', 'medical', 'money', 'logistics', 'people', 'noise')),
  ADD COLUMN IF NOT EXISTS summary_enc bytea;
