-- Hana step 2: "Forward to Hana". Each household can make a private email
-- address; mail forwarded to it lands here, Hana reads it and suggests bills,
-- calendar events and tasks — a grown-up adds or dismisses each one.
--
-- The address's secret part is stored hashed (for lookup) and sealed (so the
-- app can show it again for setting up forwarding). Email subjects and bodies
-- are sealed at rest (lib/seal.ts), like community posts.

CREATE TABLE inbox_addresses (
  token_hash  text PRIMARY KEY,
  token_enc   bytea NOT NULL,
  key_id      text NOT NULL,
  created_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('inbox_addresses');

CREATE TABLE inbox_emails (
  id           serial PRIMARY KEY,
  from_addr    text NOT NULL DEFAULT '',
  subject_enc  bytea NOT NULL,
  body_enc     bytea NOT NULL,
  key_id       text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('inbox_emails');
CREATE INDEX inbox_emails_recent_idx ON inbox_emails (household_id, received_at DESC);

CREATE TABLE inbox_items (
  id          serial PRIMARY KEY,
  email_id    integer NOT NULL REFERENCES inbox_emails(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('bill', 'event', 'task')),
  data        jsonb NOT NULL,
  summary     text NOT NULL,
  status      text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'added', 'dismissed')),
  decided_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('inbox_items');
