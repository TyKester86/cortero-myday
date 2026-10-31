-- Hana v2, Q5: C5 — the paper of family life, and the household vault.
--
-- documents: one inbox for forms, permission slips, medical and insurance papers, registrations —
--   in by upload, a phone photo, or forwarded mail. Hana reads what it is, whose it is, what's
--   needed and the deadline (fields: the blanks a form asks for). completion_enc: the fill-in a
--   parent approved (from what the household already holds) — never signed; a parent signs and
--   sends. File, text and completion are sealed at rest. Parents only.
-- vault_items: licenses, passports, insurance cards, registrations, warranties. The number is
--   sealed and shown masked; expiries surface in the brief and the watch ahead of time.
CREATE TABLE documents (
  id              serial PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('form', 'permission_slip', 'medical', 'insurance', 'registration', 'other')),
  title           text NOT NULL,
  about_member    integer REFERENCES household_members(id) ON DELETE SET NULL,
  needed          text NOT NULL DEFAULT '',
  deadline        date,
  fields          jsonb NOT NULL DEFAULT '[]'::jsonb,
  source          text NOT NULL CHECK (source IN ('upload', 'photo', 'email')),
  source_ref      text,
  mime            text,
  size            integer,
  file_enc        bytea,
  text_enc        bytea,
  completion_enc  bytea,
  key_id          text NOT NULL,
  read_by         text NOT NULL DEFAULT 'rules' CHECK (read_by IN ('ai', 'rules', 'person')),
  done_at         timestamptz,
  done_by         integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_by      integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('documents');
CREATE UNIQUE INDEX documents_source_idx ON documents (household_id, source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE vault_items (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('drivers_license', 'passport', 'insurance_card', 'registration', 'warranty', 'id_card', 'other')),
  label         text NOT NULL,
  holder        integer REFERENCES household_members(id) ON DELETE SET NULL,
  issuer        text NOT NULL DEFAULT '',
  number_enc    bytea,
  extra_enc     bytea,
  key_id        text NOT NULL,
  expires       date,
  created_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('vault_items');

-- A form's deadline is a loop (C4) too.
ALTER TABLE open_loops DROP CONSTRAINT IF EXISTS open_loops_source_check;
ALTER TABLE open_loops ADD CONSTRAINT open_loops_source_check CHECK (source IN ('chat', 'manual', 'calendar', 'email', 'document'));
