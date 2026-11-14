BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  nickname varchar(20) NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('sync', 'solo', 'teen', 'async')),
  status text NOT NULL CHECK (status IN ('WAITING', 'ACTIVE', 'CLOSED')),
  created_by uuid NOT NULL REFERENCES sessions(id),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS room_members (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  role text NOT NULL CHECK (role IN ('speaker', 'listener', 'observer')),
  active boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_member_per_seat ON room_members (room_id, role) WHERE active;
CREATE INDEX IF NOT EXISTS room_members_session_idx ON room_members (session_id, room_id) WHERE active;

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  token_hash char(64) NOT NULL UNIQUE,
  password_hash text,
  expires_at timestamptz NOT NULL,
  max_uses integer NOT NULL CHECK (max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rounds (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  stage text NOT NULL CHECK (stage IN ('TASK', 'SPEAKER_RECORDING', 'KEYPOINT_CONFIRM', 'ASYNC_PENDING', 'LISTENER_RETELL', 'COMPARING', 'SPEAKER_LABELING', 'MUTUAL_CONFIRM', 'ADVICE', 'ARCHIVED', 'CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deadline_at timestamptz,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (room_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_round_per_room ON rounds (room_id) WHERE stage NOT IN ('ARCHIVED', 'CANCELLED');
CREATE INDEX IF NOT EXISTS rounds_due_idx ON rounds (deadline_at) WHERE deadline_at IS NOT NULL AND stage NOT IN ('ARCHIVED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS audio_assets (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES rounds(id),
  member_id uuid NOT NULL REFERENCES room_members(id),
  kind text NOT NULL CHECK (kind IN ('speaker', 'listener')),
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 char(64),
  state text NOT NULL CHECK (state IN ('PENDING', 'COMMITTED', 'DELETING', 'DELETED')),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (round_id, member_id, kind, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_committed_audio_per_role ON audio_assets (round_id, kind) WHERE state = 'COMMITTED';

CREATE TABLE IF NOT EXISTS transcripts (
  id uuid PRIMARY KEY,
  audio_id uuid NOT NULL UNIQUE REFERENCES audio_assets(id),
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  key_ref uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS key_points (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES rounds(id),
  category text NOT NULL CHECK (category IN ('人物', '事件', '需求', '情绪', '因果', '重点', '时间')),
  position integer NOT NULL CHECK (position >= 0),
  original_span_start integer,
  original_span_end integer,
  confirmed_by uuid REFERENCES room_members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, position)
);

CREATE TABLE IF NOT EXISTS comparison_items (
  id uuid PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES rounds(id),
  key_point_id uuid NOT NULL REFERENCES key_points(id),
  complete boolean,
  accurate boolean,
  tag text,
  resolution text CHECK (resolution IN ('misunderstanding', 'expression', 'ai_error')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, key_point_id)
);

CREATE TABLE IF NOT EXISTS confirmations (
  item_id uuid NOT NULL REFERENCES comparison_items(id),
  member_id uuid NOT NULL REFERENCES room_members(id),
  role text NOT NULL CHECK (role IN ('speaker', 'listener')),
  revision integer NOT NULL CHECK (revision > 0),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, role)
);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES sessions(id),
  scope text NOT NULL CHECK (scope IN ('round', 'room', 'all')),
  target_id uuid,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

COMMIT;
