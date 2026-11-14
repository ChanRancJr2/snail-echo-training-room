CREATE TABLE guardian_seats (
  room_id uuid PRIMARY KEY REFERENCES rooms(id),
  session_id uuid NOT NULL REFERENCES sessions(id),
  nickname varchar(12) NOT NULL,
  child_role text NOT NULL CHECK (child_role IN ('speaker','listener')),
  pin_hash text NOT NULL,
  locked_round_id uuid REFERENCES rounds(id),
  completed_round_id uuid REFERENCES rounds(id),
  failed_attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz
);

CREATE UNIQUE INDEX guardian_active_handoff ON guardian_seats (session_id) WHERE locked_round_id IS NOT NULL;
