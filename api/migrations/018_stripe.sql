-- Real payments (Stripe): the household's customer + subscription, and when
-- the paid period ends. Keys live only in the server's environment.
ALTER TABLE households
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS paid_through timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS households_stripe_customer_idx ON households (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
