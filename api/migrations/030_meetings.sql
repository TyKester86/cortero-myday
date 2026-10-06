-- Meetings (grown-ups only): a recording becomes a transcript and AI notes —
-- summary, decisions, action items (owner + due), follow-ups. Private to the
-- person who recorded it. Transcript and notes are sealed at rest
-- (lib/seal.ts). The audio is kept until notes are made, so a failed step can
-- be retried and a recording is never lost; it's deleted once notes exist.
CREATE TABLE meetings (
  id              serial PRIMARY KEY,
  member_id       integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT '',
  title_edited    boolean NOT NULL DEFAULT false,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  duration_s      integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'transcribing', 'structuring', 'ready', 'failed')),
  error           text NOT NULL DEFAULT '',
  audio_path      text,
  audio_mime      text NOT NULL DEFAULT 'audio/webm',
  transcript_enc  bytea,
  notes_enc       bytea,
  key_id          text NOT NULL,
  client_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, client_id)
);
SELECT myday_tenant('meetings');
CREATE INDEX meetings_member ON meetings (member_id, recorded_at DESC);
