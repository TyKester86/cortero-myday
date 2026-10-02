-- Billing plumbing: flat household plans with an admin-set price (NULL = not decided yet),
-- each household's plan + status + a payment-method placeholder. No real charges here:
-- the payment provider stays behind BILLING_PROVIDER (none | stub).
CREATE TABLE billing_plans (
  id           serial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  price_cents  integer CHECK (price_cents >= 0),
  currency     text NOT NULL DEFAULT 'usd',
  interval     text NOT NULL DEFAULT 'month' CHECK (interval IN ('month', 'year')),
  active       boolean NOT NULL DEFAULT true,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX billing_plans_one_default ON billing_plans (is_default) WHERE is_default;
INSERT INTO billing_plans (code, name, price_cents, is_default) VALUES ('household', 'Household', NULL, true);

ALTER TABLE households
  ADD COLUMN plan_id integer REFERENCES billing_plans(id),
  ADD COLUMN billing_status text NOT NULL DEFAULT 'trialing'
    CHECK (billing_status IN ('trialing', 'active', 'past_due', 'canceled', 'comped')),
  ADD COLUMN payment_method jsonb,
  ADD COLUMN billing_updated_at timestamptz;
UPDATE households SET plan_id = (SELECT id FROM billing_plans WHERE is_default);
-- Households that predate signup (no trial date) are the founding family: comped.
UPDATE households SET billing_status = 'comped' WHERE trial_ends_at IS NULL;
