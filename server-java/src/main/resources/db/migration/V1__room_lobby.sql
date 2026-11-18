CREATE TABLE anonymous_sessions (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    nickname VARCHAR(20) NOT NULL,
    expires_at TIMESTAMP(6) NOT NULL
);

CREATE TABLE rooms (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    owner_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    create_key VARCHAR(100) COLLATE utf8mb4_0900_bin NOT NULL,
    status ENUM('WAITING', 'ACTIVE', 'CLOSED') NOT NULL DEFAULT 'WAITING',
    duration_seconds INT NOT NULL,
    retell_style ENUM('auditory', 'keywords') NOT NULL,
    topic VARCHAR(80) NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    UNIQUE (owner_id, create_key),
    FOREIGN KEY (owner_id) REFERENCES anonymous_sessions(id),
    CHECK (duration_seconds IN (30, 60, 120, 300))
) DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE invitations (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
    role ENUM('listener', 'observer') NOT NULL,
    password_hash VARCHAR(100),
    expires_at TIMESTAMP(6) NOT NULL,
    max_uses INT NOT NULL,
    use_count INT NOT NULL DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    CHECK (use_count >= 0 AND use_count <= max_uses)
);

CREATE TABLE room_members (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role ENUM('speaker', 'listener', 'observer') NOT NULL,
    ready BOOLEAN NOT NULL DEFAULT FALSE,
    invitation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin,
    UNIQUE (room_id, session_id),
    UNIQUE (room_id, role),
    FOREIGN KEY (room_id) REFERENCES rooms(id),
    FOREIGN KEY (session_id) REFERENCES anonymous_sessions(id),
    FOREIGN KEY (invitation_id) REFERENCES invitations(id)
);

CREATE TABLE rounds (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    room_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sequence_no INT NOT NULL,
    stage VARCHAR(32) NOT NULL,
    deadline_at TIMESTAMP(6),
    version BIGINT NOT NULL DEFAULT 1,
    UNIQUE (room_id, sequence_no),
    FOREIGN KEY (room_id) REFERENCES rooms(id)
);
