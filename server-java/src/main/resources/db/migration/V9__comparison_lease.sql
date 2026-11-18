ALTER TABLE rounds
    ADD COLUMN comparison_attempts SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN comparison_available_at TIMESTAMP(6) NULL,
    ADD COLUMN comparison_lease CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
