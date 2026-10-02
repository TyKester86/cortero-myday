-- MyDay v2 foundation: identity, household, chores, scoring, health, meals,
-- weekly plan. One household per database (see README "Decisions").

-- Server-side sessions (connect-pg-simple layout).
CREATE TABLE session (
  sid    varchar PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX session_expire_idx ON session (expire);

-- The household roster. Replaces the old "Household" sheet tab; nothing is
-- hard-coded by name anywhere in the app.
CREATE TABLE household_members (
  id          serial PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('kid', 'adult')),
  age         integer CHECK (age IS NULL OR age >= 0),
  -- Google account that signs in as this member (adults; optional for kids).
  email       text UNIQUE,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             serial PRIMARY KEY,
  google_sub     text NOT NULL UNIQUE,
  email          text NOT NULL,
  name           text NOT NULL DEFAULT '',
  member_id      integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now()
);

-- Replaces the "Chore Board" tab. days = ISO weekdays (1 = Mon .. 7 = Sun).
CREATE TABLE chores (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  days        smallint[] NOT NULL,
  points      integer NOT NULL CHECK (points >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_on  date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (days <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);
CREATE UNIQUE INDEX chores_member_name_active_idx ON chores (member_id, lower(name)) WHERE active;

CREATE TABLE chore_completions (
  id            serial PRIMARY KEY,
  chore_id      integer NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  completed_on  date NOT NULL,
  points        integer NOT NULL,
  completed_by  integer REFERENCES users(id) ON DELETE SET NULL,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chore_id, completed_on)
);

-- Kids' homework. The Homework module ships in a later build; the table exists
-- now because the Perfect Week rule depends on "no hanging homework".
CREATE TABLE homework (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  assignment  text NOT NULL,
  subject     text NOT NULL DEFAULT '',
  due         date,
  done        boolean NOT NULL DEFAULT false,
  done_on     date,
  points      integer NOT NULL DEFAULT 20,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Points ledger. Every point a member has ever earned is one row here.
CREATE TABLE scores (
  id                   serial PRIMARY KEY,
  member_id            integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  earned_on            date NOT NULL,
  points               integer NOT NULL,
  source               text NOT NULL CHECK (source IN ('chore', 'homework', 'perfect_week', 'bonus')),
  note                 text NOT NULL DEFAULT '',
  chore_completion_id  integer UNIQUE REFERENCES chore_completions(id) ON DELETE CASCADE,
  week_start           date,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scores_member_date_idx ON scores (member_id, earned_on);
-- Perfect Week is awarded at most once per member per week.
CREATE UNIQUE INDEX scores_perfect_week_once_idx ON scores (member_id, week_start) WHERE source = 'perfect_week';

/* ---------- health (replaces the "MH ..." tabs) ---------- */

-- Per-member training + nutrition profile (was MH_PROFILE / MH_START /
-- MH_TRAIN_WEEKDAYS hard-coded per person in the script).
CREATE TABLE health_profiles (
  member_id           integer PRIMARY KEY REFERENCES household_members(id) ON DELETE CASCADE,
  plan_start          date NOT NULL,
  train_weekdays      smallint[] NOT NULL DEFAULT ARRAY[1,2,4,5]::smallint[],
  target_calories     integer NOT NULL DEFAULT 0,
  target_protein      integer NOT NULL DEFAULT 0,
  target_carbs        integer NOT NULL DEFAULT 0,
  target_fat          integer NOT NULL DEFAULT 0,
  breakfast           text NOT NULL DEFAULT '',
  shake               text NOT NULL DEFAULT '',
  cardio              text NOT NULL DEFAULT '',
  workout_chore_name  text NOT NULL DEFAULT 'Indoor workout (AM)'
);

-- The year workout plan, one row per exercise (was "MH Workouts").
CREATE TABLE workouts (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  phase_id    text NOT NULL,
  phase_name  text NOT NULL,
  week_start  integer NOT NULL,
  week_end    integer NOT NULL,
  day_num     integer NOT NULL,
  day_name    text NOT NULL,
  exercise    text NOT NULL,
  sets        integer NOT NULL DEFAULT 0,
  reps        text NOT NULL DEFAULT '',
  rest        text NOT NULL DEFAULT '',
  equipment   text NOT NULL DEFAULT '',
  cues        text NOT NULL DEFAULT '',
  subs        text NOT NULL DEFAULT '',
  focus       text NOT NULL DEFAULT '',
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX workouts_member_idx ON workouts (member_id, week_start, week_end);

-- Logged sets + completed days (was "MH Workout Log").
CREATE TABLE workout_logs (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  logged_on   date NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('exercise', 'day_complete')),
  phase_name  text NOT NULL DEFAULT '',
  day_name    text NOT NULL DEFAULT '',
  exercise    text NOT NULL DEFAULT '',
  sets        integer,
  reps        text NOT NULL DEFAULT '',
  weight      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workout_logs_member_idx ON workout_logs (member_id, logged_on);

/* ---------- meals (replaces "MH Meals", "MH Meal Week", grocery tabs) ---------- */

CREATE TABLE meals (
  id           serial PRIMARY KEY,
  title        text NOT NULL,
  cuisine      text NOT NULL DEFAULT '',
  calories     integer,
  protein      integer,
  carbs        integer,
  fat          integer,
  ingredients  text[] NOT NULL DEFAULT '{}',
  steps        text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE meal_plan_entries (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  meal_id    integer NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  day        smallint CHECK (day BETWEEN 1 AND 7),
  added_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, meal_id)
);

-- One household grocery list (one family, one grocery run).
CREATE TABLE grocery_items (
  id         serial PRIMARY KEY,
  item       text NOT NULL,
  qty        text NOT NULL DEFAULT '',
  done       boolean NOT NULL DEFAULT false,
  added_by   text NOT NULL DEFAULT 'household',
  added_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grocery_staples (
  id        serial PRIMARY KEY,
  item      text NOT NULL,
  added_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX grocery_staples_item_idx ON grocery_staples (lower(item));

/* ---------- weekly plan (was "FamWeekly") ---------- */

CREATE TABLE weekly_plans (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  theme       text NOT NULL DEFAULT '',
  top         text NOT NULL DEFAULT '',
  energy      text NOT NULL DEFAULT '',
  focus       text NOT NULL DEFAULT '',
  rsd         text NOT NULL DEFAULT '',
  review      text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, week_start)
);
