# 最后 6 项整改的可实施方案

基线：`7960c57`（2026-11-22）。本文只写方案，不改代码。行号均为实测。

不在本次范围（按任务书）：P1-01 评分短路、P1-03 understandFloor、P1-05 T1 门槛、P1-07 同集团多源、P1-08 displayTag。

约束按任务书 7 条执行，其中三条在本轮反复起作用：**web 只经 HTTP 读 api**、**迁移自 0055 起单文件单语句**、**加锁/重试/兜底先有证据**（项 1 的 B 案、项 3 的"先测量"、项 5 的熔断默认值都按这条写）。

---

## 0. 与任务书对不上的 7 处（以实测为准）

| # | 任务书 | 实测 | 对方案的影响 |
|---|---|---|---|
| 1 | 项 1「原稿说微博推送仍入队不成立」 | 确认不成立：`modules/weibo-monitor/server.ts:11` 的模块计划以 `COLLECT_ENABLED === "true"` 为前提 | 入队来源只剩 3 个，行为矩阵按 3 个写 |
| 2 | 项 1 B 案「加一条告警（正文积压超过 N）」 | **已有**：`operations/alerts.ts:329-335` 的 `waitingQueues` 对 `pgboss.job` 中 `state IN ('created','retry')` 且排队超 2 小时的任务发 `queue.<name>`（`later` 级） | B 案不需要新告警代码，只剩文档 + 文案增强 |
| 3 | 项 1「正体积压」隐含无限增长 | 不是永久：`pg-boss` 队列默认 `retention_seconds = 14 天`（`node_modules/pg-boss/dist/plans.js:85`，`keep_until` 默认 `now() + 14 天`），未消费的 `created` 任务到期被维护删除，之后 `content.sweep` 重新入队 | B 案的代价是"14 天一轮的滞留 + 常驻 2 小时告警"，不是表爆炸 |
| 4 | 项 2「eval-selection.ts 加 `--split`」 | **已存在**：`scripts/eval-selection.ts:38-46` 的 `--split`（并支持 `--seed`/`--n`/`--models`/`--no-import`） | 只剩 `--baseline` 与分层报告 |
| 5 | 项 2「门槛顺序断言」 | 只有**隐式**依赖：`tests/analyze.test.ts:46` 靠"找一个介于 T1 与 T2 之间的类别"反推，找不到时 `CLASS_FLOOR = NaN` 静默降级；没有 `understandFloor < T1` 这类显式断言 | 显式断言确实要补 |
| 6 | 项 5「`server.close()` 无 closeIdleConnections 兜底（挂起连接拖住退出）」 | Node ≥19 起 `server.close()` 已经会关闭空闲连接；真缺口是：**没有退出截止时间**、没有 `closeAllConnections()`、`docker-compose.yml` 里 web 没有 `stop_grace_period`（api/worker 在 `:81` 有 515s，web 用默认 10s） | 改法从"补 idle 关闭"改成"补截止时间 + 强制断开 + 部署宽限" |
| 7 | 项 6「两个 worker 同时归同一池不建重复事件」 | 跨文章并发**没有**数据库级保护：`stories`/`facts` 无相关唯一约束（`0002_events_reports.sql:3-14`、`:51-63`），`group.ts:123`、`:142` 是裸 INSERT；保护只来自 `jobs/events.ts:12` 的 `localConcurrency: 1` | 测试不能断言"DB 级幂等"，只能守串行配置 + 测"第二篇归属正确、第一篇不被挤掉、重复归组幂等" |

---

## 1. P0-02：`COLLECT_ENABLED=false` 时正文队列的语义（两案）

### 1.1 现状确认

**注册条件**

- `apps/worker/src/main.ts:24` `await registerContentJobs(boss)` 无条件；
- `apps/worker/src/main.ts:25` `if (process.env.COLLECT_ENABLED === "true") await registerSourceJobs(boss)`；
- `packages/backend/src/jobs/sources.ts:7`（import）、`:16`（调用）`registerExtractionJobs` 在被条件包裹的 `registerSourceJobs` 里面。

**入队来源（3 个，均不受阀门限制）**

| 来源 | 位置 | 说明 |
|---|---|---|
| 外部上报 | `packages/backend/src/ingest/items.ts:75` → `queueProcessing(res.articleId, { db })` | 路由 `apps/api/src/routes/ingest.ts:38` 只看 ingest token |
| 后台手动重跑 | `packages/backend/src/admin/content.ts:355`（`step === "extract"` 时先 `:353-354` 把 `body_status` 置 `pending`） | 需要管理员会话 |
| 重试扫描 | `apps/worker/src/schedules.ts:29` `content.sweep`，`*/5 * * * *` → `sweepUnprocessed()` | 无条件注册 |

**关键事实：已带正文的文章根本不进抽取队列。** `jobs/content.ts:43` 的 `route()` 用 `pending = body_status === "pending"`（`:52`）决定 `step`；`content/materials.ts:388` 在 `m.bodyText` 非空时把 `body_status` 写成 `ok`。所以 `step` 只可能是 `analyze`。**抽取队列里只有"需要抓页面"的文章**。

**外呼的唯一点**：`content/extract.ts:850-856` 的 `extractArticleBody`——`:854` 在 `body_status === "ok"` 时直接 `skipped`；`:855` X 长文走 `extractXArticle`（`getArticle`，付费 SocialData，`:897`）；`:856` 否则 `extractFromUrl`（`guardedFetch` `:804`、Jina 回退 `:827`）。这条路径上**没有任何** `COLLECT_ENABLED` 判断。

**队列 payload**：`jobs/content.ts:87` 是 `{ articleId }`，没有"已带正文"标记（也不需要，见上）。

**安全阀语义**：`docs/architecture.md:31`"只决定发不发出去"；`docs/sources.md:30`"`COLLECT_ENABLED=false` 只关闭后台自动采集，不能用它来保证手动预览不访问外部服务"；`docs/deploy.md:195`"关掉采集后不再取信源图标"。也就是说：**自动路径不访问外部，人工动作可以**。

**已有的可见性**：`waitingQueues`（`alerts.ts:329-335`）会报 `queue.content.extract-body`（`later`，2 小时）。但它只报"排队久"，不解释"为什么没人消费"。

### 1.2 两案的行为矩阵

| 情形 | 现状 `COLLECT=true` | A 案（`COLLECT=false`） | B 案（`COLLECT=false`，现状即如此） |
|---|---|---|---|
| ingest 带 `bodyText` | 直接 `analyze` | 直接 `analyze`（不进抽取队列） | 同 A |
| ingest 只有标题/摘要 | 抽取页面 → 分析 | 任务被消费并返回 `deferred`，文章保持 `body_status='pending'`；`content.sweep` 每 5 分钟扫一次（`schedules.ts:29`），但 A 案设 `processing_retry_at = now() + 30 分钟`、且 `processing_queued_at` 有 `QUEUED_STALE = 30 分钟`（`jobs/content.ts:25`），所以实际重试是 **30 分钟一轮**；打开采集后由 sweep 自动续上 | 任务留在 `created`；2 小时后 `queue.content.extract-body` 报警；打开采集后**立即**被消费 |
| 后台手动重跑"抽取"(step=extract) | 外抓 | 外抓（`force: true`，按 `docs/sources.md:30` 人工动作不受阀门限制） | **无消费者，永远不动**（人工动作静默失效） |
| `content.sweep` | 正常 | 同"只有标题" | 同"只有标题" |
| 队列状态 | 空 | 空（每个任务完成，输出 `deferred`） | 每个文章一行 `created`，14 天后被 pg-boss 删除再由 sweep 重建 |
| 可见性 | — | 需要新告警（否则完全无声） | 已有 `queue.` 告警，但文案不提阀门 |

