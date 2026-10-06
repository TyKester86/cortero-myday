-- The Feed, redesigned (Oct 2026).
--   * Profiles get an optional Shop slot: the creator's MonetizeMe storefront slug
--     (a link out to <MONETIZEME_URL>/creator/?slug=<slug>).
--   * "Around the Web": articles from trusted ADHD publishers (RSS), screened by
--     the same AI pre-screen as posts, shown as labeled link-out cards. Nothing
--     from the article is copied beyond its title and a short summary.
ALTER TABLE social_profiles ADD COLUMN shop_slug text CHECK (shop_slug ~ '^[a-z0-9][a-z0-9-]{1,59}$');

CREATE TABLE web_items (
  id            serial PRIMARY KEY,
  source        text NOT NULL,          -- feed key, e.g. 'additude'
  publisher     text NOT NULL,          -- shown on the card, e.g. 'ADDitude'
  url           text NOT NULL UNIQUE,
  title         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  published_at  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden')),
  flags         text[] NOT NULL DEFAULT '{}',
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_items_recent ON web_items (published_at DESC) WHERE status = 'visible';
