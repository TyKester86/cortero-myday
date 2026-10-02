-- Build 3: money, battles, brain dump, family, household admin, Ask Hana +
-- tutor, Red Alert, the adult engine (check-in, tasks, review, habits,
-- achievements, daily score), meal slots, kid devices + sign-in log.

/* ---------- household admin ---------- */

-- Removing someone archives them: history and points stay, sign-in stops.
ALTER TABLE household_members ADD COLUMN archived_at timestamptz;

CREATE TABLE invites (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  email        text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  revoked_at   timestamptz
);

-- "Remember this device" for kids: a shared family device lists its kids by
-- name so they only type a PIN. The cookie holds a random token; we keep a hash.
CREATE TABLE kid_devices (
  id            serial PRIMARY KEY,
  token_hash    text NOT NULL UNIQUE,
  label         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE TABLE kid_device_members (
  device_id  integer NOT NULL REFERENCES kid_devices(id) ON DELETE CASCADE,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  PRIMARY KEY (device_id, member_id)
);

CREATE TABLE kid_signins (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  ok         boolean NOT NULL,
  device     text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kid_signins_member_idx ON kid_signins (member_id, at DESC);

/* ---------- family (was Curfews, FamPartner, FamParent) ---------- */

CREATE TABLE curfews (
  member_id          integer PRIMARY KEY REFERENCES household_members(id) ON DELETE CASCADE,
  curfew_weekday     text NOT NULL DEFAULT '',
  curfew_weekend     text NOT NULL DEFAULT '',
  phone_off_weekday  text NOT NULL DEFAULT '',
  phone_off_weekend  text NOT NULL DEFAULT ''
);

CREATE TABLE partner_checkins (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  positives   integer NOT NULL DEFAULT 0,
  negatives   integer NOT NULL DEFAULT 0,
  connection  text NOT NULL DEFAULT '',
  conflict    boolean NOT NULL DEFAULT false,
  flooded     boolean NOT NULL DEFAULT false,
  took_break  boolean NOT NULL DEFAULT false,
  need        text NOT NULL DEFAULT '',
  updated_on  date NOT NULL,
  UNIQUE (member_id, week_start)
);

CREATE TABLE one_on_ones (
  id            serial PRIMARY KEY,
  member_id     integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  child_id      integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  logged_on     date NOT NULL,
  minutes       integer NOT NULL DEFAULT 0,
  promise_kept  boolean NOT NULL DEFAULT false,
  moment        boolean NOT NULL DEFAULT false,
  reflection    text NOT NULL DEFAULT '',
  word          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX one_on_ones_member_idx ON one_on_ones (member_id, logged_on);

/* ---------- adult engine (was FamCheckIn, FamTasks, FamReview, FamHabits, FamDump) ---------- */

CREATE TABLE checkins (
  id        serial PRIMARY KEY,
  member_id integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day       date NOT NULL,
  nervous   text NOT NULL DEFAULT '',
  sleep     text NOT NULL DEFAULT '',
  fuel      text NOT NULL DEFAULT '',
  grateful  text NOT NULL DEFAULT '',
  UNIQUE (member_id, day)
);

CREATE TABLE tasks (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day         date NOT NULL,
  task        text NOT NULL,
  priority    text NOT NULL DEFAULT 'Important' CHECK (priority IN ('Critical', 'Important', 'Later')),
  energy      text NOT NULL DEFAULT 'Low Brain' CHECK (energy IN ('High Brain', 'Low Brain', 'Body-only')),
  context     text NOT NULL DEFAULT '',
  est_min     integer,
  mit         boolean NOT NULL DEFAULT false,
  done        boolean NOT NULL DEFAULT false,
  done_on     date,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_member_day_idx ON tasks (member_id, day);

CREATE TABLE reviews (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day         date NOT NULL,
  got         text NOT NULL DEFAULT '',
  derailed    text NOT NULL DEFAULT '',
  tomorrow    text NOT NULL DEFAULT '',
  rsd         text NOT NULL DEFAULT '',
  energy_end  text NOT NULL DEFAULT '',
  UNIQUE (member_id, day)
);

-- The old weekly habit tracker: named habits, ticked per day.
CREATE TABLE habits (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE habit_checks (
  habit_id  integer NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day       date NOT NULL,
  PRIMARY KEY (habit_id, day)
);

CREATE TABLE dump_items (
  id           serial PRIMARY KEY,
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  captured_on  date NOT NULL,
  note         text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'task', 'done')),
  task_id      integer REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dump_items_member_idx ON dump_items (member_id, status);

-- One row per adult per day: the 5 × 20 daily score (scoreToday_).
CREATE TABLE daily_scores (
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  parts      integer[] NOT NULL,
  total      integer NOT NULL,
  PRIMARY KEY (member_id, day)
);

CREATE TABLE achievements (
  member_id    integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name         text NOT NULL,
  unlocked_on  date NOT NULL,
  PRIMARY KEY (member_id, name)
);

/* ---------- battles + red alert (was FamBoss, FamRedAlert) ---------- */

CREATE TABLE boss_battles (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done', 'replaced')),
  started_on  date NOT NULL,
  done_on     date
);
CREATE UNIQUE INDEX boss_battles_one_active_idx ON boss_battles (member_id) WHERE status = 'active';

CREATE TABLE red_alerts (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day         date NOT NULL,
  trigger     text NOT NULL DEFAULT '',
  steps_done  integer NOT NULL DEFAULT 0,
  steps_total integer NOT NULL,
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

/* ---------- Ask Hana + tutor (was FamChat) ---------- */

CREATE TABLE chat_messages (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  mode        text NOT NULL CHECK (mode IN ('companion', 'tutor')),
  who         text NOT NULL CHECK (who IN ('user', 'hana')),
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_member_idx ON chat_messages (member_id, mode, id);

/* ---------- money (read-only bank data via a provider: Plaid or the local fake) ---------- */

CREATE TABLE money_items (
  id                serial PRIMARY KEY,
  provider          text NOT NULL CHECK (provider IN ('plaid', 'fake')),
  item_id           text NOT NULL UNIQUE,
  -- AES-256-GCM encrypted provider access token (never stored in plain text).
  access_token_enc  text NOT NULL,
  institution       text NOT NULL DEFAULT '',
  linked_by         integer REFERENCES household_members(id) ON DELETE SET NULL,
  last_synced_at    timestamptz,
  sync_error        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE money_accounts (
  id          serial PRIMARY KEY,
  item_id     integer NOT NULL REFERENCES money_items(id) ON DELETE CASCADE,
  account_id  text NOT NULL UNIQUE,
  name        text NOT NULL,
  mask        text NOT NULL DEFAULT '',
  type        text NOT NULL,
  subtype     text NOT NULL DEFAULT '',
  current     numeric,
  available   numeric,
  currency    text NOT NULL DEFAULT 'USD',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- amount follows Plaid's convention: positive = money out, negative = money in.
CREATE TABLE money_transactions (
  id          serial PRIMARY KEY,
  account_id  integer NOT NULL REFERENCES money_accounts(id) ON DELETE CASCADE,
  txn_id      text NOT NULL UNIQUE,
  day         date NOT NULL,
  name        text NOT NULL,
  merchant    text NOT NULL DEFAULT '',
  amount      numeric NOT NULL,
  category    text NOT NULL DEFAULT '',
  pending     boolean NOT NULL DEFAULT false
);
CREATE INDEX money_transactions_day_idx ON money_transactions (day DESC);

/* ---------- meal slots ---------- */

ALTER TABLE meal_plan_entries ADD COLUMN slot text CHECK (slot IN ('breakfast', 'lunch', 'dinner'));
