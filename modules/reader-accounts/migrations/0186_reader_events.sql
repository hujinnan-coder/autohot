CREATE TABLE IF NOT EXISTS reader_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  target_id text,
  topic_slug text,
  brand_slug text,
  query text,
  dwell_bucket text,
  created_at timestamptz NOT NULL DEFAULT now()
);
