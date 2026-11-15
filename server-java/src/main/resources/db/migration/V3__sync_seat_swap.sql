ALTER TABLE room_members
    MODIFY COLUMN role ENUM('speaker', 'listener', 'observer', 'swapping') NOT NULL;

ALTER TABLE invitations ADD COLUMN revoked_at TIMESTAMP(6) NULL;
