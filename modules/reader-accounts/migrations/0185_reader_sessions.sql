CREATE TABLE IF NOT EXISTS reader_sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
