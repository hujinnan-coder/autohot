CREATE TABLE IF NOT EXISTS reader_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL,
  issuer text NOT NULL CHECK (issuer IN ('admin', 'reader')),
  issuer_reader_id uuid REFERENCES reader_users(id) ON DELETE SET NULL,
  child_slot integer,
  requires_approval boolean NOT NULL,
  bound_email text,
  batch_tag text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_by uuid REFERENCES reader_users(id) ON DELETE SET NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