### 1.3 A 案改动清单

```ts
// 1) packages/backend/src/jobs/queue.ts:19  payload 加一个可选标记
"content.extract-body": { articleId: string; force?: boolean };

// 2) packages/backend/src/jobs/content.ts:76  显式人工动作可以越过阀门
export async function queueProcessing(articleId, opts: { step?: Step; attemptTag?: string; db?: Db; forceFetch?: boolean } = {})
// :87
if (step === "extract") return enqueue(QUEUES.extractBody,
  { articleId, ...(opts.forceFetch ? { force: true } : {}) },
  { singletonKey: articleId, priority: ..., }, opts.db);

// 3) packages/backend/src/jobs/content.ts:212-213  处理函数首行自判
const collecting = () => process.env.COLLECT_ENABLED === "true";   // 与 alerts.ts:45 同一写法
export async function registerExtractionJobs(boss) {
  await work(boss, QUEUES.extractBody, { localConcurrency: 4, pollingIntervalSeconds: 2 }, async ({ articleId, force }) => {
    // 阀门关着且不是人工重跑：不访问外部，也不改文章状态，交给 sweep 在阀门打开后重试。
    if (!collecting() && !force) return { state: "deferred" };
    ...原有逻辑
  });
}

// 4) apps/worker/src/main.ts:25 拆开：抽取无条件注册，抓取仍受阀门控制
await registerContentJobs(boss);
await registerExtractionJobs(boss);
if (process.env.COLLECT_ENABLED === "true") await registerSourceJobs(boss);
// 同时删除 packages/backend/src/jobs/sources.ts:7 的 import 与 :16 的调用

// 5) packages/backend/src/admin/content.ts:355  step === "extract" 时传 forceFetch: true

// 6) 新告警（否则 A 案完全无声）：operations/alerts.ts 的 CHECKS（:59-81）里加 contentExtract，
//    放在 contentProcessing（:64）之后
async function contentExtract(now: number, open: AlertState): Promise<Finding[]> {
  if (collecting() && !open["content.extract"]) return [];   // 阀门开着时由 content.process 管
  const [r] = await sql<{ n: number; oldest: Date | null }[]>`
    SELECT count(*)::int AS n, min(discovered_at) AS oldest FROM articles
    WHERE body_status = 'pending' AND processing_state = 'new' AND discovered_at < now() - interval '2 hours'`;
  if (!r || r.n < 5) return [];
  return [{ key: "content.extract", level: "later",
    title: "只有标题的稿子在等正文",
    impact: `${r.n} 篇稿子只能显示来源摘要，看不到正文`,
    action: "打开采集（COLLECT_ENABLED=true）后会自动继续；或让上报方直接带上正文",
    heals: "打开采集后自愈，不需要逐篇重跑",
    detail: `最老的一篇 ${beijingStamp(r.oldest!)} 收进；采集已关闭（COLLECT_ENABLED 不是 true），所以这些稿子不会去抓页面` }];
}
```

不要把这些判断下沉到 `extractArticleBody`：那会让后台手动重跑与"预览抓取"一起失效，而 `docs/sources.md:30` 明确人工动作不受阀门限制。

### 1.4 B 案改动清单

```ts
// 唯一的代码改动：alerts.ts:333 的 map 里补一句解释（5 行左右）
return queues.filter((q) => now - q.oldest.getTime() > 2 * 3600_000).map((q): Finding => ({
  key: `queue.${q.name}`, level: "later", title: `后台任务排队超过 2 小时：${q.name}`,
  detail: `${q.n} 个等待，最早的等了 ${duration(now - q.oldest.getTime())}`
    + (q.name === "content.extract-body" && !collecting()
        ? "；采集已关闭（COLLECT_ENABLED 不是 true），这些正文任务不会被消费，打开采集后自动继续"
        : ""),
}));
```

文档：`docs/deploy.md` 的"采集与发布时间"清单（`:186-198`）加一条——

> **关掉采集后正文抽取也停**：`COLLECT_ENABLED` 不是 `true` 时，只有标题的上报文章会停在"等待正文"，任务留在队列里（14 天后被 pg-boss 清掉，`content.sweep` 再补）。后台"重跑抽取"同样不会动，直到打开采集。要在这段时间仍能处理，请让上报方直接带上 `bodyText`。

### 1.5 测试（两案共用文件）

`tests/extraction-consistency.test.ts`——已有 `registerExtractionJobs`、`queueProcessing`、`rerun` 的用法，且已用"注册 worker + 轮询 `pgboss.job.state`"的方式等任务完成（`:184-190`）。

A 案新增两条：

1. `COLLECT_ENABLED` 未设时，标题-only 文章入队后任务完成且 `output->>'state' = 'deferred'`；期间把外部抓取桩的计数断言为 0；文章仍 `body_status='pending'`、`processing_state='new'`。
2. 同一篇文章走 `rerun(id, "extract", ...)`（带 `force`）时**会**外抓：桩被命中 1 次，`body_status` 变 `ok`。

B 案新增一条：`COLLECT_ENABLED` 未设时，标题-only 文章入队后 `pgboss.job` 里留下一行 `state='created'`，且 2 小时后 `collectFindings(now + 3h)` 里出现 `queue.content.extract-body`。

### 1.6 迁移与数据影响

无。不新增列、不改存量数据。A 案上线前已在队列里的 `created` 任务会被新消费者立刻取走并按 `deferred` 完成；B 案上线后无需任何数据处理。

### 1.7 验收

- A 案：`COLLECT_ENABLED=false` 起 worker，`pgboss.job` 中 `content.extract-body` 的 `created` 行在 1 分钟内归零（全部 `completed`），`output->>'state'` 全为 `deferred`；断网环境下无任何出站请求（可用 `network` 桩或 `guardedFetch` 计数）；把 `COLLECT_ENABLED` 改回 `true` 后，同一批文章在 30 分钟内全部拿到正文。
- B 案：`COLLECT_ENABLED=false` 起 worker，10 分钟后 `SELECT count(*) FROM pgboss.job WHERE name='content.extract-body' AND state='created'` 等于待抓文章数；把 `COLLECT_ENABLED` 改回 `true` 后该数在 1 分钟内归零且文章拿到正文。

### 1.8 风险与回滚

- A 案：风险是"阀门关着时新上报的标题-only 文章永不发布"——与 B 案相同，不是新增风险；回滚 = 删掉处理函数首行判断、恢复 `main.ts:25` 的一行注册（`force` 字段留着无害）。
- B 案：风险是队列滞留与常驻 `later` 告警；回滚 = 删掉 `waitingQueues` 的补充文案与文档那一条（纯文本）。

### 1.9 取舍与建议

- **A 案**换来三件小事：后台重跑仍可用、队列干净（`waitingQueues` 不会长期挂一条）、状态可解释。代价约 50 行 + 一个 payload 字段 + 一条新告警。
- **B 案**是零代码，且**打开采集的瞬间自愈**（`created` 任务立刻被消费），比 A 案（等 sweep 的 30 分钟）恢复更快。它与"安全阀只决定发不发出去"的语义也一致：任务排队不是错误。
- **建议 B 案**。理由只有一条且可检验：按约束 7，A 案要新增一条机制（payload 标记 + 新告警），而我找不到"B 案真的造成损害"的证据——滞留的 job 行有 14 天上限，告警是真实信号而非噪声。A 案只在"必须在 `COLLECT_ENABLED=false` 期间用后台重跑抽取"时才值得。

