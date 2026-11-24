ALTER TABLE reader_users ADD COLUMN IF NOT EXISTS inactivity_deadline_at timestamptz;
