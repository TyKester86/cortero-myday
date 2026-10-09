-- Creators earn in the Feed: tips (one-time) and monthly support, paid through Stripe Connect straight to the
-- creator's own Stripe account. Optional for everyone — the Feed itself stays free.

CREATE TABLE IF NOT EXISTS creator_accounts (
  user_id            integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_account_id  text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'restricted')),
  tips_enabled       boolean NOT NULL DEFAULT false,
  -- Monthly support price (cents); null = no monthly support offered.
  sub_cents          integer CHECK (sub_cents IS NULL OR sub_cents BETWEEN 100 AND 10000),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_tips (
  id                 bigserial PRIMARY KEY,
  creator_user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id       integer REFERENCES users(id) ON DELETE SET NULL,
  cents              integer NOT NULL CHECK (cents BETWEEN 100 AND 50000),
  fee_cents          integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  stripe_session_id  text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  paid_at            timestamptz
);
CREATE INDEX IF NOT EXISTS creator_tips_creator_idx ON creator_tips (creator_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS creator_subscriptions (
  id                      bigserial PRIMARY KEY,
  creator_user_id         integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscriber_user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cents                   integer NOT NULL,
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'canceled')),
  stripe_session_id       text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  current_period_end      timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  canceled_at             timestamptz
);
-- One live support per supporter per creator.
CREATE UNIQUE INDEX IF NOT EXISTS creator_subscriptions_one_idx ON creator_subscriptions (creator_user_id, subscriber_user_id) WHERE status IN ('pending', 'active');

ALTER TABLE feed_notifications DROP CONSTRAINT IF EXISTS feed_notifications_kind_check;
ALTER TABLE feed_notifications ADD CONSTRAINT feed_notifications_kind_check
  CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'request', 'village', 'milestone', 'invite', 'joined', 'tip', 'supporter'));
