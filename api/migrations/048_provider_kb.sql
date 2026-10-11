-- Provider Knowledge Base v1: providers verified for free (NPPES + OIG) earn "Verified provider background".
-- They post and respond as credentialed members. Not therapy: not listed, not bookable, no clinical relationship.
-- Stored: what the gates need and their results. Never an SSN or a date of birth.

-- Checked before any account exists: a pass for verified / needs_review, carried through sign-in (like the
-- Feed's age proof). Rejected attempts leave nothing here.
CREATE TABLE IF NOT EXISTS provider_applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name       text NOT NULL,
  display_name     text NOT NULL,
  npi              text NOT NULL,
  taxonomy_code    text NOT NULL,
  license_states   text[] NOT NULL DEFAULT '{}',
  credentials      text,
  bio              text,
  status           text NOT NULL CHECK (status IN ('verified', 'needs_review')),
  reason           text,
  nppes_name       text,
  name_score       numeric(4,3),
  nppes_taxonomies jsonb NOT NULL DEFAULT '[]',
  created_at       timestamptz NOT NULL DEFAULT now(),
  claimed_by       integer REFERENCES users(id) ON DELETE CASCADE,
  claimed_at       timestamptz
);

CREATE TABLE IF NOT EXISTS provider_verifications (
  user_id              integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_name           text NOT NULL,
  npi                  text NOT NULL,
  taxonomy_code        text NOT NULL,
  license_states       text[] NOT NULL DEFAULT '{}',   -- self-reported, not verified at this tier
  credentials          text,
  status               text NOT NULL CHECK (status IN ('verified', 'needs_review', 'rejected')),
  reason               text,
  nppes_name           text,
  name_score           numeric(4,3),
  nppes_taxonomies     jsonb NOT NULL DEFAULT '[]',
  oig_checked_at       timestamptz,
  badge_state          text NOT NULL DEFAULT 'none' CHECK (badge_state IN ('none', 'active', 'suspended', 'revoked')),
  badge_changed_at     timestamptz,
  solicitation_strikes integer NOT NULL DEFAULT 0,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  verified_at          timestamptz,
  reviewed_by          integer REFERENCES users(id) ON DELETE SET NULL,
  -- Reserved for the clinical tier ("Licensed & verified") — dormant, nothing reads or sets these yet.
  verification_tier    text NOT NULL DEFAULT 'knowledge' CHECK (verification_tier IN ('knowledge', 'clinical')),
  board_check          jsonb,          -- { result, checked_at, vendor_ref }
  bookable             boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS provider_verifications_npi_idx ON provider_verifications (npi) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS provider_verifications_review_idx ON provider_verifications (status) WHERE status = 'needs_review';

-- The OIG LEIE exclusion list, mirrored monthly (names, NPI, type and date only — the file's dates of birth are not kept).
CREATE TABLE IF NOT EXISTS oig_exclusions (
  lastname   text NOT NULL DEFAULT '',
  firstname  text NOT NULL DEFAULT '',
  midname    text NOT NULL DEFAULT '',
  busname    text NOT NULL DEFAULT '',
  npi        text,
  state      text,
  excltype   text,
  excldate   text
);
CREATE INDEX IF NOT EXISTS oig_exclusions_npi_idx ON oig_exclusions (npi) WHERE npi IS NOT NULL;
CREATE INDEX IF NOT EXISTS oig_exclusions_name_idx ON oig_exclusions (lower(lastname), lower(firstname));
CREATE TABLE IF NOT EXISTS oig_mirror (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  source      text NOT NULL,
  rows        integer NOT NULL,
  fetched_at  timestamptz NOT NULL
);

-- The badge, for every query that shows it (profiles, posts, comments, search, people).
CREATE OR REPLACE FUNCTION feed_provider_badge(uid integer) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM provider_verifications WHERE user_id = uid AND badge_state = 'active')
$$;

-- Sign-in carries a provider pass instead of a date of birth (an NPI-verified provider is an adult).
ALTER TABLE email_logins ADD COLUMN IF NOT EXISTS provider_app uuid;

ALTER TABLE feed_notifications DROP CONSTRAINT IF EXISTS feed_notifications_kind_check;
ALTER TABLE feed_notifications ADD CONSTRAINT feed_notifications_kind_check
  CHECK (kind IN ('like', 'comment', 'reply', 'follow', 'mention', 'dm', 'request', 'village', 'milestone', 'invite', 'joined', 'tip', 'supporter', 'friend_request', 'friend_accept', 'provider'));
