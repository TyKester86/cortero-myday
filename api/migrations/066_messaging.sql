-- Hana v2, Q9 JP2: messaging — the consent architecture first.
--
-- message_channels: a grown-up connects their OWN messages to Hana (MyDay's Feed Messages today).
--   Off by default; theirs alone — the other parent never sees what arrives.
-- message_items: Hana's household copy of a connected message — who, when, her one-line summary
--   (sealed), the class — never the full text. Commitments become that grown-up's private loops;
--   scams become warnings to that grown-up only (shield_alerts.for_member).
-- kid_message_safety: for a kid, SAFETY SIGNALS to the parents only (never content), parent-set,
--   disclosed to the kid, OFF by default.

CREATE TABLE message_channels (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'feed_dm' CHECK (kind IN ('feed_dm')),
  connected     boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('message_channels');
CREATE UNIQUE INDEX message_channels_member_idx ON message_channels (member_id, kind);

CREATE TABLE message_items (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  channel       text NOT NULL DEFAULT 'feed_dm',
  ext_ref       text NOT NULL,
  from_user_id  integer,
  from_name     text NOT NULL,
  class         text NOT NULL,
  summary_enc   bytea NOT NULL,
  key_id        text NOT NULL,
  request       boolean NOT NULL DEFAULT false,
  flagged       boolean NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('message_items');
CREATE UNIQUE INDEX message_items_ref_idx ON message_items (household_id, ext_ref);

CREATE TABLE kid_message_safety (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  signals_on  boolean NOT NULL DEFAULT false,
  set_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('kid_message_safety');
CREATE UNIQUE INDEX kid_message_safety_member_idx ON kid_message_safety (member_id);

ALTER TABLE shield_alerts ADD COLUMN for_member integer REFERENCES household_members(id) ON DELETE CASCADE;

ALTER TABLE open_loops DROP CONSTRAINT IF EXISTS open_loops_source_check;
ALTER TABLE open_loops ADD CONSTRAINT open_loops_source_check CHECK (source IN ('chat', 'manual', 'calendar', 'email', 'document', 'money', 'health', 'message'));
