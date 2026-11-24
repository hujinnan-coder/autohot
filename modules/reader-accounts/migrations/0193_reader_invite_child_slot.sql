CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reader_invite_child_slot_idx ON reader_invites (issuer_reader_id, child_slot) WHERE revoked_at IS NULL;
