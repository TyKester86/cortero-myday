-- C9, memory that compounds: Hana's memory grows from "things one person told her" into a
-- household memory the parents can see whole, correct, and forget from — sizes, preferences,
-- teachers and contacts, school facts, medical basics the family entered, what worked last time.
--
-- One table, two scopes:
--   shared = false  a person's own memory (as before): theirs alone; a kid's is also open to the
--                   parents. Another grown-up's never is.
--   shared = true   the household memory: written by a parent (directly or by confirming Hana),
--                   about one member or the whole family (about_member_id NULL). Parents see all of
--                   it; a kid sees only what is about them — siblings don't inherit each other's.
-- It lives and dies with the household (household_id cascades) and with the member it is about.

ALTER TABLE hana_memories
  ADD COLUMN kind text NOT NULL DEFAULT 'note'
    CHECK (kind IN ('note', 'size', 'preference', 'contact', 'school', 'medical', 'worked')),
  ADD COLUMN shared boolean NOT NULL DEFAULT false,
  ADD COLUMN about_member_id integer REFERENCES household_members(id) ON DELETE CASCADE,
  ADD COLUMN via text NOT NULL DEFAULT 'typed' CHECK (via IN ('typed', 'hana')),
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN updated_by integer REFERENCES household_members(id) ON DELETE SET NULL;

CREATE INDEX hana_memories_shared_idx ON hana_memories (about_member_id) WHERE shared;