**待拍板**

1. A 还是 B。若选 A，第二个问题：`deferred` 是否可接受（文章在阀门关闭期间保持 `pending`、不降级为仅标题）——`deferred` 是刻意的，"降级为 `unconfirmed`"会让本可抓到全文的文章永久只发摘要。
2. 若选 B，`waitingQueues` 的补充文案要不要顺带覆盖 `sources.fetch`（同样会被阀门停掉，但那条队列平时不通）。

---

## 2. P1-06（修正版）：评测护栏里不付费的部分

### 2.1 现状确认

- `scripts/eval-selection.ts` 走 `runSelectionPrefilter`/`runSelectionScores`（`:108`、`:117`）→ `chatJson`，**真实付费**；参数已含 `--gold/--models/--n/--split/--concurrency/--seed/--label/--no-import`（`:38-46`）。
- 输出：每个模型一行 `summary`（`:139-148`）、阈值扫描（`:151-156`）、`mistakes`（`:133-137`）、`cases`（`:158-166`）；落盘 `.data/eval/selection-<split>-<n>-<ts>.json`（`:171-175`）；默认还会导入 SelectBench（`:178-181`）。
- 金标：`.data/gold.jsonl`（`.gitignore:8` 忽略 `.data/`）**当前不存在**；`site/site.ts:304` `selectionGold: null` → 默认 `split = "all"`、`n = 200`、`sweep = [40, 90]`。
- 门槛：`industry/selection.ts:22` `thresholds {T1:54, T1_5:56, T2:58}`、`:30-35` `classes`（55/57）、`:38` `understandFloor: 30`、`:43` `browseFloor: 22`；`:19-21` 的注释写明顺序 `understandFloor < T1 < 类别门槛 < T2`。
- 判定：`editorial/analyze.ts:475-478` `scoresSelect` = `sum >= threshold * SCORE_CALLS`，且 `sum !== null && threshold !== null`。**当前没有任何直接单测。**
- CI（`.github/workflows/check.yml`）只跑 typecheck / build / web tests / backend tests / smoke，不跑评测——这是对的，保持。

### 2.2 改动清单

**a) 确定性断言（不调模型、不连库）**，进 `tests/analyze.test.ts`（已 import `SELECTION`，`:22`）：

```ts
test("the pack's thresholds stay in the order the scoring and writing steps assume", () => {
  const t = SELECTION.thresholds, classes = Object.values(SELECTION.classes).map(c => c.threshold);
  assert.ok(SELECTION.browseFloor < SELECTION.understandFloor, "browseFloor must sit below understandFloor");
  assert.ok(SELECTION.understandFloor < t.T1, "understandFloor must sit below every selecting threshold");
  for (const [tier, v] of Object.entries(t)) assert.ok(v < t.T2 || tier === "T2", `${tier} must not exceed the media threshold`);
  for (const v of classes) assert.ok(v >= t.T1 && v < t.T2, "a class floor raises the official tiers, never the media one");
});

test("scoresSelect needs two scores at the threshold, and both of them", () => {
  const scores = (values: number[], threshold: number | null) =>
    ({ model: "stub", threshold, values, receiptIds: [], reused: false }) as AnalysisRun["scores"];
  assert.equal(scoresSelect(scores([58, 58], 58)), true);
  assert.equal(scoresSelect(scores([57, 57], 58)), false);                       // 114 < 116
  assert.equal(scoresSelect(scores([58], 58)), false);                           // 缺一次（scoreSum 要求两次）
  assert.equal(scoresSelect(scores([90, 90], null)), false);                     // 没有门槛的分级不参与精选
  assert.equal(scoresSelect({ ...scores([90, 90], 58), refused: true }), false); // 内容过滤拒答不算入选
  assert.equal(scoresSelect(null), false);
});
```

（需要在该文件已有的 `@aihot/backend/editorial/analyze` import 里补 `scoresSelect` 与 `type AnalysisRun`。）

第三条（金标格式，缺文件跳过）：

```ts
test("the gold set parses, when one exists", (t) => {
  const file = path.resolve(REPO_ROOT, ".data/gold.jsonl");
  if (!existsSync(file)) return t.skip("no .data/gold.jsonl: the guard is not active on this machine");
  const rows = parseSelectionGoldJsonl(readFileSync(file, "utf8"));
  assert.ok(rows.length > 0);
  assert.equal(new Set(rows.map(r => r.caseId)).size, rows.length);
});
```

`parseSelectionGoldJsonl`（`scripts/eval-selection-core.ts:37`）是纯函数，除 `scoresSelect` 外不碰数据库；`tests/` 本来就连库，无额外成本。

**b) `eval-selection.ts` 加 `--baseline` 与分层报告**

```ts
baseline: { type: "string" },   // 上一份 report JSON 的路径
// 每个 case 的分层键：samplingStratum 优先，其次信源分级，最后 unknown
const stratumOf = (r: SelectionGoldRow) => r.samplingContext?.samplingStratum ?? r.sourceFacts.sourceTier ?? "unknown";
// 报告里加：summary.byStratum = { [k]: selectionMetrics(该层 cases) }
// 有 --baseline 时：读 baseline.models[model].summary / .byStratum，打印 delta 表
//   （acc / precision / recall / f1 / completeAccuracy / coverage / selectedRate，小数点后三位）
```

- 现有 `summary/sweep/mistakes/cases` 结构不动（旧报告仍能当 baseline）。
- `--baseline` 找不到对应模型时跳过该模型并提示，不报错退出。
- 不加退出码（不跑 CI，`--fail-on-regress` 没有消费者）。

**c) PR 模板**（`.github/pull_request_template.md`）在"如何验证"下加一行：

```markdown
<!-- 改了 industry/prompts/** 或 industry/selection.ts：贴 scripts/eval-selection.ts 改动前后的 summary（同一 split / 同一 n）。 -->
```

### 2.3 测试

- a) 全部进 `tests/analyze.test.ts`，随 `npm test` 在 CI 跑；不触发任何付费调用（`scoresSelect` 是纯函数）。
- b)、c) 不写自动化测试：一个是运维脚本，一个是文档模板。验收靠命令输出。

### 2.4 迁移与数据影响

无。

### 2.5 验收

1. `npm test` 绿；把门槛顺序破坏（临时把 `T1` 改成 28）→ 顺序用例变红。
2. 把 `scoresSelect` 的 `>=` 改成 `>` → 边界用例变红。
3. `node --env-file=.env scripts/eval-selection.ts --n 20 --baseline .data/eval/selection-all-315-*.json` 打印 delta 表；同一命令不带 `--baseline` 时行为与现在完全一致。
4. 把 `--n` 调到 2 跑两次，第二次的 `cases[].score` 与第一次一致（回执复用，证明重跑不花钱）——这是现有的回执保证，顺带验一次。

### 2.6 风险与回滚

纯新增/纯局部：回滚 = 删掉三条测试与 `--baseline` 分支。金标缺失时 skip 会让护栏静默失效，skip 文案里必须写明"护栏未生效"。

### 2.7 待拍板

1. 分层维度用 `samplingStratum`（现有 315 条样本里是 T2+rss 一类）还是信源分级；我按"两者都输出"写，先看数据再收窄。
2. `browseFloor < understandFloor` 这条断言要不要一起加——它不是注释里写死的顺序，是我推出来的（浏览门槛低于精写门槛才不矛盾）；若你不认同，删掉即可。

