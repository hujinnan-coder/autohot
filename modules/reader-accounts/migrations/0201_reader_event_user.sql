CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_event_user_idx ON reader_events (user_id, id DESC);
