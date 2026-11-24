CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reader_identity_user_provider_uidx ON reader_auth_identities (user_id, provider);
