-- Weibo accounts get their own channel ('weibo') like X posts have: social cards, and same-account
-- launch-day reposts fold into the account's latest post. The old check admits only news and x.
ALTER TABLE publications DROP CONSTRAINT IF EXISTS publications_channel_check;
