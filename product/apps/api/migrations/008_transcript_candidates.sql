ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS candidates_ciphertext bytea;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS candidates_nonce bytea;
