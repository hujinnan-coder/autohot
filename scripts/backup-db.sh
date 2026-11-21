#!/bin/sh
# 每日数据库备份：autohot 库 -> ~/Backups/autohot/，保留 14 天。由 crontab 03:05 调用。
set -e
DIR="$HOME/Backups/autohot"
mkdir -p "$DIR"
/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump \
  --format=custom --compress=6 --no-owner \
  --file "$DIR/autohot-$(date +%Y%m%d).dump" \
  "postgres://huxiaohu@127.0.0.1:5432/autohot"
find "$DIR" -name "autohot-*.dump" -mtime +14 -delete
echo "$(date '+%F %T') backup ok: $(ls -t "$DIR" | head -1)"
