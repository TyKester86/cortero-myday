-- The Feed Publishing API: an authorization code knows the grant it starts, so replaying a used code
-- revokes every token that code produced (RFC 6749 §4.1.2).
ALTER TABLE feed_api_codes ADD COLUMN IF NOT EXISTS grant_id uuid;
