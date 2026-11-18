ALTER TABLE rooms
    ADD COLUMN mode ENUM('sync', 'solo', 'teen', 'async') NOT NULL DEFAULT 'sync',
    ADD COLUMN teen_nickname VARCHAR(12),
    ADD COLUMN teen_role ENUM('speaker', 'listener'),
    ADD CONSTRAINT room_teen_settings CHECK (
        (mode = 'teen' AND teen_nickname IS NOT NULL AND teen_role IS NOT NULL)
        OR (mode <> 'teen' AND teen_nickname IS NULL AND teen_role IS NULL)
    );

ALTER TABLE rounds ADD COLUMN teen_role ENUM('speaker', 'listener');
