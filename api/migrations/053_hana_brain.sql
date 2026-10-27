-- Hana in MyDay (chief of staff), H1 brain + H2 read-only toolbelt.
--
-- calendar_events.pickup / pickup_by: an event that needs someone to drive, pick up
--   or hand off, and who's on it (parents set it). NULL pickup_by on a pickup = unowned.
-- homework.source / captured_due / source_ref: where a homework item came from and
--   the due date the source said when it was captured, so Hana can show provenance
--   and flag a source that changed afterwards instead of stating a stale date.
-- hana_items: everything Hana surfaces to a person (brief items, nudges, watch alerts,
--   escalations, crisis alerts) with its source, as-of time and outcome — her own log;
--   the family needle (H9) is measured from it.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS pickup boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pickup_by integer REFERENCES household_members(id) ON DELETE SET NULL;

ALTER TABLE homework
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'lecture', 'classroom', 'email')),
  ADD COLUMN IF NOT EXISTS captured_due date,
  ADD COLUMN IF NOT EXISTS source_ref integer;

-- Homework promoted from a lecture before this change: its source is that lecture.
UPDATE homework h SET source = 'lecture', source_ref = la.id, captured_due = h.due
  FROM lecture_assignments la WHERE la.homework_id = h.id AND h.source = 'manual';

CREATE TABLE hana_items (
  id                serial PRIMARY KEY,
  -- Who saw it (the viewer). Parents' and kids' items are separate rows.
  member_id         integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  surface           text NOT NULL CHECK (surface IN ('brief_morning', 'brief_evening', 'brief_weekly', 'nudge', 'watch', 'escalation', 'crisis')),
  category          text NOT NULL,
  -- Stable key for the thing itself (e.g. "pickup:12:2026-10-27"), so a re-shown item is the same row.
  item_key          text NOT NULL,
  -- Whose item it is (the kid the homework belongs to, the event's person), if anyone's.
  subject_member_id integer REFERENCES household_members(id) ON DELETE SET NULL,
  text              text NOT NULL,
  source            text NOT NULL,
  as_of             timestamptz,
  shown_on          date NOT NULL,
  outcome           text CHECK (outcome IN ('acted', 'dismissed', 'wrong')),
  outcome_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, surface, item_key, shown_on)
);
SELECT myday_tenant('hana_items');
CREATE INDEX hana_items_shown_idx ON hana_items (household_id, shown_on);
