CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_login_user_idx ON reader_login_log (user_id, created_at);
