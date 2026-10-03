-- Hana as a personal assistant (step 1): things she remembers about you, and
-- "remind me at 5 to call Mom" reminders (a push at that time). Both are
-- yours alone (by member) and household-scoped like everything else; both
-- show in the Ask Hana page where you can delete them.

CREATE TABLE hana_memories (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  fact        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_memories');
CREATE INDEX hana_memories_member_idx ON hana_memories (member_id, id);

CREATE TABLE hana_reminders (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  text        text NOT NULL,
  remind_at   timestamptz NOT NULL,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_reminders');
CREATE INDEX hana_reminders_due_idx ON hana_reminders (remind_at) WHERE sent_at IS NULL;
