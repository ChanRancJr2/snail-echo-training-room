CREATE TABLE rewrite_advice (
    scope_id VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    input_data BLOB NULL,
    result_data BLOB NULL,
    lease CHAR(36) NULL,
    next_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    INDEX rewrite_advice_due (next_at, scope_id)
) DEFAULT CHARACTER SET utf8mb4;
