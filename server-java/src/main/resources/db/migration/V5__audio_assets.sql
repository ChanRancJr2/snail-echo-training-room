CREATE TABLE audio_assets (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind ENUM('speaker', 'listener') NOT NULL,
    mime_type VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    byte_size INT NOT NULL,
    idempotency_key VARCHAR(100) COLLATE utf8mb4_0900_bin NOT NULL,
    round_version BIGINT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    object_key VARCHAR(180) CHARACTER SET ascii COLLATE ascii_bin,
    committed_at TIMESTAMP(6),
    committed_kind VARCHAR(8) GENERATED ALWAYS AS (IF(object_key IS NULL, NULL, kind)) STORED,
    UNIQUE (round_id, kind, idempotency_key),
    UNIQUE (round_id, committed_kind),
    FOREIGN KEY (round_id) REFERENCES rounds(id),
    FOREIGN KEY (session_id) REFERENCES anonymous_sessions(id),
    CHECK (byte_size BETWEEN 64 AND 15000000)
) DEFAULT CHARACTER SET utf8mb4;

ALTER TABLE rounds
    ADD COLUMN speaker_audio_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    ADD COLUMN listener_audio_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin;
