-- The big build: meal library pictures + phase tags, body-style programs,
-- lecture capture + study library, student engine, identity tools, manual
-- money, kid money, push, offline idempotency, Hana actions, engagement.
-- Every new family table gets household_id + the same row-level security.

CREATE FUNCTION myday_tenant(t text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS household_id integer NOT NULL
                    DEFAULT NULLIF(current_setting(''app.household_id'', true), '''')::int
                    REFERENCES households(id) ON DELETE CASCADE', t);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (household_id)', t || '_household_idx', t);
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format(
    'CREATE POLICY %I ON %I
       USING (household_id = NULLIF(current_setting(''app.household_id'', true), '''')::int
              OR current_setting(''app.system'', true) = ''on'')
       WITH CHECK (household_id = NULLIF(current_setting(''app.household_id'', true), '''')::int
                   OR current_setting(''app.system'', true) = ''on'')',
    t || '_tenant', t);
END $$;

/* ---------- members: school, first-run, theme, privacy ---------- */

ALTER TABLE household_members
  ADD COLUMN school text,
  ADD COLUMN first_run_done boolean NOT NULL DEFAULT false,
  ADD COLUMN theme text NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark')),
  ADD COLUMN accent text NOT NULL DEFAULT 'navy',
  ADD COLUMN recording_ack_at timestamptz;

/* ---------- A3: the meal library (global content) ---------- */

ALTER TABLE meals
  ADD COLUMN slug text UNIQUE,
  ADD COLUMN image_url text,
  ADD COLUMN servings integer,
  ADD COLUMN prep_min integer,
  ADD COLUMN phase_tags text[] NOT NULL DEFAULT '{}';

/* ---------- A2 + D: programs, builds, workout log ---------- */

ALTER TABLE health_profiles
  ADD COLUMN build text,
  ADD COLUMN level text NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner', 'experienced')),
  ADD COLUMN bodyweight_lb numeric,
  ADD COLUMN food_protein integer,
  ADD COLUMN baseline_exercise text NOT NULL DEFAULT '',
  ADD COLUMN baseline_sleep text NOT NULL DEFAULT '',
  ADD COLUMN baseline_food text NOT NULL DEFAULT '';
ALTER TABLE workouts ADD COLUMN muscle text NOT NULL DEFAULT '';

CREATE TABLE program_phases (
  id                 serial PRIMARY KEY,
  member_id          integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  idx                integer NOT NULL,
  kind               text NOT NULL,
  name               text NOT NULL,
  week_start         integer NOT NULL,
  week_end           integer NOT NULL,
  nutrition          text NOT NULL,
  focus              text NOT NULL DEFAULT '',
  weekly_change_pct  numeric NOT NULL DEFAULT 0,
  cardio             text NOT NULL DEFAULT ''
);
SELECT myday_tenant('program_phases');

-- "Move my workout to tomorrow": a dated override of the plan's day.
CREATE TABLE workout_moves (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  from_day   date NOT NULL,
  to_day     date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, from_day)
);
SELECT myday_tenant('workout_moves');

ALTER TABLE workout_logs DROP CONSTRAINT workout_logs_kind_check;
ALTER TABLE workout_logs ADD CONSTRAINT workout_logs_kind_check CHECK (kind IN ('exercise', 'day_complete', 'session'));
ALTER TABLE workout_logs ADD COLUMN activity text NOT NULL DEFAULT '', ADD COLUMN minutes integer;

/* ---------- B + E1: classes, lectures, study library, student engine ---------- */

CREATE TABLE classes (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name         text NOT NULL,
  teacher      text NOT NULL DEFAULT '',
  room         text NOT NULL DEFAULT '',
  school       text NOT NULL DEFAULT '',
  color        text NOT NULL DEFAULT '#2E4B8F',
  days         smallint[] NOT NULL DEFAULT '{}',
  start_time   text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'classroom')),
  external_id  text,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('classes');
CREATE UNIQUE INDEX classes_external_idx ON classes (member_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE lectures (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  class_id     integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT '',
  recorded_on  date NOT NULL,
  duration_s   integer NOT NULL DEFAULT 0,
  audio_path   text,
  status       text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'transcribing', 'structuring', 'ready', 'failed')),
  transcript   text NOT NULL DEFAULT '',
  notes        jsonb,
  error        text NOT NULL DEFAULT '',
  -- Scaffold: which parts the student drafts first for this lecture.
  scaffold     text NOT NULL DEFAULT 'none' CHECK (scaffold IN ('none', 'summary', 'key_points')),
  revealed     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('lectures');
CREATE INDEX lectures_class_idx ON lectures (class_id, recorded_on DESC);

CREATE TABLE note_drafts (
  id          serial PRIMARY KEY,
  lecture_id  integer NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  part        text NOT NULL CHECK (part IN ('summary', 'key_points')),
  draft       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lecture_id, part)
);
SELECT myday_tenant('note_drafts');

CREATE TABLE flashcards (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  class_id     integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lecture_id   integer REFERENCES lectures(id) ON DELETE CASCADE,
  front        text NOT NULL,
  back         text NOT NULL,
  explanation  text NOT NULL DEFAULT '',
  -- Leitner box 1..5; higher = known better.
  box          integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('flashcards');

CREATE TABLE quiz_attempts (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  class_id    integer NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  card_id     integer REFERENCES flashcards(id) ON DELETE SET NULL,
  correct     boolean NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('quiz_attempts');

CREATE TABLE lecture_assignments (
  id           serial PRIMARY KEY,
  lecture_id   integer NOT NULL REFERENCES lectures(id) ON DELETE CASCADE,
  title        text NOT NULL,
  due          date,
  homework_id  integer REFERENCES homework(id) ON DELETE SET NULL,
  dismissed    boolean NOT NULL DEFAULT false
);
SELECT myday_tenant('lecture_assignments');

CREATE TABLE assignments (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  class_id   integer REFERENCES classes(id) ON DELETE SET NULL,
  name       text NOT NULL,
  due        date,
  priority   text NOT NULL DEFAULT 'Medium' CHECK (priority IN ('High', 'Medium', 'Low')),
  done       boolean NOT NULL DEFAULT false,
  done_on    date,
  created_on date NOT NULL
);
SELECT myday_tenant('assignments');

CREATE TABLE study_sessions (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  class_id   integer REFERENCES classes(id) ON DELETE SET NULL,
  subject    text NOT NULL DEFAULT '',
  minutes    integer NOT NULL,
  location   text NOT NULL DEFAULT '',
  day        date NOT NULL
);
SELECT myday_tenant('study_sessions');

CREATE TABLE exams (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  course      text NOT NULL DEFAULT '',
  exam_date   date,
  prep_count  integer NOT NULL DEFAULT 0
);
SELECT myday_tenant('exams');

CREATE TABLE campus_contacts (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name       text NOT NULL,
  kind       text NOT NULL DEFAULT 'Other',
  phone      text NOT NULL DEFAULT '',
  email      text NOT NULL DEFAULT '',
  notes      text NOT NULL DEFAULT ''
);
SELECT myday_tenant('campus_contacts');

CREATE TABLE campus_visits (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  contact_id  integer REFERENCES campus_contacts(id) ON DELETE SET NULL,
  name        text NOT NULL,
  day         date NOT NULL
);
SELECT myday_tenant('campus_visits');

/* ---------- E2: identity tools ---------- */

CREATE TABLE identity_anchor (
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  field      text NOT NULL,
  value      text NOT NULL DEFAULT '',
  PRIMARY KEY (member_id, field)
);
SELECT myday_tenant('identity_anchor');

CREATE TABLE identity_reviews (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  month      text NOT NULL,
  answers    text[] NOT NULL,
  UNIQUE (member_id, month)
);
SELECT myday_tenant('identity_reviews');

-- Weekly survey about how the head of household showed up (FamFeedback).
CREATE TABLE household_surveys (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  week_start   date NOT NULL,
  presence     integer NOT NULL, reliability integer NOT NULL, emotional integer NOT NULL,
  follow_through integer NOT NULL, communication integer NOT NULL,
  more_of      text NOT NULL DEFAULT '', improved text NOT NULL DEFAULT '', work_on text NOT NULL DEFAULT '',
  UNIQUE (member_id, week_start)
);
SELECT myday_tenant('household_surveys');

CREATE TABLE mental_load (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  category   text NOT NULL,
  load       text NOT NULL DEFAULT '',
  owner      text NOT NULL DEFAULT '',
  delegate   boolean NOT NULL DEFAULT false,
  UNIQUE (member_id, category)
);
SELECT myday_tenant('mental_load');

/* ---------- E3: manual money ---------- */

CREATE TABLE bills (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name       text NOT NULL,
  amount     numeric NOT NULL,
  due_day    integer CHECK (due_day BETWEEN 1 AND 31),
  autopay    boolean NOT NULL DEFAULT false
);
SELECT myday_tenant('bills');

CREATE TABLE income_sources (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  source     text NOT NULL,
  amount     numeric NOT NULL
);
SELECT myday_tenant('income_sources');

CREATE TABLE money_checkins (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  anxiety    text NOT NULL,
  looked     boolean NOT NULL
);
SELECT myday_tenant('money_checkins');

/* ---------- I: kid / teen money ---------- */

ALTER TABLE money_items ADD COLUMN member_id integer REFERENCES household_members(id) ON DELETE CASCADE;

CREATE TABLE allowances (
  member_id  integer PRIMARY KEY REFERENCES household_members(id) ON DELETE CASCADE,
  amount     numeric NOT NULL,
  weekday    smallint NOT NULL DEFAULT 6 CHECK (weekday BETWEEN 1 AND 7),
  last_paid  date
);
SELECT myday_tenant('allowances');

CREATE TABLE kid_ledger (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  amount     numeric NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('allowance', 'cash', 'gift', 'earned', 'spend', 'to_goal', 'from_goal')),
  category   text NOT NULL DEFAULT '',
  note       text NOT NULL DEFAULT '',
  goal_id    integer,
  created_by integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('kid_ledger');

CREATE TABLE savings_goals (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name       text NOT NULL,
  target     numeric NOT NULL CHECK (target > 0),
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('savings_goals');

/* ---------- F: push + offline ---------- */

CREATE TABLE push_subscriptions (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  endpoint   text NOT NULL UNIQUE,
  p256dh     text NOT NULL,
  auth       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('push_subscriptions');

CREATE TABLE notification_prefs (
  member_id    integer PRIMARY KEY REFERENCES household_members(id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT false,
  bills        boolean NOT NULL DEFAULT true,
  chores       boolean NOT NULL DEFAULT true,
  homework     boolean NOT NULL DEFAULT true,
  -- When the batched nudge goes out (local time, HH:MM) and how often.
  send_at      text NOT NULL DEFAULT '16:00',
  frequency    text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekdays', 'weekly')),
  quiet_start  text NOT NULL DEFAULT '21:00',
  quiet_end    text NOT NULL DEFAULT '07:00'
);
SELECT myday_tenant('notification_prefs');

CREATE TABLE notification_log (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  delivered  integer NOT NULL DEFAULT 0,
  stubbed    boolean NOT NULL DEFAULT false,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, day)
);
SELECT myday_tenant('notification_log');

-- Offline writes replay with an Idempotency-Key; the first result is kept 2 days.
CREATE TABLE idempotency_keys (
  key          text NOT NULL,
  user_id      integer NOT NULL,
  status       integer NOT NULL,
  body         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
SELECT myday_tenant('idempotency_keys');

/* ---------- G: Hana actions awaiting confirmation ---------- */

CREATE TABLE hana_actions (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  input       jsonb NOT NULL,
  summary     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'failed')),
  result      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('hana_actions');

/* ---------- H: engagement ---------- */

CREATE TABLE quests (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  code        text NOT NULL,
  title       text NOT NULL,
  goal        integer NOT NULL,
  reward      integer NOT NULL,
  claimed     boolean NOT NULL DEFAULT false,
  UNIQUE (member_id, week_start, code)
);
SELECT myday_tenant('quests');

CREATE TABLE family_challenges (
  id          serial PRIMARY KEY,
  household_id integer NOT NULL DEFAULT NULLIF(current_setting('app.household_id', true), '')::int REFERENCES households(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  code        text NOT NULL,
  title       text NOT NULL,
  goal        integer NOT NULL,
  UNIQUE (household_id, week_start)
);
SELECT myday_tenant('family_challenges');

CREATE TABLE private_notes (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('private_notes');

CREATE TABLE sunday_rituals (
  household_id integer NOT NULL DEFAULT NULLIF(current_setting('app.household_id', true), '')::int REFERENCES households(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  done_by     integer REFERENCES household_members(id) ON DELETE SET NULL,
  highlight   text NOT NULL DEFAULT '',
  done_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, week_start)
);
SELECT myday_tenant('sunday_rituals');

-- Scores: quest rewards are points too.
ALTER TABLE scores DROP CONSTRAINT scores_source_check;
ALTER TABLE scores ADD CONSTRAINT scores_source_check
  CHECK (source IN ('chore', 'homework', 'perfect_week', 'bonus', 'habit', 'quest'));