---

## 3. P2-01（第一步只做测量）：归组性能

### 3.1 现状确认

- 串行：`jobs/events.ts:11-12`（`localConcurrency: 1`，注释在 `:11`）；`events/group.ts:19-20` 的模块注释写明"Runs serially (queue concurrency 1)"。
- 召回：`events/recall.ts:19` `RECALL_DAYS = 14`；`:52-63` `recallPool()`（`fact_articles` × `facts` × `stories`（`merged_into IS NULL`）× `articles`，`discovered_at > now() - 14 days`，带 `groupingEvidenceCondition`）；`:165-200` `similarReports` 在 Node 里逐条 `cosine32`（`:195`，`cosine32` 定义在 `:149`）；`:204` `recallFacts`、`:211` `recallFactsByPosts`。
- 锁：`group.ts:402` 输入事务 `FOR UPDATE`；`:354-356` `lockCurrentRevision`；`:679` 故事行 `FOR UPDATE`。
- **不需要写任何代码就能拿到端到端耗时**：`pg-boss` 的 `job` 表有 `started_on`/`completed_on`，完成记录默认保留 14 天（`plans.js:85` `retention_seconds: FORTEEN_DAYS`、`:559` `keep_until` 默认 `now() + 14 天`；`policy: "short"` 在 `:766` 只决定去重索引，不改变保留期）。所以 `completed_on - started_on` 就是单次归组总耗时（含模型）。

### 3.2 改动清单（只增测量，不改运行时）

**A. 生产只读 SQL（5 条，都在 replica 或只读事务里跑）**

```sql
-- ① 归组总耗时 P50/P95/max，按天
SELECT date_trunc('day', completed_on) AS day, count(*) AS jobs,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_on - started_on)) AS p50_s,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_on - started_on)) AS p95_s,
       max(extract(epoch FROM completed_on - started_on)) AS max_s
FROM pgboss.job
WHERE name = 'events.group' AND state = 'completed' AND completed_on > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;

-- ② 付费延迟分解（这一段是模型时间，与召回无关；`receipt_attempts.latency_ms` 见 `database/migrations/0022_receipt_attempts_budgets.sql:18`）
SELECT r.purpose, count(*) AS calls,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS p95_ms
FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
WHERE r.purpose IN ('group_article','group_review','group_signal','group_card','group_card_review')
  AND a.started_at > now() - interval '14 days'
GROUP BY 1;

-- ③ 队列积压深度
SELECT name, state, count(*) FROM pgboss.job
WHERE name IN ('events.group','events.digest') GROUP BY 1,2;

-- ④ 等待过久的归组（队列外仍 pending 的）
SELECT count(*) AS stuck FROM articles
WHERE grouping_status = 'pending' AND created_at < now() - interval '10 minutes';

-- ⑤ 召回池规模（每天）
SELECT date_trunc('day', a.discovered_at) AS day, count(*) AS pool_rows
FROM fact_articles fa JOIN articles a ON a.id = fa.article_id
JOIN facts f ON f.id = fa.fact_id JOIN stories st ON st.id = f.story_id AND st.merged_into IS NULL
WHERE fa.role IN ('primary','report') AND a.discovered_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1;
```

归组总耗时 − 模型延迟 ≈ 召回 + 归组写库；再用 ⑤ 的池规模对照 ① 的 P95，就能算出"池到多大时 P95 越过 10 秒"。

两处容易漏的细节：② 的 `purpose` 必须列全（实测 `packages/backend/src` 里全部取值是 `group_article`/`group_review`/`group_signal`/`group_card`/`group_card_review`，漏一个就把模型时间算少）；`scripts/eval-tools.ts:115-128` 的 `usageFor` 已经在算 `avg(latency_ms)`，缺的只是 P50/P95 与按 `purpose` 分组，**别重写一份**。

**B. 本地回放（只读，一次性脚本 `scripts/bench-recall.ts`，不进 CI、不进运行时）**

前置检查（不满足就中止）：

```sql
-- 回放库必须是完整恢复的：池文章的向量覆盖不到，vectorsFor 就会去调付费 embedding
SELECT count(*) AS pool_missing_vectors
FROM fact_articles fa JOIN articles a ON a.id = fa.article_id
WHERE fa.role IN ('primary','report') AND a.discovered_at > now() - interval '14 days'
  AND NOT EXISTS (SELECT 1 FROM embeddings e
                  WHERE e.kind = 'article' AND e.ref_id = fa.article_id AND e.model = ${EMBEDDING_MODEL});
```

`model` 条件不能省：`embeddings` 主键是 `(kind, ref_id, model)`（`database/migrations/0006_embeddings.sql:9`），换过 embedding 模型后旧向量还在，只看 `ref_id` 会误判"覆盖够了"，然后回放跑到一半开始付费。

再加一道硬闸：脚本开头把 `globalThis.fetch` 换成"非 loopback 一律抛错并计数"，跑完断言计数为 0。这样即使 `text_hash` 漂移导致 `vectorsFor` 想去付费，也会**立刻报错而不是花钱**。

脚本骨架：

```ts
// 与 group.ts:527、:541 同一条取数：最新一次分析、relevance = pass，query 文本 = reportText(title, summary_zh)
const ids = await sql`SELECT a.id, coalesce(an.title_zh, a.title) AS title, an.summary_zh
  FROM articles a JOIN LATERAL (SELECT title_zh, summary_zh, relevance FROM analyses x
    WHERE x.article_id = a.id ORDER BY input_revision DESC, id DESC LIMIT 1) an ON true
  WHERE an.relevance = 'pass' AND a.discovered_at > now() - interval '7 days'
  ORDER BY random() LIMIT 100`;
for (const row of ids) {
  const query = reportText(row.title, row.summary_zh);      // relate.ts:195，与生产一致
  const t0 = performance.now();
  const hits = await recallFacts(row.id, query, RECALL_MIN_COSINE, RECALL_TOP_FACTS);   // 只读
  record({ id: row.id, ms: performance.now() - t0, pool: await poolSize(), hits: hits.length });
}
// 输出：ms 的 P50/P95/max，按 pool 分桶（<1k / 1k–5k / >5k），以及 hits 的分布
```

`RECALL_MIN_COSINE`/`RECALL_TOP_FACTS` 现在是 `group.ts:45-46` 的模块私有常量，给它们加 `export`（两行改动，让测量脚本跟着生产值走，避免抄一份数值后漂移）。同理，要分段计时就得把 `recall.ts:52` `recallPool` 与 `:165` `similarReports` 也 `export`（`cosine32` 在 `:149` 已是 `export`）——一共四个 `export` 关键字，无运行时影响。

**C. 造并发：不做。** 跨文章并发没有数据库保护（见第 0 节第 7 条），在生产加 worker 或用 `Promise.all` 跑两篇都会造出重复事件。要看"两个进程各自串行"的效果，只能在回放库里把样本顺序跑两遍对比。

### 3.3 要记录的指标

| 指标 | 来源 | 用途 |
|---|---|---|
| 池规模（行数/日） | SQL ⑤ | 判断增长趋势 |
| 单篇候选数（`recallFacts` 返回条数） | 回放 | 决定批提示的 token 成本 |
| 召回 SQL 耗时 | 回放（`recallPool` 前后计时） | 是否需要粗召回/索引 |
| 余弦循环耗时 | 回放（`similarReports` 内部计时，临时 patch 或分段计时） | 是否需要 ANN |
| 付费调用次数与 P95 延迟 | SQL ② | 模型段占比 |
| 单篇归组总耗时 | SQL ① | 主指标 |
| 队列积压深度 | SQL ③④ | 是否已到瓶颈 |

