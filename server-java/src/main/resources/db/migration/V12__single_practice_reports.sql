CREATE TABLE single_practice_reports (
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    material_id VARCHAR(16) NOT NULL,
    duration_seconds INT NOT NULL,
    transcript_source ENUM('demo', 'manual') NOT NULL,
    complete INT NOT NULL,
    accurate INT NOT NULL,
    total INT NOT NULL,
    accepted BOOLEAN NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (session_id, id),
    INDEX single_practice_recent (session_id, created_at DESC, id),
    FOREIGN KEY (session_id) REFERENCES anonymous_sessions(id),
    CHECK (duration_seconds IN (30, 60, 120, 300)),
    CHECK (0 <= accurate AND accurate <= complete AND complete <= total AND total <= 12)
) DEFAULT CHARACTER SET utf8mb4;
