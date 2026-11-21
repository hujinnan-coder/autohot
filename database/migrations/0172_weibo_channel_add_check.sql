-- Re-added NOT VALID so existing rows (all news/x) are admitted without a scan; 0173 validates.
ALTER TABLE publications ADD CONSTRAINT publications_channel_check CHECK (channel IN ('news', 'x', 'weibo')) NOT VALID;
