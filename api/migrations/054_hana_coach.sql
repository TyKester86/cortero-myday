-- Hana in MyDay, H4: the homework & routine coach. Hana's own records only; the
-- homework itself (and its done flag) is untouched.
--
-- hana_homework_steps: the progress signal for a homework plan — 0 not started,
--   1 started, 2 most of the way, 3 ready to hand in. Set by the kid (or a parent).
-- hana_dismissals: a nudge someone set aside. A dismissed nudge stays dismissed for
--   that assignment (no nagging loops).
CREATE TABLE hana_homework_steps (
  homework_id integer PRIMARY KEY REFERENCES homework(id) ON DELETE CASCADE,
  step        smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 3),
  updated_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_homework_steps');

CREATE TABLE hana_dismissals (
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  ref        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, kind, ref)
);
SELECT myday_tenant('hana_dismissals');
