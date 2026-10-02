-- Retired: a distinct signup life-stage (shares the couple icon with empty nesters).
ALTER TABLE households DROP CONSTRAINT IF EXISTS households_type_check;
ALTER TABLE households ADD CONSTRAINT households_type_check
  CHECK (type IN ('family', 'solo', 'couple', 'empty_nesters', 'retired', 'college'));