### 3.4 测试

无自动化测试（测量脚本）。回放脚本必须能在缺 `embeddings` 时中止——这一条写成脚本里的 `assert`，用一条 dry-run 用例验证（`--dry-run` 只跑前置检查，退出码 2 表示不可回放）。

### 3.5 迁移与数据影响

无。回放库是本地临时库，测完 `DROP DATABASE`。

### 3.6 验收

一份 `docs/perf/grouping-<date>.md`（或 CSV）含：14 天 P95 曲线、池规模曲线、模型段占比、回放的分桶 P95。**能回答"池到多大时 P95 越过 X 秒"** 才算完成。

改造的决策点（先写死，避免以后拍脑袋）：

- P95 归组 < 10 秒且 `stuck` < 20 → 什么都不做；
- 召回段占 > 60% → 先做粗召回（有界池/席位预筛），再考虑 pgvector；
- 模型延迟占主导 → 先减候选数（`top`/召回门槛），**不是**加并发。

### 3.7 风险与回滚

只读，无回滚问题；唯一风险是回放库缺向量触发付费 embedding，靠前置检查挡住。

### 3.8 待拍板

1. "P95 越过多少秒算问题"（我按 10 秒写）。
2. 回放样本量（100 篇 ≈ 100 次召回；>500 就要跑几十分钟）。

---

## 4. P2-02：日报引用规范化

### 4.1 现状确认

- `publication/reports.ts:426-437` `firstDaily(itemId)`：`:429` 对 `reports` 全表 `jsonb_path_exists(content, 'strict $.**.itemId ? (@ == $id)')`（`kind='daily'`，按 `key` 升序）；命中后逐期 `issueAvailability`（`:334-343`，一次 `availability()` 批量查询）+ `issueAsShown`（`:350-...`），`listed` 里再按 `c.available` 过滤（`:434-436`）。
- 调用点：`publication/detail.ts:200`（`daily: await firstDaily(id)`），**只有这一处**（另有两处同名局部变量，在 `alerts.ts:732`、`compose.ts:328`，与此无关）。
- 写入口：`reports/compose.ts:57-79` `saveReport`（`INSERT` `:59-60`，重写 `:63-73`，`emit("reportsChanged")` `:75`）；`reports/correct.ts:14-64` 只把条目在 section 之间搬动，`itemId` 集合不变，**不需要重建索引**（这是它唯一的 content 写入：`:59`）。
- 报告不存在删除路径（`dailyRetention` 不碰 `reports`）。

### 4.2 先估成本（不测就动手是违规）

```sql
-- 期数、内容体积
SELECT count(*) AS dailies, pg_size_pretty(sum(pg_column_size(content))::bigint) AS bytes,
       round(avg(pg_column_size(content))) AS avg_bytes FROM reports WHERE kind = 'daily';

-- 现状单次耗时（把 <id> 换成一篇被多期引用的文章）
EXPLAIN (ANALYZE, BUFFERS)
SELECT key FROM reports
WHERE kind = 'daily' AND jsonb_path_exists(content, 'strict $.**.itemId ? (@ == $id)', jsonb_build_object('id','<id>'));
```

决策规则：**期数 < 200 或 p95 < 20ms → 不做**，把这条结论写进文档即可。我按 `avg_bytes ≈ 20–40KB` 估，400 期就是每次详情页读 8–16MB 的 TOAST；按日均详情页 PV 折算，如果超过几秒/小时就值得做。

### 4.3 改动清单

**A. 迁移 `database/migrations/0176_report_citations.sql`（单语句；`database/migrations/` 是唯一迁移目录，当前最新是 `0175_story_digests_report_hashes.sql`）**

```sql
CREATE TABLE IF NOT EXISTS report_citations (
  item_id   text   NOT NULL,
  report_id bigint NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, report_id)
);
```

- 一条语句；新表为空，不需要 `CONCURRENTLY`（规范针对的是给存量表建索引）。
- 主键列序是 `(item_id, report_id)`：读取方向正是"按 item_id 找期次"，前缀命中；反向（按期次删）走 PK 的第二列不支持，靠 `ON DELETE CASCADE` 时全表扫——表小且报告不删，可接受。这样**一条语句就够**，不必再开一个迁移建第二个索引。

**B. 引用抽取（新文件 `packages/backend/src/reports/citations.ts`，写入与回填共用）**

```ts
/** 一期日报里可能被 firstDaily 认作"列出"的 itemId：sections[].items[](+related)、flashes[]、picks[]、highlights[] */
export function citedItemIds(content: Record<string, any>): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v) ids.add(v); };
  for (const s of content.sections ?? []) for (const it of s.items ?? []) {
    add(it.itemId); for (const r of it.related ?? []) add(r.itemId);
  }
  for (const f of content.flashes ?? []) add(f.itemId);
  for (const p of content.picks ?? []) add(p.itemId);
  for (const h of content.highlights ?? []) add(h);   // 这里是字符串数组（compose.ts:115）；picks 在 :116 另存一份对象
  return [...ids];
}
```

只对 `kind === "daily"` 建索引行：`firstDaily` 只查日报，周月报的 `storyOrder`/`themes` 没有读者——写进去只会让表变大，等有读取方再加（不扩范围）。

**C. 写入（`reports/compose.ts:57-79` `saveReport`，同一事务内、`emit` 之前）**

```ts
// 不改 :59-60 的 written 语义，同一事务里把 id 取回来用
const reportId = existing?.id
  ?? (await tx<{ id: number }[]>`SELECT id FROM reports WHERE kind = ${kind} AND key = ${key}`)[0]!.id;
if (kind === "daily") {
  await tx`DELETE FROM report_citations WHERE report_id = ${reportId}`;
  const ids = citedItemIds(content);
  if (ids.length) await tx`INSERT INTO report_citations (item_id, report_id)
    SELECT x, ${reportId} FROM unnest(${ids}::text[]) AS x ON CONFLICT DO NOTHING`;
}
```

**D. 读取（`reports.ts:426-437`）**

```ts
const issues = await sql<{ key: string; content: Record<string, any> }[]>`
  SELECT r.key, r.content FROM report_citations c JOIN reports r ON r.id = c.report_id
  WHERE c.item_id = ${itemId} AND r.kind = 'daily' ORDER BY r.key`;
// 循环体原样保留：issueAvailability → issueAsShown → listed.some(c => c.itemId === itemId && c.available)
```

**撤回语义就在这里**：索引只决定"要看哪几期"，某条引用还算不算公开仍由 `issueAvailability`/`c.available` 按当前资料判断。索引绝不能用来回答"是否仍列出"。

**E. 存量回填 `scripts/backfill-report-citations.ts`**（独立脚本，不进迁移；照 `scripts/rebuild-timeline.ts:1-13` 的结构）

```ts
for (let batch = 0; ; batch++) {
  const rows = await sql`SELECT id, content FROM reports WHERE kind='daily'
    AND id > ${cursor} ORDER BY id LIMIT 500`;
  if (!rows.length) break;
  await sql.begin(async tx => { for (const r of rows) { /* DELETE + INSERT，同 C */ } });
  cursor = rows.at(-1)!.id;
  console.log(JSON.stringify({ batch, done: rows.length, cursor }));
}
```

