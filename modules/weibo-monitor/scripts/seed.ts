// After migrations: node --env-file-if-exists=.env modules/weibo-monitor/scripts/seed.ts
import { closeDb, sql } from "@aihot/backend/db";
import { accounts, initialDueAccounts } from "../backend/accounts.ts";

const sources = [...accounts].map(([id, account]) => ({
  id,
  name: `${account.name}（微博）`,
  kind: "external",
  tier: "T2",
  participation_mode: "editorial",
  tags: ["高管", "微博"],
  site_fulltext: false,
}));

try {
  const added = await sql.begin(async tx => {
    const inserted = await tx`
      INSERT INTO sources ${tx(sources, "id", "name", "kind", "tier", "participation_mode", "tags", "site_fulltext")}
      ON CONFLICT (id) DO NOTHING`;
    const due = initialDueAccounts(new Date()).map(({ sourceId, nextDueAt }) => [sourceId, nextDueAt.toISOString()]);
    await tx`
      INSERT INTO weibo_monitor_due (source_id, next_due_at)
      SELECT s.id, d.next_due_at::timestamptz FROM (VALUES ${tx(due)}) AS d(source_id, next_due_at)
      JOIN sources s ON s.id = d.source_id AND s.kind = 'external'
      ON CONFLICT (source_id) DO NOTHING`;
    return inserted.count;
  });
  console.log(`Weibo sources: ${added} added, ${accounts.size - added} already there`);
} finally {
  await closeDb();
}
