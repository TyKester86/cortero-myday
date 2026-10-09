-- The Feed as its own app (its own domain, same server and database). Sign-in is per domain, so a person
-- signed in on one side is handed to the other with a one-time, short-lived token (hashed here, used once).
CREATE TABLE IF NOT EXISTS auth_handoffs (
  id          bigserial PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next_path   text NOT NULL DEFAULT '/',
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_handoffs_user_idx ON auth_handoffs (user_id, created_at);
