CREATE TABLE audio_deletion_queue (
  object_key text PRIMARY KEY,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX audio_deletion_due ON audio_deletion_queue (available_at);
