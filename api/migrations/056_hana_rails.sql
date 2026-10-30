-- Hana in MyDay, Q1 (v1 completion): H6 actions behind rails, in-app delivery, the audit trail.
--
-- Every Hana write is now a proposal (hana_actions, status 'pending') until a grown-up
-- confirms it; decided_by / decided_at / edited record who approved or discarded it, when,
-- and whether they changed it first — the parents' audit log reads from here.
-- hana_notes: a draft note a parent approved, delivered in the app (never by email or text).
-- hana_settings.kid_note_kinds: what a note to a child may be (parent-set; encouragement and
--   reminders by default — nothing else ever reaches a child).
ALTER TABLE hana_actions
  ADD COLUMN IF NOT EXISTS decided_by integer REFERENCES household_members(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'chat' CHECK (origin IN ('chat', 'watch', 'coach', 'voice'));

CREATE TABLE hana_notes (
  id          serial PRIMARY KEY,
  action_id   integer REFERENCES hana_actions(id) ON DELETE SET NULL,
  from_member integer REFERENCES household_members(id) ON DELETE SET NULL,
  to_member   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('note', 'encouragement', 'reminder')),
  body        text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
SELECT myday_tenant('hana_notes');
CREATE INDEX hana_notes_to_idx ON hana_notes (household_id, to_member, sent_at DESC);

ALTER TABLE hana_settings
  ADD COLUMN IF NOT EXISTS kid_note_kinds text[] NOT NULL DEFAULT ARRAY['encouragement', 'reminder']::text[],
  -- H9: the month whose report was last emailed to the parents (once a month, never twice).
  ADD COLUMN IF NOT EXISTS report_sent_month text;

-- Things Hana couldn't do (the month's gaps), and taste-bearing suggestions, live in hana_items.
ALTER TABLE hana_items DROP CONSTRAINT IF EXISTS hana_items_surface_check;
ALTER TABLE hana_items ADD CONSTRAINT hana_items_surface_check
  CHECK (surface IN ('brief_morning', 'brief_evening', 'brief_weekly', 'nudge', 'watch', 'escalation', 'crisis', 'couldnt', 'taste'));
