CREATE TABLE IF NOT EXISTS reader_otps (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  ip_key text NOT NULL,
  code_hash text,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  ticket_hash text,
  ticket_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
