-- Feed Rank v1: The Feed's ranked home feed (friends first, conversation over applause).

-- "For you" (ranked) or "Latest" (strict reverse-chronological): remembered per person.
ALTER TABLE social_profiles ADD COLUMN IF NOT EXISTS feed_sort text NOT NULL DEFAULT 'ranked' CHECK (feed_sort IN ('ranked', 'latest'));

-- Every post served in a ranked page: position and the five components. With the outcomes below this
-- is how the weights get tuned (comments + poll votes per session up, hides/reports per decile down).
CREATE TABLE IF NOT EXISTS feed_rank_impressions (
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL,
  viewer_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     integer NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  author_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position    integer NOT NULL,
  score       numeric(7,5) NOT NULL,
  c           numeric(6,5) NOT NULL,
  f           numeric(6,5) NOT NULL,
  a           numeric(6,5) NOT NULL,
  d           numeric(6,5) NOT NULL,
  e           numeric(6,5) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_rank_impressions_viewer_idx ON feed_rank_impressions (viewer_id, created_at);
CREATE INDEX IF NOT EXISTS feed_rank_impressions_post_idx ON feed_rank_impressions (post_id);

-- Outcomes: like, comment, poll vote, DM started (with the author), report. post_id is null for a DM.
CREATE TABLE IF NOT EXISTS feed_rank_outcomes (
  id          bigserial PRIMARY KEY,
  viewer_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     integer REFERENCES social_posts(id) ON DELETE CASCADE,
  author_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('like', 'comment', 'vote', 'dm', 'report')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_rank_outcomes_viewer_idx ON feed_rank_outcomes (viewer_id, created_at);
CREATE INDEX IF NOT EXISTS feed_rank_outcomes_post_idx ON feed_rank_outcomes (post_id);
