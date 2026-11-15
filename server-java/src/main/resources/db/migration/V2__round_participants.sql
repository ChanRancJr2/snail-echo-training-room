ALTER TABLE rounds
    ADD COLUMN speaker_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    ADD COLUMN listener_session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    ADD COLUMN focus VARCHAR(80) NOT NULL DEFAULT '';

UPDATE rounds r
JOIN rooms room ON room.id = r.room_id
LEFT JOIN room_members listener ON listener.room_id = r.room_id AND listener.role = 'listener'
SET r.speaker_session_id = room.owner_id,
    r.listener_session_id = listener.session_id;
