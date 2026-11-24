CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reader_otp_ticket_idx ON reader_otps (ticket_hash) WHERE ticket_hash IS NOT NULL;
