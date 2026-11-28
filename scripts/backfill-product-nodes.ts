// 用法：node --env-file-if-exists=.env scripts/backfill-product-nodes.ts [--interval-ms=900]
// 一次性的存量回填：给最近 12 天还没有车型键的事件补 product_key 与 major_node。
// 请求按全局间隔节流（默认 900ms，约 67/分钟），给 worker 的正常任务留出 llm 每分钟预算；
// 撞上预算熔断就等满一分钟窗口再重试，最多 4 次。
import { closeDb, sql } from "../packages/backend/src/db.ts";
import { modelFor } from "../packages/backend/src/editorial/models.ts";
import { promptText, promptVersion } from "../packages/backend/src/editorial/prompts.ts";
import { DigestSchema } from "../packages/backend/src/events/digest.ts";
import { logError } from "../packages/backend/src/lib/log-error.ts";
import { chatJson } from "../packages/backend/src/providers/llm.ts";
import { completeReceipt } from "../packages/backend/src/providers/receipts.ts";
import { pmap } from "./eval-tools.ts";

const budgetMessage = (service: string, window: string) => `Budget for ${service} exhausted (${window})`;
const RETRIES = 4, RETRY_WAIT_MS = 65_000;
const intervalMs = Number(process.argv.find((a) => a.startsWith("--interval-ms="))?.split("=")[1]) || 900;

const started = performance.now();
const system = promptText("product-node");
const version = promptVersion("product-node");
const schema = DigestSchema.pick({ productKey: true, majorNode: true });
let failed = 0;
// 所有并发共享一个起跑线：每个请求的发出时刻至少隔 intervalMs，总速率不超过 1/interval。
let nextStart = 0;
const waitTurn = async () => {
  const now = performance.now();
  const at = Math.max(now, nextStart);
  nextStart = at + intervalMs;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
};
try {
  const stories = await sql<{ id: number; title: string }[]>`
    SELECT id, title FROM stories
    WHERE merged_into IS NULL AND product_key IS NULL AND latest_at > now() - interval '12 days'
    ORDER BY id`;
  const counts = await pmap(stories, 3, async ({ id, title }) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await waitTurn();
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
        // 预算是全服务共享的，worker 自己的采集与评分也在花：等窗口过去再试，别把事件判成失败。
        if (attempt < RETRIES && error instanceof Error && /Budget for \w+ exhausted/.test(error.message)) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
          continue;
        }
        failed++;
        console.error(`事件 ${id} 回填失败`, logError(error));
        return 0;
      }
    }
  });
  const processed = counts.reduce((total, count) => total + count, 0);
  console.log(`已处理 ${processed}/${stories.length} 条，失败 ${failed} 条，耗时 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await closeDb();
}
