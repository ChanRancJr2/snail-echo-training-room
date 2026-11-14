ALTER TABLE rooms ADD COLUMN IF NOT EXISTS create_key text;
CREATE UNIQUE INDEX IF NOT EXISTS rooms_create_once_idx ON rooms (created_by, create_key) WHERE create_key IS NOT NULL;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT false;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'listener' CHECK (role IN ('listener', 'observer'));
