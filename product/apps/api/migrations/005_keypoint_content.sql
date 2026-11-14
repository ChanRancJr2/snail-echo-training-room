ALTER TABLE key_points ADD COLUMN IF NOT EXISTS content_ciphertext bytea;
ALTER TABLE key_points ADD COLUMN IF NOT EXISTS nonce bytea;
ALTER TABLE key_points ADD COLUMN IF NOT EXISTS key_ref uuid;
ALTER TABLE key_points ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai'));
