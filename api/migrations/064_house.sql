-- Hana v2, Q9 JP3: the house itself, and storm mode.
--
-- home_connections: the family's own Home Assistant (its address + a long-lived access token,
--   sealed). One per household, connected by a parent. MyDay reads alarm, locks, thermostat,
--   lights, garage, doors and windows; it changes something only on a parent's approval of that
--   one command (T2) — and never unlocks, opens or disarms.
-- home_devices: the last read of each of those, with when it changed.
-- household_places: where the family is, opted into by a parent for weather (rounded to about
--   a kilometre; only those coordinates go to the National Weather Service).
-- weather_alerts: the active alerts there, for storm mode.

CREATE TABLE home_connections (
  id              serial PRIMARY KEY,
  provider        text NOT NULL DEFAULT 'home_assistant' CHECK (provider IN ('home_assistant')),
  base_url        text NOT NULL,
  token_enc       bytea NOT NULL,
  key_id          text NOT NULL,
  last_synced_at  timestamptz,
  last_error      text,
  created_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('home_connections');
CREATE UNIQUE INDEX home_connections_one_idx ON home_connections (household_id);

CREATE TABLE home_devices (
  id          serial PRIMARY KEY,
  entity_id   text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('alarm', 'lock', 'thermostat', 'light', 'garage', 'door', 'window')),
  name        text NOT NULL,
  state       text NOT NULL,
  attrs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('home_devices');
CREATE UNIQUE INDEX home_devices_entity_idx ON home_devices (household_id, entity_id);

CREATE TABLE household_places (
  id          serial PRIMARY KEY,
  label       text NOT NULL DEFAULT 'Home',
  lat         numeric(5, 2) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon         numeric(6, 2) NOT NULL CHECK (lon BETWEEN -180 AND 180),
  weather_on  boolean NOT NULL DEFAULT true,
  set_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('household_places');
CREATE UNIQUE INDEX household_places_one_idx ON household_places (household_id);

CREATE TABLE weather_alerts (
  id           serial PRIMARY KEY,
  alert_id     text NOT NULL,
  event        text NOT NULL,
  severity     text NOT NULL,
  headline     text NOT NULL DEFAULT '',
  instruction  text NOT NULL DEFAULT '',
  onset        timestamptz,
  ends         timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('weather_alerts');
CREATE UNIQUE INDEX weather_alerts_id_idx ON weather_alerts (household_id, alert_id);
