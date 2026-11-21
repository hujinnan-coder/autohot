// From the repo root: node --env-file=.env modules/weibo-monitor/scripts/fill-avatars.ts
import { readFile } from "node:fs/promises";
import { closeDb, sql } from "@aihot/backend/db";

const path = "/tmp/weibo-avatars.json";

try {
  const avatars = Object.entries(JSON.parse(await readFile(path, "utf8")) as Record<string, { name: string; avatar: string }>);
  if (!avatars.length) throw new Error(`No Weibo avatars in ${path}`);
  for (const [uid, entry] of avatars) {
    if (!/^\d+$/.test(uid) || typeof entry?.name !== "string" || typeof entry.avatar !== "string"
        || !/^https?:\/\//i.test(entry.avatar) || !URL.canParse(entry.avatar)) {
      throw new Error(`Invalid Weibo avatar entry for UID ${uid} in ${path}`);
    }
  }

  const matches = await sql.begin(async tx => {
    const rows = [];
    for (const [uid, { name, avatar }] of avatars) {
      const result = await tx`
        UPDATE sources SET icon_url = ${avatar}
        WHERE id = ${`weibo-${uid}`} OR id = ${`weibopage-${uid}`}`;
      rows.push({ uid, name, count: result.count });
    }
    return rows;
  });

  let total = 0;
  for (const { uid, name, count } of matches) {
    const message = `${uid} ${name}: ${count} row(s) matched (expected 2)`;
    if (count === 2) {
      console.log(message);
    } else {
      console.warn(message);
      process.exitCode = 1;
    }
    total += count;
  }
  console.log(`Weibo avatars: ${total}/${avatars.length * 2} rows matched across ${avatars.length} UIDs`);
} finally {
  await closeDb();
}
