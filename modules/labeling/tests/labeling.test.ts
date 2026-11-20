import assert from "node:assert/strict";
import { after, test } from "node:test";
import { tag } from "../../../tests/setup.ts";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { installModules } from "@aihot/backend/modules";
import { parseSelectionGoldJsonl } from "../../../scripts/eval-selection-core.ts";
import { buildApp } from "../../../apps/api/src/app.ts";
import { goldLines, labelingPage, markArticle, unmarkArticle } from "../backend/marks.ts";
import labeling from "../server.ts";

const T = tag();
const sourceId = `labeling-${T}`;
await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${sourceId}, '汽车媒体', 'rss', 'T2')`;
installModules([labeling]);
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

async function scored(title: string, score: number | null, relevance = "pass", fromSource = sourceId) {
  const { articleId } = await upsertMaterial({ sourceId: fromSource, url: `https://example.com/${tag()}`, title, bodyText: `${title}的正文`, bodyStatus: "ok", via: "fetch", publishedAt: new Date() });
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, output)
            VALUES (${articleId}, 1, 'rule', ${relevance}, 'market', ${title}, ${`${title}的摘要`}, ${score}, false, ${sql.json({ threshold: 76 })})`;
  return articleId;
}

const ids = (page: { items: Array<{ articleId: string }> }, of: string[]) => page.items.map((i) => i.articleId).filter((id) => of.includes(id));

test("the queue puts the cases nearest the threshold first, without the model's score, and leaves out blocked items", async () => {
  const far = await scored("低分快讯", 20);
  const near = await scored("贴着门槛的调价", 74);
  const high = await scored("购置税减半", 92);
  const blocked = await scored("显示器开售", null, "block");
  const page = await labelingPage({}, "csrf");
  assert.deepEqual(ids(page, [far, near, high, blocked]), [near, high, far]);
  assert.ok(page.items.every((i) => i.score === null && i.mark === null));

  const mid = await labelingPage({ band: "mid" }, "csrf");
  assert.deepEqual(ids(mid, [far, near, high]), []);
  const highBand = await labelingPage({ band: "high" }, "csrf");
  assert.deepEqual(ids(highBand, [far, near, high]), [near, high]);

  const aiSourceId = `${T}-ai`;
  const aiSourceName = "TechCrunch：AI";
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${aiSourceId}, ${aiSourceName}, 'rss', 'T2')`;
  const ai = await scored("新模型发布", 65, "pass", aiSourceId);
  const all = await labelingPage({}, "csrf");
  const filtered = await labelingPage({ source: aiSourceName, page: "2" }, "csrf");
  assert.deepEqual(filtered.items.map((i) => i.articleId), [ai]);
  assert.equal(filtered.page, 1);
  assert.equal(filtered.hasMore, false);
  assert.deepEqual(filtered.counts, all.counts);
  assert.deepEqual(filtered.sources, all.sources);
  assert.deepEqual(filtered.sources.filter((name) => name === "汽车媒体" || name === aiSourceName), ["汽车媒体", aiSourceName]);
  assert.equal(filtered.sourceCounts["汽车媒体"], 3);
  assert.equal(filtered.sourceCounts[aiSourceName], 1);
  assert.deepEqual((await labelingPage({ source: aiSourceName, band: "high" }, "csrf")).items, []);
  assert.ok(!(await labelingPage({ view: "done" }, "csrf")).sources.includes(aiSourceName));

  const unknown = await labelingPage({ source: "TechCrunch" }, "csrf");
  assert.deepEqual(unknown.items, []);
  assert.deepEqual(unknown.counts, all.counts);
  assert.deepEqual(unknown.sources, all.sources);
});

test("a label keeps the material as judged, shows the model's score after, and exports as a gold case", async () => {
  const id = await scored("欧盟调整对华电动车关税", 70);
  assert.equal(await markArticle(id, { decision: "select", value: "decision", note: "直接影响中国车企" }, "admin:1"), true);
  const done = await labelingPage({ view: "done" }, "csrf");
  const item = done.items.find((i) => i.articleId === id)!;
  assert.equal(item.score, 70);
  assert.equal(item.threshold, 76);
  assert.deepEqual({ decision: item.mark!.decision, value: item.mark!.value }, { decision: "select", value: "decision" });
  assert.ok(!(await labelingPage({}, "csrf")).items.some((i) => i.articleId === id));

  // The sample is the material as it was judged, whatever later becomes of the article.
  await sql`UPDATE articles SET title = '改过的标题', body_text = '改过的正文' WHERE id = ${id}`;
  const cases = parseSelectionGoldJsonl((await goldLines()).join("\n"));
  const gold = cases.find((c) => c.caseId === id)!;
  assert.equal(gold.gold.decision, "select");
  assert.equal(gold.material.title, "欧盟调整对华电动车关税");
  assert.equal(gold.material.bodyOriginal, "欧盟调整对华电动车关税的正文");
  assert.deepEqual(gold.sourceFacts, { sourceKind: "rss", sourceTier: "T2", firstParty: false, language: null });
  assert.equal(gold.samplingContext?.samplingStratum, "market");
});

test("relabeling replaces the label and undoing returns the item to the queue", async () => {
  const id = await scored("车企高管微博互怼", 60);
  await markArticle(id, { decision: "reject" }, "admin:1");
  await markArticle(id, { decision: "either", value: "topic" }, "admin:1");
  const [row] = await sql`SELECT decision, value FROM labeling_marks WHERE article_id = ${id}`;
  assert.deepEqual({ ...row }, { decision: "either", value: "topic" });
  assert.equal(await unmarkArticle(id), true);
  assert.ok((await labelingPage({ band: "mid" }, "csrf")).items.some((i) => i.articleId === id));
  await assert.rejects(markArticle(id, { decision: "maybe" }, "admin:1"));
  assert.equal(await markArticle("no-such-article", { decision: "select" }, "admin:1"), false);
});

test("labels are only for a signed-in admin", async () => {
  const id = await scored("比亚迪调价", 66);
  const read = await app.inject({ method: "GET", url: "/api/admin/labeling" });
  assert.equal(read.statusCode, 401);
  const write = await app.inject({ method: "PUT", url: `/api/admin/labeling/${id}`, payload: { decision: "select" } });
  assert.equal(write.statusCode, 401);
  assert.equal((await sql`SELECT 1 FROM labeling_marks WHERE article_id = ${id}`).length, 0);
});
