CREATE TABLE listener_engagement (
    round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    visit_id VARCHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    playback_ms INT NOT NULL,
    recording_attempts INT NOT NULL,
    dwell_ms INT NOT NULL,
    PRIMARY KEY (round_id, visit_id),
    FOREIGN KEY (round_id) REFERENCES rounds(id)
) DEFAULT CHARACTER SET utf8mb4;
