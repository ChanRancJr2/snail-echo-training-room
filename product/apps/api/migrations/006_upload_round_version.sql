ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS round_version bigint NOT NULL DEFAULT 1 CHECK (round_version > 0);
