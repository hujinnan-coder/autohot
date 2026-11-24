CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_session_user_idx ON reader_sessions (user_id, created_at, id_hash);
