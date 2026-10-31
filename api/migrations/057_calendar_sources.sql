-- C2 (Hana v2, Q2): connected calendars, read-only, merged into one family timeline as a VIEW.
--
-- calendar_sources: one person's outside calendar, subscribed by its private iCal (ICS) address —
--   a parent's Google or Outlook calendar, or a kid's school calendar a parent adds. The address is
--   a secret (anyone holding it can read the calendar), so it is sealed at rest and never shown
--   again; url_hint is what the screen shows. visibility 'busy' (the default for a grown-up's own
--   calendar) shows others only "Busy" at those times; 'details' shows titles and places.
-- calendar_source_events: what the last sync read (the next 60 days, the last 7), replaced on
--   each sync — never written back, never merged into calendar_events.
CREATE TABLE calendar_sources (
  id              serial PRIMARY KEY,
  member_id       integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  added_by        integer REFERENCES household_members(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('google', 'outlook', 'apple', 'school', 'other')),
  label           text NOT NULL,
  url_enc         bytea NOT NULL,
  key_id          text NOT NULL,
  url_hint        text NOT NULL,
  visibility      text NOT NULL DEFAULT 'busy' CHECK (visibility IN ('busy', 'details')),
  last_synced_at  timestamptz,
  last_error      text,
  event_count     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('calendar_sources');

CREATE TABLE calendar_source_events (
  id          serial PRIMARY KEY,
  source_id   integer NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,
  uid         text NOT NULL,
  starts_on   date NOT NULL,
  start_time  time,
  end_time    time,
  title       text NOT NULL,
  location    text NOT NULL DEFAULT ''
);
SELECT myday_tenant('calendar_source_events');
CREATE INDEX calendar_source_events_day_idx ON calendar_source_events (household_id, starts_on);

-- The conflict engine's two household knobs: minutes needed to get between two different places
-- (until live traffic is connected), and how many timed things make a child's day over-full.
ALTER TABLE hana_settings
  ADD COLUMN IF NOT EXISTS travel_minutes integer NOT NULL DEFAULT 20 CHECK (travel_minutes BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS kid_day_limit integer NOT NULL DEFAULT 4 CHECK (kid_day_limit BETWEEN 2 AND 12);
