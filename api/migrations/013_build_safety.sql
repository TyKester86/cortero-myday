-- Evidence-based builds (docs: "Evidence for the nine body builds").
-- Inputs for Mifflin-St Jeor + reference weight, the safety gates, the
-- calorie recalibration, flexible deloads and paused cuts.
ALTER TABLE health_profiles
  ADD COLUMN IF NOT EXISTS sex text CHECK (sex IS NULL OR sex IN ('male', 'female')),
  ADD COLUMN IF NOT EXISTS height_in numeric,
  ADD COLUMN IF NOT EXISTS activity text NOT NULL DEFAULT 'moderate'
    CHECK (activity IN ('sedentary', 'light', 'moderate', 'very')),
  ADD COLUMN IF NOT EXISTS goal_weight_lb numeric,
  ADD COLUMN IF NOT EXISTS life_stage text NOT NULL DEFAULT 'none'
    CHECK (life_stage IN ('none', 'pregnant', 'postpartum')),
  ADD COLUMN IF NOT EXISTS clinician_cleared boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_with_cut boolean NOT NULL DEFAULT false,
  -- Weigh-ins are opt-in and only ever shown as a 7-day average.
  ADD COLUMN IF NOT EXISTS weigh_ins boolean NOT NULL DEFAULT false,
  -- Every-2-weeks recalibration from the weigh-in trend (kcal/day added to the estimate).
  ADD COLUMN IF NOT EXISTS calorie_adjust integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS calibrated_on date,
  -- Stop rule: leanness goals paused (reason shown; resuming needs a clinician's OK for red flags).
  ADD COLUMN IF NOT EXISTS cut_paused text,
  -- "I need a break" / diet break: maintenance calories until this date.
  ADD COLUMN IF NOT EXISTS diet_break_until date,
  -- Flexible deload: this ISO week (Monday) runs at deload dosing.
  ADD COLUMN IF NOT EXISTS deload_week date,
  ADD COLUMN IF NOT EXISTS shredded_ack timestamptz;

-- Opt-in weigh-ins: one per day; the API only returns 7-day averages.
CREATE TABLE IF NOT EXISTS weigh_ins (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  day        date NOT NULL,
  weight_lb  numeric NOT NULL CHECK (weight_lb BETWEEN 50 AND 700),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, day)
);
SELECT myday_tenant('weigh_ins');

-- The 4-weekly body check-in (periods, bone injury, energy, food, sleep, aches).
CREATE TABLE IF NOT EXISTS body_checkins (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  taken_on   date NOT NULL,
  answers    jsonb NOT NULL DEFAULT '{}'::jsonb,
  flags      text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS body_checkins_member_idx ON body_checkins (member_id, taken_on);
SELECT myday_tenant('body_checkins');

-- Runs can carry a distance (the progression cap works on minutes or miles).
ALTER TABLE workout_logs ADD COLUMN IF NOT EXISTS miles numeric;
