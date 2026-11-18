CREATE TABLE round_comparisons (
    round_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    review_ciphertext MEDIUMBLOB NOT NULL,
    FOREIGN KEY (round_id) REFERENCES rounds(id)
);

ALTER TABLE rounds
    ADD COLUMN terminal_reason VARCHAR(32),
    ADD INDEX round_stage_deadline (stage, deadline_at, id);
