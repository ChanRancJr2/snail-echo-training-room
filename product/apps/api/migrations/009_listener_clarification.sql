ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_note_ciphertext bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_note_nonce bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_note_key_ref uuid;
