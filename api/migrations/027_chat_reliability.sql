-- Ask Hana reliability (Oct 2026). When the AI call failed, the person's
-- message had already been saved and the screen put the text back in the box,
-- so every retry saved another copy.
--   client_id: one id per message from the phone, so a retry reuses the row.
--   failed:    Hana couldn't answer it; the screen shows Retry under it.
ALTER TABLE chat_messages ADD COLUMN client_id text;
ALTER TABLE chat_messages ADD COLUMN failed boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX chat_messages_client ON chat_messages (member_id, mode, client_id) WHERE client_id IS NOT NULL;

-- Tidy what piled up: repeated copies of the same unanswered message (no
-- reply in between) collapse to the last copy, and what's left unanswered is
-- marked so it shows Retry.
WITH seq AS (
  SELECT id, who, text,
         lead(who) OVER w AS next_who, lead(text) OVER w AS next_text
    FROM chat_messages WINDOW w AS (PARTITION BY member_id, mode ORDER BY id)
)
DELETE FROM chat_messages c USING seq
 WHERE c.id = seq.id AND seq.who = 'user' AND seq.next_who = 'user' AND seq.next_text = seq.text;

WITH seq AS (
  SELECT id, who, lead(who) OVER (PARTITION BY member_id, mode ORDER BY id) AS next_who FROM chat_messages
)
UPDATE chat_messages c SET failed = true
  FROM seq
 WHERE c.id = seq.id AND seq.who = 'user' AND seq.next_who IS DISTINCT FROM 'hana';
