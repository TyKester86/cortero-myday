-- Hana v2, Q8: C7 health logistics — organization only (H8's rail unchanged: she never interprets,
-- diagnoses or advises; "here's what your records show; a clinician is the right call").
--
-- medications: what the family entered — name, dose and schedule exactly as written, and (when
--   they give it) the supply on hand, how many a day, and refills left. With that, a prescription
--   running low is a loop days early, not a surprise. Without it she says she can't watch it.
-- med_refills: each refill a parent logs — the evidence that closes the refill loop.
-- care_schedule: recurring care (the dentist every 6 months, a yearly physical) — when one comes
--   due and nothing is booked on the calendar, booking it is a loop; a booked visit closes it.
-- visit_questions: the questions the family lists for a visit, for the prep pack the night before.
--   A visit is a calendar appointment, keyed by "<event id>:<date>" (repeats get their own).

CREATE TABLE medications (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name          text NOT NULL,
  dose          text NOT NULL DEFAULT '',
  schedule      text NOT NULL DEFAULT '',
  per_day       numeric(6, 2) CHECK (per_day IS NULL OR per_day > 0),
  supply        numeric(8, 2) CHECK (supply IS NULL OR supply >= 0),
  supply_on     date,
  refills_left  integer CHECK (refills_left IS NULL OR refills_left >= 0),
  pharmacy      text NOT NULL DEFAULT '',
  prescriber    text NOT NULL DEFAULT '',
  active        boolean NOT NULL DEFAULT true,
  created_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('medications');

CREATE TABLE med_refills (
  id          serial PRIMARY KEY,
  med_id      integer NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  on_date     date NOT NULL,
  amount      numeric(8, 2) NOT NULL CHECK (amount > 0),
  logged_by   integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('med_refills');

CREATE TABLE care_schedule (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  what          text NOT NULL,
  every_months  integer NOT NULL CHECK (every_months BETWEEN 1 AND 60),
  last_on       date,
  created_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('care_schedule');

CREATE TABLE visit_questions (
  id          serial PRIMARY KEY,
  visit_key   text NOT NULL,
  on_date     date NOT NULL,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  question    text NOT NULL,
  added_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('visit_questions');
CREATE INDEX visit_questions_key_idx ON visit_questions (visit_key, member_id);

ALTER TABLE open_loops DROP CONSTRAINT IF EXISTS open_loops_source_check;
ALTER TABLE open_loops ADD CONSTRAINT open_loops_source_check CHECK (source IN ('chat', 'manual', 'calendar', 'email', 'document', 'money', 'health'));
