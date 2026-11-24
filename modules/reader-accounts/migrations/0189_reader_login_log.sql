CREATE TABLE IF NOT EXISTS reader_login_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  ip inet NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
