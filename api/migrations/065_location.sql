-- Hana v2, Q9 JP4: live world context — the consent architecture first.
--
-- location_sharing: per member, OFF by default. A grown-up sets their own; the parents set a
--   kid's (and the kid can always see who sees them — they're told when it changes). viewers =
--   exactly who may see this member's location; nobody else, Hana included, sees it.
-- location_points: the member's own device reports where it is, only while sharing is on.
--   Location history is memory (C9): kept keep_days (default 7), inspectable and deletable by
--   the member themselves, and by the parents for a kid.
-- weather_forecasts: the forecast for the household's opted-in place (NWS), for the timeline.

CREATE TABLE location_sharing (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  sharing     boolean NOT NULL DEFAULT false,
  viewers     integer[] NOT NULL DEFAULT '{}',
  keep_days   integer NOT NULL DEFAULT 7 CHECK (keep_days BETWEEN 1 AND 30),
  set_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('location_sharing');
CREATE UNIQUE INDEX location_sharing_member_idx ON location_sharing (member_id);

CREATE TABLE location_points (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  lat         numeric(8, 5) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon         numeric(8, 5) NOT NULL CHECK (lon BETWEEN -180 AND 180),
  accuracy_m  integer,
  at          timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('location_points');
CREATE INDEX location_points_member_idx ON location_points (member_id, at DESC);

CREATE TABLE weather_forecasts (
  id          serial PRIMARY KEY,
  hourly      jsonb NOT NULL DEFAULT '[]'::jsonb,
  daily       jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('weather_forecasts');
CREATE UNIQUE INDEX weather_forecasts_one_idx ON weather_forecasts (household_id);
