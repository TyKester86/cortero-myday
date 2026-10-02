-- Care Team: professionals (tutors, coaches, mental-health providers) the family
-- explicitly lets in. Access is granted per person, per scope, revocable at any
-- time, and every access is written to an append-only log.
-- Mental-health grants: only an adult can grant one, only for themselves, and
-- the notes + log are visible to that adult and the provider only.

CREATE TABLE pro_profiles (
  user_id       integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name  text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('tutor', 'coach', 'mental_health')),
  credentials   text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE care_grants (
  id                 serial PRIMARY KEY,
  kind               text NOT NULL CHECK (kind IN ('tutor', 'coach', 'mental_health')),
  subject_member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  granted_by         integer REFERENCES household_members(id) ON DELETE SET NULL,
  pro_user_id        integer REFERENCES users(id) ON DELETE CASCADE,
  scopes             text[] NOT NULL,
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'revoked')),
  invite_hash        text UNIQUE,
  invite_expires_at  timestamptz,
  label              text NOT NULL DEFAULT '',
  created_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  revoked_at         timestamptz,
  CHECK (scopes <@ ARRAY['homework', 'school', 'health', 'day', 'checkins']::text[])
);
SELECT myday_tenant('care_grants');

CREATE TABLE care_notes (
  id          serial PRIMARY KEY,
  grant_id    integer NOT NULL REFERENCES care_grants(id) ON DELETE CASCADE,
  author      text NOT NULL CHECK (author IN ('pro', 'family')),
  member_id   integer REFERENCES household_members(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('care_notes');

CREATE TABLE care_access_log (
  id           bigserial PRIMARY KEY,
  grant_id     integer REFERENCES care_grants(id) ON DELETE SET NULL,
  pro_user_id  integer REFERENCES users(id) ON DELETE SET NULL,
  member_id    integer REFERENCES household_members(id) ON DELETE SET NULL,
  actor        text NOT NULL CHECK (actor IN ('pro', 'family')),
  action       text NOT NULL,
  scope        text NOT NULL DEFAULT '',
  at           timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('care_access_log');

-- Append-only: no edits; deletes only when the whole household is being deleted
-- (cascade), and FK columns may be nulled when a grant/user/member goes away.
CREATE FUNCTION care_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) THEN
      RAISE EXCEPTION 'care_access_log is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.actor <> OLD.actor OR NEW.action <> OLD.action OR NEW.scope <> OLD.scope OR NEW.at <> OLD.at
     OR NEW.household_id <> OLD.household_id
     OR (NEW.grant_id IS NOT NULL AND NEW.grant_id IS DISTINCT FROM OLD.grant_id)
     OR (NEW.pro_user_id IS NOT NULL AND NEW.pro_user_id IS DISTINCT FROM OLD.pro_user_id)
     OR (NEW.member_id IS NOT NULL AND NEW.member_id IS DISTINCT FROM OLD.member_id) THEN
    RAISE EXCEPTION 'care_access_log is append-only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER care_access_log_append_only BEFORE UPDATE OR DELETE ON care_access_log
  FOR EACH ROW EXECUTE FUNCTION care_log_append_only();
