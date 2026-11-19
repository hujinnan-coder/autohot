-- The owner's labels for calibrating 精选 (modules/labeling): one per article. The material is kept as it was
-- labeled, so a sample outlives the article's retention and the eval reads exactly what was judged.
CREATE TABLE IF NOT EXISTS labeling_marks (
  article_id text PRIMARY KEY,
  decision text NOT NULL CHECK (decision IN ('select', 'reject', 'either')),
  value text CHECK (value IN ('decision', 'topic', 'both')),
  note text,
  category text,
  material jsonb NOT NULL,
  source_facts jsonb NOT NULL,
  labeled_by text NOT NULL,
  labeled_at timestamptz NOT NULL DEFAULT now()
);
