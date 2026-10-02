-- Multi-household + row-level security + the append-only events table.
-- Every family-owned table gets household_id, defaulted from the connection's
-- app.household_id, and a policy so a connection only sees its own household
-- (or everything when app.system = 'on': sign-in lookups, migrations, CLI).

CREATE TABLE households (
  id                    serial PRIMARY KEY,
  name                  text NOT NULL,
  -- What kind of household (modules adapt): family | solo | couple | empty_nesters | college
  type                  text NOT NULL DEFAULT 'family'
    CHECK (type IN ('family', 'solo', 'couple', 'empty_nesters', 'college')),
  -- Short code kids type (with their name + PIN) on a device that doesn't know the family yet.
  code                  text NOT NULL UNIQUE,
  trial_ends_at         timestamptz,
  -- Household security gate: teens may only link a real bank once a grown-up turns this on.
  allow_teen_bank_link  boolean NOT NULL DEFAULT false,
  onboarding            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Existing single-family data becomes household 1.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM household_members) OR EXISTS (SELECT 1 FROM app_settings)
     OR EXISTS (SELECT 1 FROM grocery_staples) OR EXISTS (SELECT 1 FROM grocery_items)
     OR EXISTS (SELECT 1 FROM money_items) THEN
    INSERT INTO households (id, name, code) VALUES (1, 'Our family', upper(substr(md5(random()::text), 1, 6)));
    PERFORM setval(pg_get_serial_sequence('households', 'id'), 1);
  END IF;
END $$;

/* ---------- household_id + RLS on every family-owned table ---------- */

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'household_members', 'chores', 'chore_completions', 'homework', 'scores', 'health_profiles', 'workouts',
    'workout_logs', 'meal_plan_entries', 'grocery_items', 'grocery_staples', 'weekly_plans', 'xp_events',
    'rewards', 'redemptions', 'health_habits', 'app_settings', 'grocery_favorites', 'custom_stores', 'invites',
    'kid_devices', 'kid_device_members', 'kid_signins', 'curfews', 'partner_checkins', 'one_on_ones', 'checkins',
    'tasks', 'reviews', 'habits', 'habit_checks', 'dump_items', 'daily_scores', 'achievements', 'boss_battles',
    'red_alerts', 'chat_messages', 'money_items', 'money_accounts', 'money_transactions'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN household_id integer REFERENCES households(id) ON DELETE CASCADE', t);
    EXECUTE format('UPDATE %I SET household_id = 1', t);
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN household_id SET NOT NULL,
                      ALTER COLUMN household_id SET DEFAULT NULLIF(current_setting(''app.household_id'', true), '''')::int', t);
    EXECUTE format('CREATE INDEX %I ON %I (household_id)', t || '_household_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (household_id = NULLIF(current_setting(''app.household_id'', true), '''')::int
                OR current_setting(''app.system'', true) = ''on'')
         WITH CHECK (household_id = NULLIF(current_setting(''app.household_id'', true), '''')::int
                     OR current_setting(''app.system'', true) = ''on'')',
      t || '_tenant', t);
  END LOOP;
END $$;

-- Uniqueness that used to be global is now per household.
ALTER TABLE household_members DROP CONSTRAINT household_members_key_key;
CREATE UNIQUE INDEX household_members_household_key_idx ON household_members (household_id, key);
ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;
ALTER TABLE app_settings ADD PRIMARY KEY (household_id, key);
DROP INDEX custom_stores_name_idx;
CREATE UNIQUE INDEX custom_stores_name_idx ON custom_stores (household_id, lower(name));
DROP INDEX grocery_staples_item_idx;
CREATE UNIQUE INDEX grocery_staples_item_idx ON grocery_staples (household_id, lower(item));

/* ---------- events: append-only product history (launch cohorts) ---------- */

CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  household_id  integer REFERENCES households(id) ON DELETE SET NULL
                DEFAULT NULLIF(current_setting('app.household_id', true), '')::int,
  member_id     integer REFERENCES household_members(id) ON DELETE SET NULL,
  name          text NOT NULL,
  props         jsonb NOT NULL DEFAULT '{}'::jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_name_at_idx ON events (name, at);
CREATE INDEX events_household_idx ON events (household_id, at);
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY events_tenant ON events
  USING (household_id = NULLIF(current_setting('app.household_id', true), '')::int
         OR current_setting('app.system', true) = 'on')
  WITH CHECK (household_id IS NULL
              OR household_id = NULLIF(current_setting('app.household_id', true), '')::int
              OR current_setting('app.system', true) = 'on');
-- Append-only: nobody (including the app) may change or delete history.
-- (Foreign keys may still be nulled when a household/member row goes away.)
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'events is append-only';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.props IS DISTINCT FROM OLD.props OR NEW.at IS DISTINCT FROM OLD.at THEN
    RAISE EXCEPTION 'events is append-only';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();
