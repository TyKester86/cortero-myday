-- Community / Circles. These tables are deliberately CROSS-household (a circle
-- joins many families), so they are not household-scoped by RLS; every rule is
-- enforced by the API (routes/circles.ts):
--   * no direct messages exist at all (nobody outside the household can DM a kid);
--   * kids under 13 can't use circles; teens only see teen-ok circles, appear as
--     "Teen member" (no name, no profile), and their posts/comments wait for a
--     parent in their own household to approve;
--   * parents can see all of their teens' circle activity;
--   * reports go to a moderation queue (circle moderators + MyDay admins);
--     3 open reports hide the item until reviewed.
CREATE TABLE circles (
  id           serial PRIMARY KEY,
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  teen_ok      boolean NOT NULL DEFAULT false,
  created_by   integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE circle_members (
  circle_id     integer NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  household_id  integer NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, member_id)
);

CREATE TABLE circle_posts (
  id            serial PRIMARY KEY,
  circle_id     integer NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  author_id     integer REFERENCES household_members(id) ON DELETE CASCADE,
  household_id  integer NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  author_teen   boolean NOT NULL DEFAULT false,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX circle_posts_circle_idx ON circle_posts (circle_id, created_at DESC);

CREATE TABLE circle_comments (
  id            serial PRIMARY KEY,
  post_id       integer NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
  author_id     integer REFERENCES household_members(id) ON DELETE CASCADE,
  household_id  integer NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  author_teen   boolean NOT NULL DEFAULT false,
  body          text NOT NULL,
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE circle_reactions (
  post_id    integer NOT NULL REFERENCES circle_posts(id) ON DELETE CASCADE,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  PRIMARY KEY (post_id, member_id, emoji)
);

CREATE TABLE circle_reports (
  id           serial PRIMARY KEY,
  target_type  text NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id    integer NOT NULL,
  circle_id    integer NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  reporter_id  integer REFERENCES household_members(id) ON DELETE SET NULL,
  reason       text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, reporter_id)
);

INSERT INTO circles (slug, name, description, teen_ok) VALUES
  ('adhd-families', 'ADHD Families', 'Parents raising kids with ADHD: routines that work, wins, and the hard days.', false),
  ('teen-focus', 'Teen Focus Crew', 'Teens (and their parents) swapping what helps with homework, focus and getting started.', true),
  ('college-adhd', 'College & ADHD', 'Students and parents navigating classes, accommodations and independence.', true);
