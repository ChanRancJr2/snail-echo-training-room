ALTER TABLE transcription_jobs
    ADD COLUMN provider ENUM('mock', 'volc') NOT NULL DEFAULT 'mock',
    ADD COLUMN provider_started_at TIMESTAMP(6) NULL,
    ADD COLUMN provider_task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    ADD COLUMN artifact_cleanup_after TIMESTAMP(6) NULL,
    ADD INDEX transcription_cleanup_due (status, artifact_cleanup_after, audio_id),
    ADD INDEX transcription_provider_due (provider, status, available_at, audio_id);
