-- Investments / retirement, manual entry only (no broker connections this round).
CREATE TABLE invest_accounts (
  id                    serial PRIMARY KEY,
  owner_id              integer REFERENCES household_members(id) ON DELETE SET NULL,
  name                  text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('401k', '403b', 'ira', 'roth_ira', 'brokerage', 'hsa', '529', 'pension', 'other')),
  monthly_contribution  numeric NOT NULL DEFAULT 0 CHECK (monthly_contribution >= 0),
  employer_match        numeric NOT NULL DEFAULT 0 CHECK (employer_match >= 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('invest_accounts');

-- Balance snapshots (the latest is "now"), each with that day's mix of assets.
CREATE TABLE invest_balances (
  id          serial PRIMARY KEY,
  account_id  integer NOT NULL REFERENCES invest_accounts(id) ON DELETE CASCADE,
  as_of       date NOT NULL,
  balance     numeric NOT NULL CHECK (balance >= 0),
  stocks_pct  numeric NOT NULL DEFAULT 0,
  bonds_pct   numeric NOT NULL DEFAULT 0,
  cash_pct    numeric NOT NULL DEFAULT 0,
  other_pct   numeric NOT NULL DEFAULT 0,
  CHECK (stocks_pct >= 0 AND bonds_pct >= 0 AND cash_pct >= 0 AND other_pct >= 0
         AND abs(stocks_pct + bonds_pct + cash_pct + other_pct - 100) < 0.01),
  UNIQUE (account_id, as_of)
);
SELECT myday_tenant('invest_balances');

-- One plan per household: target mix + projection assumptions.
CREATE TABLE invest_plans (
  household_id        integer PRIMARY KEY DEFAULT NULLIF(current_setting('app.household_id', true), '')::int
                        REFERENCES households(id) ON DELETE CASCADE,
  target_stocks       numeric NOT NULL DEFAULT 80,
  target_bonds        numeric NOT NULL DEFAULT 15,
  target_cash         numeric NOT NULL DEFAULT 5,
  target_other        numeric NOT NULL DEFAULT 0,
  expected_return_pct numeric NOT NULL DEFAULT 6,
  inflation_pct       numeric NOT NULL DEFAULT 2.5,
  years_to_retire     integer NOT NULL DEFAULT 25,
  withdrawal_pct      numeric NOT NULL DEFAULT 4,
  CHECK (abs(target_stocks + target_bonds + target_cash + target_other - 100) < 0.01)
);
SELECT myday_tenant('invest_plans');
