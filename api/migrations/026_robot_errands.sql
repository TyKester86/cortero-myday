-- Hana step 5: saved website logins and errands Hana runs in a real browser.
-- Logins are per grown-up and sealed at rest (lib/seal.ts); the password is
-- never sent back to any screen, never shown to the AI model, and is only
-- typed into a page on the exact website it was saved for. Anything that
-- spends money waits for the person's OK (approval), enforced by the server.

CREATE TABLE saved_logins (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  site          text NOT NULL,
  -- "https://www.example.com": the only origin (scheme + host) it is ever typed into.
  origin        text NOT NULL,
  username_enc  bytea NOT NULL,
  password_enc  bytea NOT NULL,
  key_id        text NOT NULL,
  -- "ty•••@gmail.com" — enough to recognise it, never the whole thing.
  username_hint text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, origin)
);
SELECT myday_tenant('saved_logins');

CREATE TABLE robot_errands (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  goal          text NOT NULL,
  start_url     text NOT NULL,
  login_id      integer REFERENCES saved_logins(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'needs_ok', 'needs_input', 'done', 'failed', 'cancelled')),
  -- needs_ok: what Hana wants to do ("Place the order — total $42.18").
  -- needs_input: her question ("Walmart texted you a code — what is it?").
  ask           text NOT NULL DEFAULT '',
  -- The answer to a needs_input question (sealed: it may be a one-time code).
  answer_enc    bytea,
  -- One approval = one money-spending click.
  approved      boolean NOT NULL DEFAULT false,
  result        text NOT NULL DEFAULT '',
  -- [{ at, say }] a plain-language log (never a password or a code).
  steps         jsonb NOT NULL DEFAULT '[]',
  shot_enc      bytea,
  key_id        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
SELECT myday_tenant('robot_errands');
CREATE INDEX robot_errands_member ON robot_errands (member_id, id DESC);
