-- Build 2: kid sign-in, homework points, rewards + redemptions, XP tracks,
-- health habits, grocery stores/favorites/ZIP, per-day meal plan.

/* ---------- kid sign-in (parent-managed PIN) ---------- */

ALTER TABLE household_members
  ADD COLUMN pin_hash          text,
  ADD COLUMN pin_version       integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_failed        integer NOT NULL DEFAULT 0,
  ADD COLUMN pin_locked_until  timestamptz,
  -- XP level table: the script's adult roles + a kids' table.
  ADD COLUMN xp_track          text NOT NULL DEFAULT 'leader'
    CHECK (xp_track IN ('leader', 'woman', 'student', 'kid'));
UPDATE household_members SET xp_track = 'kid' WHERE kind = 'kid';

-- Users now come from Google, the dev login, or a kid PIN.
ALTER TABLE users ADD COLUMN auth text NOT NULL DEFAULT 'google'
  CHECK (auth IN ('google', 'dev', 'pin'));
UPDATE users SET auth = 'dev' WHERE google_sub LIKE 'dev:%';

/* ---------- scoring: new point sources + XP-only events ---------- */

ALTER TABLE scores DROP CONSTRAINT scores_source_check;
ALTER TABLE scores ADD CONSTRAINT scores_source_check
  CHECK (source IN ('chore', 'homework', 'perfect_week', 'bonus', 'habit'));
ALTER TABLE scores
  ADD COLUMN homework_id integer UNIQUE REFERENCES homework(id) ON DELETE CASCADE,
  ADD COLUMN habit_id    integer UNIQUE;

-- XP that is not also points (the script's adult XP actions). Points earned
-- in `scores` count as XP too, 1:1 — XP accrues alongside points.
CREATE TABLE xp_events (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  earned_on   date NOT NULL,
  xp          integer NOT NULL CHECK (xp > 0),
  action      text NOT NULL,
  -- Makes "once per day / once per week" awards idempotent.
  once_key    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, once_key)
);
CREATE INDEX xp_events_member_idx ON xp_events (member_id);

/* ---------- homework ---------- */

ALTER TABLE homework ADD COLUMN created_by integer REFERENCES users(id) ON DELETE SET NULL;

/* ---------- rewards store (was "Rewards" + "Redemptions" tabs) ---------- */

CREATE TABLE rewards (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  cost        integer NOT NULL CHECK (cost > 0),
  -- NULL = available to every kid; otherwise only to this member.
  member_id   integer REFERENCES household_members(id) ON DELETE CASCADE,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redemptions (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  reward_id     integer REFERENCES rewards(id) ON DELETE SET NULL,
  reward_name   text NOT NULL,
  cost          integer NOT NULL CHECK (cost > 0),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  requested_on  date NOT NULL,
  decided_by    integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX redemptions_member_idx ON redemptions (member_id, status);

/* ---------- health habits (was "MH Habits") ---------- */

CREATE TABLE health_habits (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  habit      text NOT NULL CHECK (habit IN ('water', 'shake', 'creatine')),
  UNIQUE (member_id, day, habit)
);
ALTER TABLE scores ADD CONSTRAINT scores_habit_fk
  FOREIGN KEY (habit_id) REFERENCES health_habits(id) ON DELETE CASCADE;

/* ---------- grocery: ZIP, favorites, custom stores, idempotent builds ---------- */

CREATE TABLE app_settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

CREATE TABLE grocery_favorites (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  store        text NOT NULL,
  fulfillment  text NOT NULL DEFAULT 'instore' CHECK (fulfillment IN ('instore', 'pickup', 'delivery')),
  signed_in    boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, store)
);

CREATE TABLE custom_stores (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  shop_url  text NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_stores_name_idx ON custom_stores (lower(name));

-- How much of a row's quantity came from "Build from this week's meals".
-- Rebuilding replaces this share instead of adding to it (fixes the script's
-- double-count bug: 4 lb stays 4 lb on a second build).
ALTER TABLE grocery_items ADD COLUMN plan_qty numeric;

/* ---------- meal plan: a real per-day plan (same meal may repeat) ---------- */

ALTER TABLE meal_plan_entries DROP CONSTRAINT meal_plan_entries_member_id_meal_id_key;
CREATE INDEX meal_plan_entries_member_idx ON meal_plan_entries (member_id, day);
