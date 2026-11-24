CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reader_invite_hash_idx ON reader_invites (code_hash);
