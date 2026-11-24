CREATE TABLE IF NOT EXISTS reader_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  company text NOT NULL,
  job_title text NOT NULL,
  wechat text NOT NULL,
  reason text NOT NULL,
  referrer text,
  ip_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_reason text,
  decided_at timestamptz,
  approved_invite_id uuid REFERENCES reader_invites(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
