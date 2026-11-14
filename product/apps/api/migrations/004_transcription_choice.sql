ALTER TABLE audio_assets ADD COLUMN IF NOT EXISTS transcription_requested boolean NOT NULL DEFAULT false;
