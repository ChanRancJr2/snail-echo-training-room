ALTER TABLE anonymous_sessions ADD COLUMN named BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE anonymous_sessions SET named = TRUE WHERE nickname <> '访客';
