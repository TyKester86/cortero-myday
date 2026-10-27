-- Hana in MyDay, H5: the household logistics watch.
--
-- hana_settings: one row per household, set by either parent (both are admins).
--   quiet_days are the nights quiet hours apply (ISO weekday of the evening; school
--   nights by default: Sun–Thu). Only a same-day logistics failure (a pickup today with
--   nobody on it) may break quiet hours or a pause.
-- hana_items.pushed_at: when a watch item went out by push (once).
CREATE TABLE hana_settings (
  household_id    integer PRIMARY KEY DEFAULT NULLIF(current_setting('app.household_id', true), '')::int
                    REFERENCES households(id) ON DELETE CASCADE,
  quiet_start     text NOT NULL DEFAULT '21:00' CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end       text NOT NULL DEFAULT '07:00' CHECK (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_days      smallint[] NOT NULL DEFAULT ARRAY[7, 1, 2, 3, 4]::smallint[],
  paused_until    timestamptz,
  muted           text[] NOT NULL DEFAULT '{}',
  low_balance     numeric NOT NULL DEFAULT 200 CHECK (low_balance >= 0),
  bill_lead_days  integer NOT NULL DEFAULT 3 CHECK (bill_lead_days BETWEEN 0 AND 7),
  updated_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_settings');

ALTER TABLE hana_items ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
