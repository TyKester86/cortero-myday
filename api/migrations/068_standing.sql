-- Hana v2, Q10: C3 Tier 3 — standing authority, LAST, and earned.
--
-- standing_grants: a parent grants ONE narrow, named class ("lock up at night", "add groceries
--   I mention to the list") — each separately granted, separately revocable. A class can only be
--   granted once THIS household's own T1/T2 record for it is proven boring (enough approved-as-
--   drafted uses, no recent failures, few discards) — exposure is earned, per class, per family.
--   Money movement is never a class (Universal Capability amendment); nor is anything that sends
--   outside the family.
-- Every exercise is a hana_actions row with origin 'standing' (the parents' log, forever) and
--   counts in the monthly report.

CREATE TABLE standing_grants (
  id          serial PRIMARY KEY,
  class       text NOT NULL,
  granted_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  revoked_at  timestamptz
);
SELECT myday_tenant('standing_grants');
CREATE UNIQUE INDEX standing_grants_active_idx ON standing_grants (household_id, class) WHERE revoked_at IS NULL;

ALTER TABLE hana_actions DROP CONSTRAINT IF EXISTS hana_actions_origin_check;
ALTER TABLE hana_actions ADD CONSTRAINT hana_actions_origin_check CHECK (origin IN ('chat', 'watch', 'coach', 'voice', 'standing'));
