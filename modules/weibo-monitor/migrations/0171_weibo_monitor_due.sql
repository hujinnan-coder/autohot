CREATE TABLE IF NOT EXISTS weibo_monitor_due (
  source_id text PRIMARY KEY REFERENCES sources (id) ON DELETE CASCADE,
  next_due_at timestamptz NOT NULL
);
