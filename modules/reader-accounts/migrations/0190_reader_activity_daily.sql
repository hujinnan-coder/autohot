CREATE TABLE IF NOT EXISTS reader_activity_daily (
  user_id uuid NOT NULL REFERENCES reader_users(id) ON DELETE CASCADE,
  day date NOT NULL,
  PRIMARY KEY (user_id, day)
);
