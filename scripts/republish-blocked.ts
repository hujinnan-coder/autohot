// 用法：node scripts/republish-blocked.ts
//
// 队列路径（jobs/publication.ts）在每个信源的 reduced > 0 时重排热榜。
// 本脚本在全部信源处理完之后重排一次，热榜同样反映最终状态，也省去逐源重排。
// sourceRepublished 仍与队列一致，在每个有投影的信源处理完后发出。
import { closeDb, sql } from "@aihot/backend/db";
import { computeHotRanking } from "@aihot/backend/events/hot";
import { emit, installModules } from "@aihot/backend/modules";
import { republishSource } from "@aihot/backend/publication/publish";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
try {
  const sources = await sql<{ id: string }[]>`SELECT id FROM sources WHERE participation_mode = 'editorial'`;
  let reduced = 0;
  for (const s of sources) {
    const r = await republishSource(s.id);
    reduced += r.reduced;
    if (r.total > 0) await emit("sourceRepublished", { sourceId: s.id });
    console.log(s.id, r);
  }
  // 撤回发生后立即更新热榜，避免仍引用旧条目直到下一次定时重排。
  if (reduced > 0) await computeHotRanking();
} finally {
  await closeDb();
}
