CREATE TABLE transcription_jobs (
    audio_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    attempts SMALLINT NOT NULL DEFAULT 0,
    available_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    result_ciphertext BLOB,
    INDEX transcription_job_due (status, available_at, audio_id),
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (audio_id) REFERENCES audio_assets(id)
);

INSERT INTO transcription_jobs (audio_id, round_id)
SELECT a.id, a.round_id FROM audio_assets a
JOIN rounds r ON r.id = a.round_id JOIN rooms room ON room.id = r.room_id
WHERE room.status = 'ACTIVE' AND a.object_key IS NOT NULL
  AND ((a.id = r.speaker_audio_id AND r.stage IN ('KEYPOINT_CONFIRM', 'LISTENER_RETELL', 'COMPARING'))
    OR (a.id = r.listener_audio_id AND r.stage = 'COMPARING'));

CREATE TABLE key_points (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    position SMALLINT NOT NULL,
    category VARCHAR(8) NOT NULL,
    content_ciphertext VARBINARY(1024) NOT NULL,
    UNIQUE (round_id, position),
    FOREIGN KEY (round_id) REFERENCES rounds(id)
) DEFAULT CHARACTER SET utf8mb4;

ALTER TABLE rounds
    ADD COLUMN replay_used BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN keywords_used BOOLEAN NOT NULL DEFAULT FALSE;
