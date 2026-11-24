CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_otp_email_idx ON reader_otps (email, created_at DESC);