幂等：每次先 `DELETE` 该期的行再插；重复跑无副作用。

### 4.4 测试

- `tests/daily-highlights.test.ts:107` 已有 `assert.deepEqual(await firstDaily(best), { key: day, lead: false })` —— 改造后必须仍绿，这是最强的回归钩子。
- 在该文件新增两条：
  1. **索引与内容一致**：`composeDaily(date)` 后，`report_citations` 的 `item_id` 集合等于 `citedItemIds(content)`；带 `reason` 重写一次后仍然相等（证明删除+重建生效）。
  2. **撤回优先于索引**：先让某期日报引用文章 A，再把 A 置为 withdrawn（`setVisibility`），`firstDaily(A)` 返回 `null`——索引命中但 `available=false`，证明撤回语义没有丢。
- `tests/report-recovery.test.ts` 里加一条：写作失败后再补写（带 `reason`）时，`report_citations` 跟着更新，不残留旧行。

### 4.5 迁移与数据影响

- 迁移 `database/migrations/0176_report_citations.sql` 建空表，存量靠回填脚本。**顺序不能颠倒**：回填跑在旧代码上（旧代码仍读 JSONB，结果不变），回填完成并核对后再切读取代码。若先切读取代码，未回填的期次会被漏掉。

### 4.6 验收

```sql
-- 每期日报的引用行数与内容里应被引用的数量一致（抽样 20 期人工核）
SELECT r.key, count(c.item_id) FROM reports r LEFT JOIN report_citations c ON c.report_id = r.id
WHERE r.kind='daily' GROUP BY 1 ORDER BY 1 DESC LIMIT 20;

-- 索引不能凭空多出当期内容里没有的 id
SELECT c.item_id FROM report_citations c JOIN reports r ON r.id=c.report_id
WHERE NOT (r.content @> jsonb_build_object('sections', jsonb_build_array(jsonb_build_object('items', jsonb_build_array(jsonb_build_object('itemId', c.item_id))))))
LIMIT 5;   -- 只作抽样人工核对，sections 之外还有 flashes/picks/highlights
```

运行期：`pg_stat_statements` 里 `firstDaily` 那条查询（或改造前后的 `EXPLAIN` 对比）耗时下降；对同一批 100 个 itemId，新旧实现结果逐条相等（脚本对账，回填后跑一次）。

### 4.7 风险与回滚

回滚 = `firstDaily` 改回 JSONB 扫描（表与数据留着无害）；不会丢数据，也不需要删表。

### 4.8 待拍板

1. 测量结论若落在"期数 < 200 或 p95 < 20ms"，这项直接砍掉（我倾向：先测，别先写）。

---

## 5. P2-05（剩余）：web 退出兜底与熔断

### 5.1 现状确认

- `apps/web/server.ts:178` `server.keepAliveTimeout = 65_000`；`:189` `const shutdown = () => server.close(() => process.exit(0));`（`SIGTERM`/`SIGINT` 各绑一次，`:190-191`）。
- Node ≥19 起 `server.close()` 本身会关闭空闲连接（keep-alive 不再拖住退出）。**真正的缺口**是：没有截止时间，也没有 `closeAllConnections()`——一个正在等 API 的 SSR 请求最长可以撑 `15s × 2`（`apps/web/app/lib/api.server.ts:28` 的 `AbortSignal.timeout(15_000)`），而 `docker-compose.yml` 只给 api/worker 设了 `stop_grace_period: 515s`（`:81`），web 用默认 10s → 第 10 秒被 SIGKILL。
- SSR 取数：`apps/web/app/lib/api.server.ts:23` `apiGet`（15s 超时；非 2xx 抛 `ApiError`）；`:58` `loadOr404` 把"非 `ApiError`"一律兜成 `data({message:"unavailable"}, 503)`。所以 API 不可达时读者等 15 秒才看到 503。
- api 健康检查间隔 15s（`docker-compose.yml:61`）。

### 5.2 改动清单

**A. 退出兜底（`apps/web/server.ts:189`）**

```ts
/** Docker's default stop grace is 10s (api/worker set 515s at docker-compose.yml:81); exit well inside it. */
const SHUTDOWN_GRACE_MS = 8_000;
const shutdown = () => {
  const forced = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, SHUTDOWN_GRACE_MS);
  forced.unref();
  server.close(() => { clearTimeout(forced); process.exit(0); });
  server.closeIdleConnections();   // 显式写出来，不依赖 Node 版本默认行为
};
```

配合 `docker-compose.yml` 的 web 服务加 `stop_grace_period: 20s`（给 8s 截止 + 日志落盘留余量）。

**B. SSR 熔断（`apps/web/app/lib/api.server.ts`，模块级状态，不加配置项）**

```ts
const BREAKER_AFTER = 3;        // 连续 3 次连接层失败
const BREAKER_MS = 5_000;       // 短路 5 秒
let consecutiveFailures = 0;
let openUntil = 0;

/** Only transport failures count. An ApiError means the api answered — it is up, whatever it said. */
const transportFailure = (e: unknown) =>
  e instanceof ApiError ? false
  : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || e instanceof TypeError);
```

- `apiGet` 入口：`if (Date.now() < openUntil) throw new Error("api unreachable (circuit open)");`
- 捕获到 `transportFailure(error)` 时 `consecutiveFailures++`，达到 3 则 `openUntil = Date.now() + BREAKER_MS` 并把计数清零；成功解析响应时清零。
- **5xx/4xx 不计入**（`ApiError`），因此"API 在报错但活着"仍按原样 503，不触发短路。
- 短路抛的是普通 `Error`，`loadOr404` 走同一条兜底分支 → 响应仍是 `503 unavailable`，对读者和缓存语义零变化，只是从 15 秒变成毫秒级。
- 短路期间不打 `logError`（否则每次请求一条日志），只在进入短路时打一条 `{ msg: "ssr api circuit open" }`。

**默认值依据（约束 7 要求写清）**：单页 1–2 次 API 调用（`docs/architecture.md` 的"one or two requests per page"）；3 次连续 transport failure 在 loopback 上不可能是瞬时抖动；5 秒窗口小于 api healthcheck 的 15 秒间隔，所以 API 一恢复，最迟下一个页面请求就会重新尝试，读者最多多看到一次快速 503。

### 5.3 测试

`apps/web/tests/cache.test.ts`（真生产服务器 + `fakeApi`，失败域就是"页面与上游"），加一个用例：

1. `fakeApi` 连续返回 503：请求页面 → 仍是 503，且 fake API 的命中计数随请求增长（**证明 5xx 不触发熔断**）。
2. 关掉 fake API（`api.close()`）后连续请求 4 次页面：第 1 次耗时 ≈ 连接失败（毫秒级），第 2、3、4 次也都在 1 秒内（证明短路生效）；随后重启 fake API，5 秒后再请求 → 200（证明自动恢复）。
3. 每个用例都用新的 `startWebServer`（`web-server.ts:65` 用 `spawn` 起**独立子进程**），熔断状态天然隔离，不需要导出 reset。fake API 的"命中计数"用 `fakeApi` 的回调自增即可（`cache.test.ts:66` 就是这个形状）。

退出兜底改用例，但**先要暴露一个句柄**：`WebServer`（`web-server.ts:55-63`）只导出 `origin/port/logs/stop`，`stop()` 内部 `web.kill("SIGTERM")` 之后 `await once(web, "exit")`——**没有超时**。所以：

