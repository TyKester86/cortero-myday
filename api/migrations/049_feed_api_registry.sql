-- The Feed Publishing API (v1): third-party apps that publish to The Feed for a Feed user who authorized
-- them (the relationship Buffer has to Instagram). Four separate things, four tables:
--   feed_api_apps            -- a developer's registered application (client_id + hashed client_secret)
--   feed_api_authorizations  -- a user's standing consent to one app (scopes), revocable
--   feed_api_codes           -- one-time OAuth authorization codes (hashed, short-lived)
--   feed_api_tokens          -- access + refresh tokens (hashed), bound to one (app, user) authorization
-- Secrets and tokens are never stored in the clear: only their SHA-256 hashes.

CREATE TABLE IF NOT EXISTS feed_api_apps (
  id                  serial PRIMARY KEY,
  owner_user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  description         text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  website             text NOT NULL DEFAULT '' CHECK (char_length(website) <= 300),
  redirect_uris       text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
  scopes              text[] NOT NULL CHECK (scopes <@ ARRAY['profile.read','posts.write']::text[] AND cardinality(scopes) >= 1),
  client_id           text NOT NULL UNIQUE,
  client_secret_hash  text NOT NULL,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspended_at        timestamptz,
  suspended_reason    text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_api_apps_owner_idx ON feed_api_apps (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_api_authorizations (
  id          serial PRIMARY KEY,
  app_id      integer NOT NULL REFERENCES feed_api_apps(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
-- One live authorization per (app, user); a revoked one stays as history.
CREATE UNIQUE INDEX IF NOT EXISTS feed_api_authorizations_live_idx ON feed_api_authorizations (app_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_api_authorizations_user_idx ON feed_api_authorizations (user_id);

CREATE TABLE IF NOT EXISTS feed_api_codes (
  code_hash             text PRIMARY KEY,
  authorization_id      integer NOT NULL REFERENCES feed_api_authorizations(id) ON DELETE CASCADE,
  redirect_uri          text NOT NULL,
  scopes                text[] NOT NULL,
  code_challenge        text,
  code_challenge_method text CHECK (code_challenge_method IS NULL OR code_challenge_method = 'S256'),
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feed_api_tokens (
  id                bigserial PRIMARY KEY,
  token_hash        text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN ('access','refresh')),
  authorization_id  integer NOT NULL REFERENCES feed_api_authorizations(id) ON DELETE CASCADE,
  -- One grant = one code exchange and every refresh rotated from it. Revoking or replaying a refresh
  -- token kills the whole grant.
  grant_id          uuid NOT NULL,
  scopes            text[] NOT NULL,
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  rotated_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_api_tokens_grant_idx ON feed_api_tokens (grant_id);
CREATE INDEX IF NOT EXISTS feed_api_tokens_auth_idx ON feed_api_tokens (authorization_id)
