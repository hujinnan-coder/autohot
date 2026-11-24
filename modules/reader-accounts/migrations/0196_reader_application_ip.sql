CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_application_ip_idx ON reader_applications (ip_key, created_at DESC) WHERE ip_key IS NOT NULL;
