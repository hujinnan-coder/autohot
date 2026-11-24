CREATE TABLE IF NOT EXISTS reader_consents (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('terms', 'privacy', 'tracking')),
  version text NOT NULL,
  granted boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
