ALTER TABLE invitations ADD COLUMN code text CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$');
CREATE UNIQUE INDEX invitations_code_unique ON invitations (code) WHERE code IS NOT NULL;
ALTER TABLE room_members ADD COLUMN joined_invitation_id uuid REFERENCES invitations(id);
