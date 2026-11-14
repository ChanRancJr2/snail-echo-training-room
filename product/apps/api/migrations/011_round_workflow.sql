CREATE TABLE round_task_focus (
  round_id uuid PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_ref uuid NOT NULL
);

CREATE TABLE round_listening_aids (
  round_id uuid PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  replay_used boolean NOT NULL DEFAULT false,
  keywords_used boolean NOT NULL DEFAULT false
);

ALTER TABLE comparison_items
  ADD COLUMN observer_note_ciphertext bytea,
  ADD COLUMN observer_note_nonce bytea,
  ADD COLUMN observer_note_key_ref uuid,
  ADD COLUMN observer_tag text;
