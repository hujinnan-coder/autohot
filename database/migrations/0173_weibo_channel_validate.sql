-- Existing rows are news/x and satisfy the widened check; new weibo rows pass it by construction.
ALTER TABLE publications VALIDATE CONSTRAINT publications_channel_check;
