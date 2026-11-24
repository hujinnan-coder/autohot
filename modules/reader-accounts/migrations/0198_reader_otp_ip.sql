CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_otp_ip_idx ON reader_otps (ip_key, created_at DESC);
