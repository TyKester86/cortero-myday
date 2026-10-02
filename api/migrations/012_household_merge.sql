-- Household merges / moving a person between households must carry the
-- append-only care-access log along (it stays append-only otherwise):
-- household_id may change only inside a merge transaction (app.merging = on).
CREATE OR REPLACE FUNCTION care_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM households WHERE id = OLD.household_id) THEN
      RAISE EXCEPTION 'care_access_log is append-only';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.actor <> OLD.actor OR NEW.action <> OLD.action OR NEW.scope <> OLD.scope OR NEW.at <> OLD.at
     OR (NEW.household_id <> OLD.household_id AND current_setting('app.merging', true) IS DISTINCT FROM 'on')
     OR (NEW.grant_id IS NOT NULL AND NEW.grant_id IS DISTINCT FROM OLD.grant_id)
     OR (NEW.pro_user_id IS NOT NULL AND NEW.pro_user_id IS DISTINCT FROM OLD.pro_user_id)
     OR (NEW.member_id IS NOT NULL AND NEW.member_id IS DISTINCT FROM OLD.member_id
         AND current_setting('app.merging', true) IS DISTINCT FROM 'on') THEN
    RAISE EXCEPTION 'care_access_log is append-only';
  END IF;
  RETURN NEW;
END $$;
