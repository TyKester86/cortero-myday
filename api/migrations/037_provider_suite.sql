-- The Provider Business Suite (Oct 2026), for verified licensed providers only: boost a post or clip,
-- run ad campaigns, see their own analytics, and offer paid consult slots. Grown-ups only — ads live
-- inside the 18+ Feed, so kids never see one. Every ad's words are screened for medical claims before
-- it can run; every sponsored item says "Sponsored". Payments go through Stripe Checkout (one-time).

/* ---------- what the analytics count (views the app didn't record before) ---------- */
CREATE TABLE social_profile_views (
  profile_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              date NOT NULL DEFAULT current_date,
  PRIMARY KEY (profile_user_id, viewer_user_id, day)
);
CREATE INDEX social_profile_views_day_idx ON social_profile_views (profile_user_id, day);
-- A Feed post shown to someone (once per person per day).
CREATE TABLE social_post_views (
  post_id         integer NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  viewer_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day             date NOT NULL DEFAULT current_date,
  PRIMARY KEY (post_id, viewer_user_id, day)
);
CREATE INDEX social_post_views_day_idx ON social_post_views (day);
-- Clip views/likes/comments and story views already carry timestamps (036_social).

/* ---------- ads: boosts (a post or clip) and campaigns (a creative + destination) ---------- */
CREATE TABLE ad_campaigns (
  id                  serial PRIMARY KEY,
  provider_user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('boost', 'campaign')),
  name                text NOT NULL,
  -- A boost promotes an existing post or clip; a campaign has its own creative.
  target_kind         text CHECK (target_kind IN ('post', 'clip')),
  target_id           integer,
  headline_enc        bytea,
  body_enc            bytea,
  key_id              text NOT NULL,
  image_id            integer REFERENCES community_images(id) ON DELETE SET NULL,
  destination         text NOT NULL DEFAULT 'profile' CHECK (destination IN ('profile', 'consult', 'url')),
  destination_url     text,
  package_code        text,
  budget_cents        integer NOT NULL CHECK (budget_cents > 0),
  impressions_bought  integer NOT NULL CHECK (impressions_bought > 0),
  impressions         integer NOT NULL DEFAULT 0,
  clicks              integer NOT NULL DEFAULT 0,
  starts_on           date NOT NULL DEFAULT current_date,
  ends_on             date,
  status              text NOT NULL DEFAULT 'pending_payment'
                        CHECK (status IN ('pending_payment', 'active', 'paused', 'completed', 'rejected', 'canceled')),
  reject_reasons      text[] NOT NULL DEFAULT '{}',
  stripe_session_id   text,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_campaigns_provider_idx ON ad_campaigns (provider_user_id, id DESC);
CREATE INDEX ad_campaigns_live_idx ON ad_campaigns (status) WHERE status = 'active';
CREATE UNIQUE INDEX ad_campaigns_session_idx ON ad_campaigns (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
-- One impression per person per campaign per day; clicks once per person per campaign.
CREATE TABLE ad_impressions (
  campaign_id     integer NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day             date NOT NULL DEFAULT current_date,
  PRIMARY KEY (campaign_id, viewer_user_id, day)
);
CREATE TABLE ad_clicks (
  campaign_id     integer NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clicked_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, viewer_user_id)
);

/* ---------- consult booking ---------- */
CREATE TABLE consult_slots (
  id                 serial PRIMARY KEY,
  provider_user_id   integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at          timestamptz NOT NULL,
  minutes            integer NOT NULL CHECK (minutes BETWEEN 10 AND 180),
  price_cents        integer NOT NULL CHECK (price_cents >= 0),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked', 'canceled')),
  booked_by          integer REFERENCES users(id) ON DELETE SET NULL,
  held_until         timestamptz,
  booked_at          timestamptz,
  stripe_session_id  text,
  paid_cents         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_user_id, starts_at)
);
CREATE INDEX consult_slots_open_idx ON consult_slots (provider_user_id, starts_at) WHERE status = 'open';
CREATE UNIQUE INDEX consult_slots_session_idx ON consult_slots (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
