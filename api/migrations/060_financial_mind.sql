-- Hana v2, Q6: the Financial Mind + C6 money preparation. Parents only; she never moves money.
--
-- debts: every liability in one picture (balance, APR, minimum, due day, limit). A debt linked
--   to a bank card (account_id) takes its balance and limit from the bank.
-- sinking_funds: irregular expenses (premiums, holidays, car repairs) turned into a monthly
--   reserve that safe-to-spend sets aside — "surprise" bills stop existing.
-- money_wants: the 24-hour list. Non-essential buys over the family's threshold are held, not
--   blocked; after a day she asks once whether it's still wanted.
-- money_marks: a parent's word on a recurring charge — 'cancelled' (a charge after this date is a
--   capture check) or 'keep' (still used; asked again after 90 days).
-- money_benefits: use-it-or-lose-it money (FSA, dependent-care FSA, HSA contribution room).
-- money_snapshots: one row a day (safe-to-spend, total debt, debt-free month, net) — so wins
--   ("the debt-free date moved closer") are facts, not vibes.
-- money_settings: the household's knobs (wait-list threshold, extra debt payment, cushion, and
--   a pay schedule for households with no bank-detected paycheck).
CREATE TABLE debts (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('credit_card', 'auto', 'student', 'mortgage', 'personal', 'medical', 'other')),
  balance       numeric NOT NULL DEFAULT 0 CHECK (balance >= 0),
  apr           numeric CHECK (apr IS NULL OR (apr >= 0 AND apr <= 100)),
  minimum       numeric NOT NULL DEFAULT 0 CHECK (minimum >= 0),
  due_day       integer CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  credit_limit  numeric CHECK (credit_limit IS NULL OR credit_limit > 0),
  account_id    integer REFERENCES money_accounts(id) ON DELETE SET NULL,
  autopay       boolean NOT NULL DEFAULT false,
  created_by    integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('debts');

CREATE TABLE sinking_funds (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  amount      numeric NOT NULL CHECK (amount > 0),
  due_on      date NOT NULL,
  saved       numeric NOT NULL DEFAULT 0 CHECK (saved >= 0),
  yearly      boolean NOT NULL DEFAULT true,
  created_by  integer REFERENCES household_members(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('sinking_funds');

CREATE TABLE money_wants (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  what        text NOT NULL,
  amount      numeric NOT NULL CHECK (amount > 0),
  added_at    timestamptz NOT NULL DEFAULT now(),
  decided     text CHECK (decided IN ('bought', 'let_go')),
  decided_at  timestamptz
);
SELECT myday_tenant('money_wants');

CREATE TABLE money_marks (
  id            serial PRIMARY KEY,
  merchant_key  text NOT NULL,
  label         text NOT NULL,
  mark          text NOT NULL CHECK (mark IN ('cancelled', 'keep')),
  marked_on     date NOT NULL,
  marked_by     integer REFERENCES household_members(id) ON DELETE SET NULL
);
SELECT myday_tenant('money_marks');
CREATE UNIQUE INDEX money_marks_key_idx ON money_marks (household_id, merchant_key);

CREATE TABLE money_benefits (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('fsa', 'dependent_care_fsa', 'hsa', 'other')),
  label       text NOT NULL,
  amount      numeric NOT NULL CHECK (amount >= 0),
  deadline    date NOT NULL,
  created_by  integer REFERENCES household_members(id) ON DELETE SET NULL
);
SELECT myday_tenant('money_benefits');

CREATE TABLE money_snapshots (
  id               serial PRIMARY KEY,
  day              date NOT NULL,
  safe             numeric,
  debt_total       numeric NOT NULL DEFAULT 0,
  debt_free_month  text,
  net              numeric
);
SELECT myday_tenant('money_snapshots');
CREATE UNIQUE INDEX money_snapshots_day_idx ON money_snapshots (household_id, day);

CREATE TABLE money_settings (
  id                 serial PRIMARY KEY,
  want_threshold     numeric NOT NULL DEFAULT 100 CHECK (want_threshold >= 0),
  extra_payment      numeric NOT NULL DEFAULT 0 CHECK (extra_payment >= 0),
  cushion            numeric NOT NULL DEFAULT 0 CHECK (cushion >= 0),
  pay_anchor         date,
  pay_cadence        text CHECK (pay_cadence IN ('weekly', 'biweekly', 'semimonthly', 'monthly')),
  pay_amount         numeric CHECK (pay_amount IS NULL OR pay_amount > 0),
  updated_by         integer REFERENCES household_members(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('money_settings');
CREATE UNIQUE INDEX money_settings_one_idx ON money_settings (household_id);

-- Capture check: the most an employer would add each month (employer_match is what it adds now).
ALTER TABLE invest_accounts ADD COLUMN IF NOT EXISTS match_max numeric NOT NULL DEFAULT 0 CHECK (match_max >= 0);

-- Minimums, unpaid bills and a predicted overdraft are loops (C4) with the prepared fix attached.
ALTER TABLE open_loops DROP CONSTRAINT IF EXISTS open_loops_source_check;
ALTER TABLE open_loops ADD CONSTRAINT open_loops_source_check CHECK (source IN ('chat', 'manual', 'calendar', 'email', 'document', 'money'));
