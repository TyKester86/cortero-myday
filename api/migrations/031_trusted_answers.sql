-- Trusted Answers (Oct 2026): the community is organized around questions
-- getting answered.
--   community_checks: "Verify with Hana" on a post — one shared fact-check per
--     post, shown inline to everyone (made once, so it isn't re-run per tap).
--   trusted_answers: a question's pinned answer — from Hana, a publisher
--     article, or a moderator marking a reply — shown above every other reply.
-- Bodies are sealed at rest like posts (lib/seal.ts).
CREATE TABLE community_checks (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('feed', 'village')),
  post_id       integer NOT NULL,
  verdict       text NOT NULL,
  result_enc    bytea NOT NULL,
  key_id        text NOT NULL,
  requested_by  integer REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, post_id)
);

CREATE TABLE trusted_answers (
  id             serial PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('feed', 'village')),
  -- a Feed post id, or a Village thread id
  target_id      integer NOT NULL,
  source         text NOT NULL CHECK (source IN ('hana', 'publisher', 'moderator')),
  body_enc       bytea NOT NULL,
  key_id         text NOT NULL,
  sources        jsonb NOT NULL DEFAULT '[]',
  -- a moderator's pick: the Village reply that is the trusted answer
  reply_post_id  integer REFERENCES forum_posts(id) ON DELETE CASCADE,
  marked_by      integer REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, target_id)
);
