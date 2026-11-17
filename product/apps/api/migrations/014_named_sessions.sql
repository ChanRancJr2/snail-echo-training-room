BEGIN;

ALTER TABLE sessions ADD COLUMN named boolean NOT NULL DEFAULT FALSE;
UPDATE sessions SET named = TRUE WHERE nickname <> '访客';

COMMIT;
