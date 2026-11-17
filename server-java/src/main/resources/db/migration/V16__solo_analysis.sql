CREATE TABLE solo_analysis (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    material_id VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    status ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending',
    transcript BLOB NULL,
    result MEDIUMBLOB NULL,
    audio_key VARCHAR(160) NULL,
    provider_started BOOLEAN NOT NULL DEFAULT FALSE,
    provider_task VARCHAR(128) NULL,
    failure VARCHAR(32) NULL,
    lease CHAR(36) NULL,
    next_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX solo_due (status, next_at, id),
    INDEX solo_owner (session_id, status),
    FOREIGN KEY (session_id) REFERENCES anonymous_sessions(id)
) DEFAULT CHARACTER SET utf8mb4;

ALTER TABLE single_practice_reports
    MODIFY transcript_source ENUM('demo','manual','asr') NOT NULL,
    DROP CHECK single_practice_reports_chk_2,
    ADD CONSTRAINT practice_independent_scores CHECK
        (0 <= accurate AND accurate <= total AND 0 <= complete AND complete <= total AND total <= 12);