- 给 `WebServer` 加 `kill: (signal?: NodeJS.Signals) => void`（一行转调 `web.kill`），`stop()` 保持原样，别动现有 13 个用例。
- 新用例：`startWebServer` → 用 `http.Agent({ keepAlive: true })` 发一次请求并**留着一个空闲 socket**（`res` 读完不销毁 agent）→ `web.kill("SIGTERM")` → `assert` 在 2 秒内收到 `exit`（`Promise.race([once(child,"exit"), delay(2000).then(() => assert.fail("web ignored SIGTERM"))])`）。
- 顺带修一处测试基础设施缺陷：`stop()` 里那句 `await once(web, "exit")` 没有上限，将来真出现卡死，**整个 web 测试进程会挂住而不是报错**。加一个 10 秒兜底 `web.kill("SIGKILL")` 再 `await once`，让失败表现为"用例红"。

### 5.4 迁移与数据影响

无。`stop_grace_period` 是编排配置。

### 5.5 验收

- 本地：`docker compose stop web` 在有若干 keep-alive 连接时 1–2 秒内退出，日志有 `web stopped`（若加日志）。
- 故障演练：停掉 api，页面从"15 秒后 503"变成"首次 15 秒、之后毫秒级 503"；重启 api 后 5 秒内恢复 200。
- `apps/web/tests/cache.test.ts` 全绿（含既有的缓存架构用例）。

### 5.6 风险与回滚

熔断会把"API 刚恢复"掩盖最多 5 秒；回滚 = 删掉那约 12 行状态与两处判断。三处互不依赖，可分别保留或分别回滚：`stop_grace_period`（编排）、`shutdown` 兜底（`server.ts:189`）、`web-server.ts` 的 `kill` + `stop()` 超时（测试设施）。

### 5.7 待拍板

1. `SHUTDOWN_GRACE_MS = 8s` 与 `BREAKER_MS = 5s` 是否接受。
2. 只改代码还是连带改 `docker-compose.yml`（不改 compose 的话，8s 截止仍小于 10s 默认，能过，但没有余量）。

---

## 6. P2-08（剩余）：并发归组测试 + 跨日窗口测试

### 6.1 现状确认

- 测试库隔离：`tests/databases.ts:1-8`——每个测试文件一份 `*_ci` 副本，可并行；`npm test` 连真实 PostgreSQL。
- 时区：`tests/source-dates.standalone.test.ts:78-90` 已在四个 `TZ` 下循环（UTC / Asia/Shanghai / America/New_York / Europe/Berlin），但那是**日期解析**，不是日报窗口。
- 日报窗口：`reports/compose.ts:100-101` `end = beijingAt(date, EDITION_TIMES.daily)`、`start = end - 24h`；`site/site.ts:12` `EDITION_TIMES.daily = "07:00"`。归属按**到达/放出时间**而不是时间线日期：`reports/edition.ts:110-121`（`discovered_at` 或 `visible_after`，二者取晚）与 `:227-234`（picks）、`:319-324`（judged）。
- 现有边界测试只有"出刊时间前 60 秒"：`tests/reports.test.ts:27-33`（`dueDaily(editionAt(..., -60))`）。**没有** 23:59 / 00:01。窗口归属的测试在 `tests/report-candidates.test.ts:53-90`（`-120`/`-60`/`0`/`+120` 秒四个边界 + `candidates(start, end)`），同样**没有** 23:59 / 00:01。
- 并发：`jobs/events.ts:12` 串行；`group.ts:402` 输入事务 `FOR UPDATE`、`:354` `CurrentRevision`、`:679` 故事行锁；但 `stories`/`facts` 无唯一约束（`0002_events_reports.sql:3-14`、`:51-63`，`group.ts:123`/`:142` 裸 INSERT）→ **跨文章并发不安全**。
- 造数助手：`tests/content-publication.test.ts:38-70`（`source`/`story`/`report`）、`tests/hot.test.ts:30-52`（`source`/`signal`）、`tests/events.test.ts:72` `report(suffix, title = FACT_TITLE, summary = "摘要", publishedAt)`（走 `upsertMaterial` + `publishArticle`，且 `title_zh` 默认就是本文件 `before` 里预置的 `FACT_TITLE`，所以召回必然命中那个 fact——这是写"第二篇同事实"用例的最短路径）；时间工具 `tests/setup.ts:111` 的 `editionAt`。

### 6.2 改动清单

**A. 跨午夜：调度口径与窗口口径（拆到两个各自已是这个失败域的文件）**

A1 — `tests/reports.test.ts:27-33` 那个纯函数用例里追加 4 行（该文件本来就在守 `dueDaily` 的边界，且这个用例不碰 DB）：

```ts
// 边界是 07:00，不是午夜：跨过 00:00 仍是"昨天那一期该出"
assert.equal(dueDaily(editionAt("daily", "2020-02-10", -25_260)), "2020-02-09", "前一天 23:59");
assert.equal(dueDaily(editionAt("daily", "2020-02-10", -25_140)), "2020-02-09", "00:01 与 23:59 是同一期");
assert.equal(dueDaily(editionAt("daily", "2020-02-10", -60)), "2020-02-09", "06:59 仍在同一期");
assert.equal(dueDaily(editionAt("daily", "2020-02-10", 60)), "2020-02-10", "07:01 才切期");
```

A2 — `tests/report-candidates.test.ts` 追加一个用例（该文件已有 `analyzed()`/`selected()`/`candidates()`，头注释就是"跨越出刊时间的放行归属"，跨午夜是同一失败域的自然延伸，不新开文件）：

```ts
test("midnight stays inside one issue: the window boundary is the edition time", async () => {
  const date = "2020-02-10", prev = "2020-02-09", next = "2020-02-11";
  const at = (day: string, seconds: number) => editionAt("daily", day, seconds);
  // 02-10 这一期的窗口是 [02-09 07:00, 02-10 07:00)：午夜在窗口内部，偏移量是 -7h
  const late = await selected("23:59", at(date, -25_260), at(date, -25_260));   // 02-09 23:59
  const midnight = await selected("00:01", at(date, -25_140), at(date, -25_140)); // 02-10 00:01
  const edge = await selected("06:59", at(date, -60), at(date, -60));            // 02-10 06:59
  const afterEdge = await selected("07:01", at(date, 60), at(date, 60));         // 02-10 07:01

  const inIssue = async (start: string, end: string) =>
    new Set((await candidates(at(start, 0), at(end, 0))).map((c) => c.itemId));
  const thisIssue = await inIssue(prev, date);
  const nextIssue = await inIssue(date, next);
  for (const id of [late, midnight, edge]) {
    assert.equal(thisIssue.has(id), true, "arrived before 07:00, belongs to this issue");
    assert.equal(nextIssue.has(id), false);
  }
  assert.equal(nextIssue.has(afterEdge), true, "07:01 is the next issue's");
  assert.equal(thisIssue.has(afterEdge), false);
});
```

为什么不复用 `composeDaily` + 读 `sections`：一期里的条目会按 `arrangeDaily` 的 flashes / 一源两条 / highlights 规则搬运（`report-candidates.test.ts:79-90` 为此专门写了同时读 `sections` 与 `flashes` 的辅助），断言"哪几篇在这一期"会被排版规则污染。`candidates(start, end)`（`reports/edition.ts:153`）就是窗口本身，**窗口语义用窗口函数断言**，排版语义另有 `daily-highlights.test.ts` 在守。

**B. 第二篇同事实报道不改动第一篇的归属（`tests/events.test.ts`，追加）**

