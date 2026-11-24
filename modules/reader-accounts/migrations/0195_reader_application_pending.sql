CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reader_application_pending_idx ON reader_applications (email) WHERE status = 'pending';
