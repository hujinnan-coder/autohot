ALTER TABLE reader_users ADD COLUMN IF NOT EXISTS inactivity_final_notified_at timestamptz;
