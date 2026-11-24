CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_event_retention_idx ON reader_events (created_at);
