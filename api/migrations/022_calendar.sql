-- The household calendar: events everyone in the household can see (kids
-- included, unless an event is grown-ups only), plus a private subscription
-- link that adds it to Google, Apple or Outlook calendar (read-only there).
--
-- Times are local to the household time zone (TZ_HOUSEHOLD). An event with
-- no start_time is all-day. Repeats expand on the fly (never stored per day).

CREATE TABLE calendar_events (
  id             serial PRIMARY KEY,
  title          text NOT NULL,
  notes          text NOT NULL DEFAULT '',
  location       text NOT NULL DEFAULT '',
  starts_on      date NOT NULL,
  start_time     time,
  end_time       time,
  repeat         text NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  repeat_until   date,
  adults_only    boolean NOT NULL DEFAULT false,
  -- Minutes before the start to send a push reminder (timed events only).
  remind_minutes integer CHECK (remind_minutes IS NULL OR remind_minutes BETWEEN 0 AND 10080),
  created_by     integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('calendar_events');
CREATE INDEX calendar_events_starts_idx ON calendar_events (household_id, starts_on);

-- Who an event is for (none = the whole household). A join table, not an
-- array, so a household merge re-points people like every other table.
CREATE TABLE calendar_event_people (
  event_id   integer NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, member_id)
);
SELECT myday_tenant('calendar_event_people');

-- One reminder per occurrence (claimed before sending, so two servers can't both send).
CREATE TABLE calendar_reminders_sent (
  event_id   integer NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  occurs_on  date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, occurs_on)
);
SELECT myday_tenant('calendar_reminders_sent');

-- The subscription link: only a hash of its secret is stored. A new link
-- replaces the old one (the old link stops working).
CREATE TABLE calendar_feeds (
  token_hash  text PRIMARY KEY,
  created_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
SELECT myday_tenant('calendar_feeds');
