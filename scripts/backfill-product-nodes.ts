// 用法：node --env-file-if-exists=.env scripts/backfill-product-nodes.ts
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { modelFor } from "../packages/backend/src/editorial/models.ts";
import { promptText, promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { DigestSchema } from "../packages/backend/src/events/digest.ts";
import { logError } from "../packages/backend/src/lib/log-error.ts";
import { chatJson } from "../packages/backend/src/providers/llm.ts";
import { completeReceipt } from "../packages/backend/src/providers/receipts.ts";
import { pmap } from "./eval-tools.ts";

const started = performance.now();
const system = promptText("product-node");
const version = promptVersion("product-node");
const schema = DigestSchema.pick({ productKey: true, majorNode: true });
let failed = 0;
try {
  const stories = await sql<{ id: number; title: string }[]>`
    SELECT id, title FROM stories
    WHERE merged_into IS NULL AND product_key IS NULL AND latest_at > now() - interval '12 days'
    ORDER BY id`;
  const counts = await pmap(stories, 3, async ({ id, title }) => {
    try {
      const facts = await sql<{ subject: string | null; action: string | null; object: string | null }[]>`
        SELECT subject, action, object FROM facts WHERE story_id = ${id} ORDER BY id LIMIT 20`;
      const user = `事件标题：${title}\n事实清单：\n${facts.map((fact) => JSON.stringify(fact)).join("\n")}`;
      const res = await chatJson({
        model: await modelFor("digest"), purpose: "product_node", subject: `product:${id}`, promptVersion: version,
        system, user, schema, temperature: 0.1, maxTokens: 200,
      });
      return await sql.begin(async (tx) => {
        const updated = await tx`UPDATE stories SET product_key = ${res.data.productKey}, major_node = ${res.data.majorNode}
          WHERE id = ${id} AND merged_into IS NULL AND product_key IS NULL`;
        await completeReceipt(tx, res.receiptId);
        return updated.count;
      });
    } catch (error) {
      failed++;
      console.error(`事件 ${id} 回填失败`, logError(error));
      return 0;
    }
  });
  const processed = counts.reduce((total, count) => total + count, 0);
  console.log(`已处理 ${processed}/${stories.length} 条，失败 ${failed} 条，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await closeDb();
}
