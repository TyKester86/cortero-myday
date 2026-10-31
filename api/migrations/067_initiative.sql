-- Hana v2, Q9 JP7: initiative rights (and the log JP1's spoken heads-ups read from).
--
-- She may START a conversation (a push, a spoken heads-up) only for a named reason that person
-- has granted — a loop about to break, a conflict that just formed, a money problem, a storm, a
-- scam warning, the house at night — inside quiet hours. Two are always on and said so: safety
-- (the alarm going off, a family-emergency scam) and telling a kid what changed about them.
-- Everything else waits for the brief. Each grown-up sets their own; the parents set a kid's.
-- hana_items.reason records why each heads-up was allowed to interrupt (or why it waited).

CREATE TABLE hana_initiative (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  reasons     text[] NOT NULL,
  set_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_initiative');
CREATE UNIQUE INDEX hana_initiative_member_idx ON hana_initiative (member_id);

ALTER TABLE hana_items ADD COLUMN reason text;
