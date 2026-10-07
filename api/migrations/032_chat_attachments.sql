-- Ask Hana: photos and files attached to a message. Stored in the person's own
-- account, sealed at rest (lib/seal.ts), served only to them. Images and PDFs
-- go to Hana with the message so she can see and discuss them.
CREATE TABLE chat_attachments (
  id          serial PRIMARY KEY,
  member_id   integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  data_enc    bytea NOT NULL,
  key_id      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
SELECT myday_tenant('chat_attachments');
CREATE INDEX chat_attachments_member ON chat_attachments (member_id, id DESC);

ALTER TABLE chat_messages ADD COLUMN attachment_ids integer[] NOT NULL DEFAULT '{}';
