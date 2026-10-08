-- What Hana's tools actually did during a reply (e.g. "Add 34 chores → done: Added 34 of 34 chores…").
-- Not shown in the chat; given back to Hana with that reply in later turns, so she knows what she already
-- did instead of second-guessing it.
ALTER TABLE chat_messages ADD COLUMN tool_notes text;