```ts
test("a second report of the same fact joins the existing event and leaves the first one attached", async () => {
  hold = gate(); hold.open();                          // 与同文件其它用例一致：让桩模型立刻作答
  const factsBefore = (await sql`SELECT count(*)::int AS n FROM facts WHERE story_id = ${storyId}`)[0]!.n;
  const storiesBefore = (await sql`SELECT count(*)::int AS n FROM stories`)[0]!.n;

  const a = await report("seat-a");
  assert.equal((await groupArticle(a)).verdict, "same-fact");
  const b = await report("seat-b");                    // 同一事实的第二篇
  assert.equal((await groupArticle(b)).verdict, "same-fact");

  // 事件没有被建两遍：story 与 fact 数量不变，b 加入的是 a 已有的那个 fact
  assert.equal((await sql`SELECT count(*)::int AS n FROM facts WHERE story_id = ${storyId}`)[0]!.n, factsBefore);
  assert.equal((await sql`SELECT count(*)::int AS n FROM stories`)[0]!.n, storiesBefore);
  const memberships = async (id: string) =>
    (await sql<{ fact_id: number }[]>`SELECT fact_id FROM fact_articles WHERE article_id = ${id}`).map((m) => Number(m.fact_id));
  assert.deepEqual(await memberships(b), [factId]);

  // 别人加入不把 a 挤出去：仍恰好一条归属，且仍指向同一个 fact 与 story
  assert.deepEqual(await memberships(a), [factId]);
  const [pub] = await sql<{ fact_id: number | null; story_id: number | null }[]>`SELECT fact_id, story_id FROM publications WHERE article_id = ${a}`;
  assert.deepEqual({ fact_id: Number(pub!.fact_id), story_id: Number(pub!.story_id) }, { fact_id: factId, story_id: storyId });

  // 同一篇再走一遍：kept，不新建、不询问
  const hits = provider.hits();
  const again = await groupArticle(a);
  assert.equal(again.verdict, "kept");
  assert.equal(again.factId, factId);
  assert.equal(provider.hits(), hits);
  assert.deepEqual(await memberships(a), [factId], "a repeat pass does not attach it twice");
});
```

**这条用例故意不断言 `seat` / `sort_at` unchanged**：归组会经 `publishArticle` 走到 `settleSeats`（`publication/publish.ts:178-207`），对**整个 fact 的成员**重算代表席（`pickRepresentative`），所以后来那篇更"好"的报道合法地抢走卡片位。把 `seat` 冻住等于把 bug 写进测试。同理也不要断言 `selected`——`report()` 造出来的 `analyses.selected` 是 `false`（`tests/events.test.ts:77`），那条断言恒真，毫无强度。

**C. 串行守卫（`tests/architecture.test.ts`，追加，源码扫描）**

```ts
test("grouping stays serial: no database constraint stops two workers from founding the same event", () => {
  const src = readFileSync(path.join(ROOT, "packages/backend/src/jobs/events.ts"), "utf8");
  assert.match(src, /QUEUES\.group,\s*\{\s*localConcurrency:\s*1\b/,
    "grouping must stay at localConcurrency 1: facts and stories have no unique constraint (group.ts:123/142), " +
    "so two processes grouping different reports of the same event would found it twice");
});
```

### 6.3 测试要写清的边界（写进用例注释，不用代码表达）

- **跨文章并发不安全**，且这是设计前提而不是遗漏：`localConcurrency: 1` 是唯一的保护。要真正支持多 worker，得先给 `facts` 加"同一事件"的唯一键或全局 advisory lock——那是改造项，不在本轮。
- 因此本轮**不写** "`Promise.all` 两篇不同文章不重复建事件"的测试：它现在会红，红了也不是回归。

### 6.4 迁移与数据影响

无。

### 6.5 验收

- 把 `jobs/events.ts:12` 的 `localConcurrency: 1` 临时改成 2 → 架构用例立刻变红（这是它唯一要证明的事）。
- 把 `compose.ts:100-101` 的窗口改成"自然日 00:00–24:00"（`start = beijingMidnight(date)`、`end = beijingMidnight(date)+1d`）→ A1 的 00:01/06:59 两条与 A2 的三条 `thisIssue`/`nextIssue` 断言一起变红（00:01 会被算到下一期）。
- 把 `group.ts` 里 `same-fact` 分支改成"每次新建 fact" → B 用例的 `facts`/`stories` 计数断言变红。
- 把 `group.ts:402` 的输入事务 `FOR UPDATE` 删掉 → B 用例**仍绿**（`markGrouped` 按 revision 更新，单篇文章两条路径都幂等）。如实写进用例注释：它守的是"第二篇归属正确、第一篇不被挤掉、重复归组幂等"，**不守锁、不守跨文章并发**。别让后人以为它保护了并发。

### 6.6 风险与回滚

纯测试，无生产代码改动；回滚 = 删掉三个用例。唯一维护成本：B 用例的 `report()` 依赖本文件 `before` 里预置的 `storyId`/`factId`（召回桩必须命中它），将来若改 `tests/setup.ts` 的 embeddings 桩或 `RECALL_MIN_COSINE`，这条要跟着调数字；注释里写明它断言的是"归属与幂等"，不是具体召回分数。

### 6.7 待拍板

1. 要不要一个真正的双进程集成测试（起第二个 worker + 独立库副本）来验证"多 worker 会重复建事件"？成本较高，且结论已知；我倾向不写。

---

## 7. 实施顺序与依赖

| 顺序 | 项 | 为什么在这个位置 | 依赖 |
|---|---|---|---|
| 1 | 项 2a（顺序 + `scoresSelect` + 金标解析断言） | 纯测试、零风险，先把门槛护栏立起来，后面谁动 `selection.ts` 立刻红 | 无 |
| 2 | 项 3（测量） | 只读，产出数据；同时验证"池规模/召回占比"这两个前提，决定项 6 与后续改造 | 无（可与 1 并行） |
| 3 | 项 6（跨午夜窗口 + 第二篇归属 + 串行守卫） | 纯测试，锁住现有行为；串行守卫是项 1 改 `jobs/*` 时的安全网 | 项 3 的结论（确认串行是唯一保护） |
| 4 | 项 5（退出兜底 + 熔断） | 独立于前四项，可随时插入；`stop_grace_period` 与项 1 都想改 compose，一起提交 | 无 |
| 5 | 项 1（A 或 B） | 要先拍板；A 案改 `main.ts` 与 `jobs/*`，在项 6 的串行守卫之后做 | 项 6（守卫） |
| 6 | 项 4（引用规范化） | 要发迁移 `0176` + 回填脚本 + 切换读取，是三段式上线；且**必须先测量**，可能直接砍掉 | 项 3 的测量方法可复用（都在算"这条查询值不值得"） |

冲突面：项 1 与项 6 都碰 `packages/backend/src/jobs/*`（一个改注册、一个加断言），先项 6 后项 1 可避免一次重排；项 4 独占 `reports/*` 与 `publication/reports.ts`，与其它项无交集；项 5 独占 `apps/web/*`。

---

## 8. 一句话总结

六项里真正"必须现在做"的只有 **项 2a 的三条断言**（成本半小时，挡的是以后每一次改门槛）和 **项 6 的三条新用例 + 四行断言**（锁住"串行是唯一并发保护"这个容易被后人当成 bug 去修的事实，以及"窗口边界是 07:00 不是午夜"）。项 4 要先测再决定，项 1 要先拍板，项 3 只出测量。
