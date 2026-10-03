-- Hana step 3: grocery carts through the stores' official connections.
-- Kroger: each grown-up connects their own Kroger account (OAuth — MyDay
-- never sees the password); tokens are sealed at rest (lib/seal.ts). The
-- chosen store (location) decides which products and prices are searched.
-- Instacart needs no per-person account: MyDay creates a shopping-list link.

CREATE TABLE grocer_links (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  provider     text NOT NULL CHECK (provider IN ('kroger')),
  access_enc   bytea NOT NULL,
  refresh_enc  bytea,
  key_id       text NOT NULL,
  expires_at   timestamptz NOT NULL,
  location_id  text,
  store_name   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, provider)
);
SELECT myday_tenant('grocer_links');
