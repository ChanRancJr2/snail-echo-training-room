CREATE TABLE room_material_consents (
    audio_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    consented_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (audio_id) REFERENCES audio_assets(id),
    FOREIGN KEY (session_id) REFERENCES anonymous_sessions(id)
) DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE single_practice_material_candidates (
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    report_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    object_key VARCHAR(180) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    mime_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    byte_size INT NOT NULL,
    consented_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (session_id, report_id),
    FOREIGN KEY (session_id, report_id) REFERENCES single_practice_reports(session_id, id),
    CHECK (byte_size BETWEEN 64 AND 15000000)
) DEFAULT CHARACTER SET utf8mb4;
