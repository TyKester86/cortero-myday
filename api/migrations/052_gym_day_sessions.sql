-- Workouts follow each person's chosen gym days and advance only when a session is
-- marked complete (a missed gym day holds position; nothing advances by calendar).
--
-- health_profiles.session_week / session_day: the next session to do (plan week + day_num).
--   NULL until first read, when it is pinned from the old calendar position.
-- health_profiles.gym_days_set: the person picked train_weekdays themselves, so a re-plan
--   keeps their days instead of the build's default.
-- workout_logs.plan_week / plan_day: which session a day_complete row completed.
ALTER TABLE health_profiles
  ADD COLUMN IF NOT EXISTS session_week smallint,
  ADD COLUMN IF NOT EXISTS session_day smallint,
  ADD COLUMN IF NOT EXISTS gym_days_set boolean NOT NULL DEFAULT false;

ALTER TABLE workout_logs
  ADD COLUMN IF NOT EXISTS plan_week smallint,
  ADD COLUMN IF NOT EXISTS plan_day smallint;
