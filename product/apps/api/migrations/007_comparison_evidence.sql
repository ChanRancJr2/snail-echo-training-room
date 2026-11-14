ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_quote_ciphertext bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_quote_nonce bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS listener_quote_key_ref uuid;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS clarification_ciphertext bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS clarification_nonce bytea;
ALTER TABLE comparison_items ADD COLUMN IF NOT EXISTS clarification_key_ref uuid;
