CREATE TABLE IF NOT EXISTS reader_event_daily (
  day date NOT NULL,
  kind text NOT NULL,
  event_count bigint NOT NULL,
  PRIMARY KEY (day, kind)
);
