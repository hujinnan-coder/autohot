CREATE TABLE IF NOT EXISTS reader_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('active', 'pending', 'disabled')),
  name text NOT NULL,
  company text NOT NULL,
  job_title text NOT NULL,
  wechat text NOT NULL,
  business_card_url text,
  referrer text,
  phone text,
  phone_verified_at timestamptz,
  wechat_openid text,
  wechat_unionid text,
  tracking_consent boolean NOT NULL,
  activated_at timestamptz,
  last_active_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
