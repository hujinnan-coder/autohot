# 第二梯队三项收尾方案

基线：`790a4c4`（HEAD，工作区另有 `industry/sources.json`、`modules/weibo-monitor/accounts.json` 两个无关改动与若干 `scripts/tmp-*` 未跟踪文件，均与本方案无关，不碰）。
来源：`docs/assessment-report.md` §9.1 第二梯队四项，其中「每月 pg_restore 演练」已由 `tests/backup.test.ts:92-114` 真实恢复测试覆盖，按任务书排除。本方案只覆盖余下三项。
**只写方案，不改代码。** 所有代码片段、行号、数字均实测于基线；承重断言逐条标注并用 grep 或只读查询验证。协议见 `docs/remediation-protocol.md`。

> **给验收方的三句摘要**：项 1 实测后**不做**（量级 6ms/5min，不值得引入语义风险）；项 2 **修正任务书前提**后给最小改法（坏结构时 `analyses` 根本不写行，`output` 里记标记的路走不通）；项 3 **维持不做**并正式关闭。推荐顺序：项 3 → 项 1 → 项 2（详见末节）。

---

## 项 1｜P2-03 热榜 N+1

### 结论先行

**不做，本项关闭。** 生产库只读实测：现状 20 次往返 ≈ 8.5ms，批量化 2 次往返 ≈ 2.3ms，绝对收益约 6ms/次、每 5 分钟一次 ≈ **1.7 秒/天**；且批量化要改写"前 10 个**有报道的**事件"这个易错语义，收益远小于风险。给出复核条件，触发再重估。

### ① 现状确认（代码片段）

循环与两条 SQL，出自 `packages/backend/src/events/hot.ts:190-215`：

```ts
  for (const r of rows) {
    if (entries.length >= 10) break;
    const reports = await sql<...>`
      SELECT DISTINCT ON (p.article_id) p.article_id AS id, ... f.id AS fact_id, ...
      FROM facts f JOIN fact_articles fa ON fa.fact_id = f.id JOIN publications p ON p.article_id = fa.article_id
      JOIN sources s ON s.id = p.source_id
      WHERE f.story_id = ${r.story_id} AND ${evidenceCondition()} AND ${listedCondition(at)}
      ORDER BY p.article_id, (fa.role = 'primary') DESC, f.id`;
    if (reports.length === 0) continue;
```

```ts
    const participants = await sql<...>`
      SELECT DISTINCT ON (cs.participant_key) s.name, cs.kind, s.tier, cs.observed_at AS at
      FROM ${currentSignals()} cs JOIN sources s ON s.id = cs.source_id
      WHERE cs.story_id = ${r.story_id} AND cs.observed_at > ${at}::timestamptz - make_interval(hours => ${HEAT_WINDOW_HOURS}) AND cs.observed_at <= ${at}
      ORDER BY cs.participant_key, (cs.kind = 'editorial') DESC, cs.observed_at DESC`;
```

- **承重断言 A**：`break` 条件在循环顶部（`entries.length >= 10`，`:191`），`if (reports.length === 0) continue`（`:199`）在 `reports` 查询**之后**、计数**之外**。→ 上限不是"前 10 个 story"，而是"扫到凑满 10 个**有代表报道**的 story 为止"，无报道的 story 不占名额但会先发 1 条 SQL。已逐行核对原文。
- **承重断言 B**：调度是 `apps/worker/src/schedules.ts:32` → `{ name: "hot.rank", cron: "*/5 * * * *", run: () => computeHotRanking() }`，每 5 分钟一次。另在 admin 重算、`jobs/publication.ts:30`、`scripts/republish-blocked.ts:23` 被事件触发，频率低。已 grep 确认。
- **承重断言 C（索引）**：查询按 `story_id` 走索引——`facts_story_idx ON facts (story_id)`（`0002_events_reports.sql:67`）、`story_signals_story_idx ON story_signals (story_id, observed_at DESC)`（`:93`）。`fact_articles` 只有 `article_id` 索引（`:79`），通过 `fa.fact_id = f.id` 由 `facts` 侧驱动。已 grep 全部 `database/migrations/*.sql` 确认。

### ② 量化：生产库只读实测

> 测量在 `DATABASE_URL`（`127.0.0.1:5432/autohot`，本地同版 PostgreSQL 18.7）上执行，全部为 `SELECT`，无写操作。可用同样的 SQL 在生产库复测。

**数据量**（`SELECT count(*) ...`，实测）：

| 表 | 行数 |
|---|---|
| `facts` | 1,615 |
| `fact_articles` | 2,754 |
| `story_signals` | 2,492 |
| `publications` | 7,927 |
| `stories`（`merged_into IS NULL`） | 1,334 |

**可复测的只读测量 SQL**（取热点候选 top10，可直接在生产库跑）：

```sql
-- top10 热点候选（按 signal 数近似 heat 排序，只为取一组真实 story_id）
SELECT story_id, count(*)::int c FROM story_signals GROUP BY story_id ORDER BY c DESC LIMIT 10;
-- 现状：每个 story 各发一条，共 20 条往返（在应用侧循环，此处给出单条形式）
SELECT f.story_id, count(DISTINCT p.article_id)::int AS reports
  FROM facts f JOIN fact_articles fa ON fa.fact_id=f.id JOIN publications p ON p.article_id=fa.article_id
  WHERE f.story_id = $1 GROUP BY f.story_id;
SELECT story_id, count(*)::int c FROM story_signals WHERE story_id = $1 GROUP BY story_id;
```

**实测结果**（同一连接、预热后各测一轮，含网络往返）：

| 方式 | 往返数 | 耗时 |
|---|---|---|
| 现状：10 story × 2 条逐条查询 | 20 | **8.51 ms** |
| 批量：`WHERE story_id = ANY($1)` 一次取回后 Node 分组 | 2 | **2.31 ms** |
| 差值 | −18 | **≈ 6.20 ms** |

平均单条 ≈ 0.43ms（本地同机，含往返）。**判断**：即便生产库跨可用区把单次往返抬到 2–5ms，20 条 → 2 条的收益也只在几十 ms 量级，按 5 分钟一次摊薄到可忽略。`hot.rank` 本身只是把结果 jsonb 写入 `hot_rankings`（`:257-263`），不阻塞请求路径，无尾延迟诉求。**不满足"值得做"的门槛。**

### ③ 不做理由与复核条件（本项正式关闭）

- **理由**：① 绝对收益 ≈ 6ms/5min（1.7 秒/天），在正确性、可读性上无任何改善；② 批量化必须改写 `:190-199` 的"跳过无报道 story"语义（见下），是本次任务书明确点出的易错点，为一个不可感知的性能收益引入榜单变短风险，收益/风险为负；③ 协议 §1-7：无"真实发生过或平台语义决定会发生"的问题证据——没有超时告警、没有慢查询记录支撑。
- **复核条件**（任一触发则重开本项）：
  1. `hot.rank` 单次执行 P95 > 1s，或 `job_runs` 出现该任务超时记录；
  2. top10 候选的代表报道查询单条 P95 > 50ms（说明数据量或查询计划已变化）；
  3. `facts`/`story_signals` 行数较本次基线（1,615 / 2,492）增长 10 倍以上；
  4. 调度频率上调到每 30 秒或更高。
- **关闭动作**：`docs/assessment-report.md` §9.1 第 6 项状态由 ❌ 改为「⚪ 测量后主动关闭（1.7s/天，见 `docs/plans/tier2-cleanup.md`）」，与该项 §顶部"2 项测量后主动砍掉"同类记账。

### 附：若复核触发、将来要做时的改法备存（本次不实施）

任务书要求的语义保持要点，留档供复核后直接派活：

- **先取全量候选，再在 Node 里筛"有报道的"前 10 个**。不能 `heatRows(...).slice(0,10)` 后批量查，否则命中 0 报道的高热 story 会让榜单变短。
- 步骤：① `heatRows(at, behind)` 已排序 → `rows`（全部候选，`:186-187`）；② 用 `rows.map(r => r.story_id)` 一次 `WHERE f.story_id = ANY($ids::bigint[])` 取回代表报道，按 `story_id` 分组进 `Map<number, Report[]>`；③ 一次 `WHERE cs.story_id = ANY($ids::bigint[])` 取回参与者，同样分组；④ **按 `rows` 原顺序**遍历，跳过 `map.get(id)` 为空或 `length===0` 的 story，凑满 10 个后 break。这样与现状 `:199` 的 `continue` 逐字等价。
- **守语义的测试**（隔离机制见下）：在 `tests/hot.test.ts` 加一条——造 12 个 story，其中热度最高的 3 个**无任何代表报道**（无 publications 行 / 全 withdrawn），其余 9 个有报道；断言 `computeHotRanking()` 落库 entries 仍为 9 个有报道的 story、`storyId` 按热度降序、且不含那 3 个。`break`/`continue` 两处都要被这条测试覆盖。
- 隔离机制：`tests/hot.test.ts` 现有模式——`const T = \`hot-${tag()}\``（`tests/setup.ts` 的随机 tag）作所有 fixture 的 id/url 前缀，测完 `after()` 里 `closeDb()`；新用例沿用 `T` 前缀造 story/facts/publications，不删他人数据。测试用固定 `AT = 2099-03-01` 避免与真实时间窗重叠。

---

## 项 2｜P0-05 尾巴：结构抽取降级的可见性

### 结论先行

**修正任务书前提后，给最小改法：只加只读统计 SQL + 在 `processing_error` 里补一个可枚举的降级标记（改 1 行 message 拼装），不加后台界面、不加迁移。** 关键事实：坏结构输出重试耗尽后，**`analyses` 表根本不写行**（现有测试已断言），所以任务书设想的"在 `analyses.output` 里记标记"这条路在当前代码下走不通——这是本项必须先纠正的承重错误。

### ① 现状确认：重试耗尽后文章实际走到哪一步

**完整链路**（4 段代码片段）：

1. 坏结构输出 → `ModelOutputError` + 拒收收据。`packages/backend/src/providers/llm.ts:237-245`：

```ts
  } catch (error) {
    const detail = response.choices?.[0]?.finish_reason === "length" ? ... : String(error);
    await rejectReceivedResponse(receipt.receiptId, `unusable output: ${detail.slice(0, 500)}`);
    throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${detail.slice(0, 300)}`, receipt.receiptId);
  }
```

> 注：任务书写的 `providers/llm.ts:244-245` 正确；`rejectReceivedResponse` 与 `throw` 在同一 catch 块。

2. 归类：`providers/receipts.ts:76-84` → `if (error instanceof ModelOutputError) return "unusable";`。

3. 重试计数与耗尽分支，`packages/backend/src/jobs/content.ts:188-197`：

```ts
  const [a] = await sql<{ processing_attempts: number }[]>`SELECT processing_attempts FROM articles WHERE id = ${articleId} AND revision = ${revision}`;
  if (!a) return { state: "stale" };
  const attempts = a.processing_attempts + 1;
  const refused = kind === "refused";
  const exhausted = attempts > RETRY_MINUTES.length || (kind === "unusable" && attempts >= MAX_OUTPUT_FAILURES);
  if (refused || exhausted) {
    await sql`UPDATE articles SET processing_state = 'failed', processing_error = ${message}, processing_attempts = ${attempts},
                processing_retry_at = NULL, processing_queued_at = NULL WHERE id = ${articleId} AND revision = ${revision}`;
    return { state: "failed" };
  }
```

`MAX_OUTPUT_FAILURES = 3`（`:21`）。`message` 来自 `:178` `String(error.message).slice(0,500)`。

4. **`analyses` 为什么不写**：`analyzeArticle` 在 `editorial/analyze.ts:593-599` 对非 content-refused 的异常直接 `throw`：

```ts
  try { run = await runAnalysis(input, opts); }
  catch (error) {
    if (!reviewer || !providerContentRefused(error)) throw error;
    ...
  }
```

`providerContentRefused` 只认 `failureKind === "refused"` 且带内容审查关键词（`providers/receipts.ts:144-146`），`unusable` 不匹配 → 必然 rethrow。而 `INSERT INTO analyses ...` 在 `:661-670` 的**后面**，根本执行不到。`tests/analyze.test.ts:213-220` 明确断言这一事实：

```ts
test("structure JSON with missing or invalid scope or fact is rejected", async () => {
  for (const marker of Object.keys(invalidStructures)) {
    const id = await article(marker);
    await assert.rejects(analyzeArticle(id), ModelOutputError, marker);
    const [receipt] = await sql`SELECT status FROM receipts WHERE purpose = 'structure_article' AND subject LIKE ${`article:${id}@%`}`;
    assert.equal(receipt?.status, "failed", marker);
    assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id = ${id}`).length, 0, marker);
  }
});
```

**落地事实汇总（对三张表各写了什么）**：

| 表 | 重试耗尽后 |
|---|---|
| `articles` | `processing_state='failed'`、`processing_error` = unusable 消息（含 Zod 报错路径）、`processing_attempts=3`、`processing_retry_at=NULL`、`processing_queued_at=NULL`。无其他状态。 |
| `analyses` | **无行**（异常在 `INSERT` 之前抛出；测试 `:219` 钉住）。`analyses.output` 是 jsonb（`0001_core.sql:190`），但这里没有行可写。 |
| `publications` | 无行（`publishArticle` 在 `jobs/content.ts:156` 只在分析成功后调用）。 |

**运营当前从哪里看出来**：`apps/web/app/routes/admin/content-item.tsx:104` 直接渲染 `a.processing_error`（红条），`apps/web/app/routes/admin/content.tsx` 是"内容诊断"页；另有 `admin/runs.ts:72-75` 用 `failureGroupSql()`（`content.ts:281-282`）把 `failed` 文章按错误文本前 120 字符分组统计。**即：单篇可见、按错误文本聚类可见，但"结构降级"与其它 `unusable`（如 UnderstandSchema 坏输出）在错误文本里混在一起，没有专门的、可精确统计的标记。** 这就是缺口。

### ② 最小改法（不加界面、不加迁移）

**任务书的两个候选都不选**：
- ❌ "在 `analyses.output` 里记一个标记"：走不通——坏结构时无 `analyses` 行（承重断言，已由 `tests/analyze.test.ts:219` + 源码 `:593-599/:661` 双重确认）。要落地得先写一条假 analysis 行，改变 `analyses` 语义、违反协议 §1 与现有测试，成本远大于收益。
- ❌ "进后台'内容诊断'页"：该页**已存在**（`admin/content.tsx:17`），无需新建；且按协议 §1-7 与 AGENTS.md，新界面属新功能需单独立项。不新开。

**✅ 推荐改法（两处小改）**：

**A. 给 `processing_error` 加一个稳定的降级标记**（1 处拼装）。在 `packages/backend/src/providers/llm.ts:245` 抛错时，把 `opts.purpose`（当前结构步骤传入 `"structure_article"`，见 `editorial/analyze.ts:323`）纳入消息，例如：

```ts
throw new ModelOutputError(
  `Model ${opts.model} returned unusable output [unusable:structure] for ${opts.subject}: ${detail.slice(0, 300)}`,
  receipt.receiptId);
```

或更稳妥：不改公共 llm 层，在 `processArticle` 的 `afterFailure` 里针对 `kind==="unusable"` 给 `message` 加前缀 `[structure-output]`——但那会把 Understand/Summarize 的坏输出也标成 structure，故**选前者**，`purpose` 是唯一能精确区分步骤的字段（承重断言：`analyze.ts:323` `purpose: "structure_article"`，已 grep 确认各步骤 purpose 不同）。

> 备选（若验收方不愿动公共 llm 层）：不改代码，靠统计 SQL 里 `processing_error LIKE '%"path":%' AND processing_error LIKE '%scope%'` / `%fact%` 识别。已实测 Zod 4.6.6 坏输出的 `String(error)` 形如 `... "path": [ "scope" ] ...`（本地 node 实验验证：坏 scope 报 `invalid_value` path `["scope"]`；缺/坏 fact 报 `invalid_type` path `["fact"]`）。但该文本被 llm.ts 截断到 300 字符、且随 Zod 版本漂移，**不如显式标记稳**，故作备选。

**B. 验收 SQL（只读，无需建视图/迁移）**：见 ④。运营既可在"内容诊断"页看单篇，也可跑这条 SQL 出汇总。

**为什么这就够**：协议 §1-7 的证据真实存在（Zod 严格化后坏输出确实走这条路，`tests/analyze.test.ts:213-220` 是回归测试）；运营缺口只是"无法精确筛选/统计结构降级"，一个稳定标记 + 一条 SQL 即可闭合，无需新列、新表、新界面。

### ③ 改动清单

1. `packages/backend/src/providers/llm.ts:245`：坏输出错误消息加 `[unusable:<purpose>]` 标记（1 行）；同步 `rejectReceivedResponse` 的 detail 是否带标记按需（收据详情已有完整 `unusable output:` 文本，可不改）。
2. `tests/analyze.test.ts:213-220` 的用例扩展断言：坏结构输出耗尽后，`articles.processing_error` 含 `[unusable:structure_article]`（把现有"无 analyses 行"断言保留）。
3. `docs/assessment-report.md` 附录/尾部口径：把 P0-05 的尾巴记为"以标记 + SQL 关闭，不新建诊断页"。

不改：数据库 schema、`analyses` 写入逻辑、`jobs/content.ts` 的 `exhausted` 分支语义、任何 web 路由。

### ④ 验收（可执行 SQL / 命令）

```sql
-- 1) 统计近 30 天结构抽取降级耗尽的文章数与近例（只读）
SELECT count(*)::int AS degraded,
       max(discovered_at) AS last_seen
FROM articles
WHERE processing_state = 'failed'
  AND processing_error LIKE '%[unusable:structure_article]%'
  AND discovered_at > now() - interval '30 days';

-- 2) 按错误文本聚类（复用后台同款分组，确认标记未破坏 runs 页分组）
SELECT regexp_replace(left(processing_error, 120), '[0-9a-f]{8,}|[0-9]{4,}', '…', 'g') AS error,
       count(*)::int AS n
FROM articles WHERE processing_state = 'failed' AND discovered_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

命令：`PATH="$HOME/.local/node/bin:$PATH" npm test -- tests/analyze.test.ts`（需显式 `DATABASE_URL`，库名以 `_test` 结尾；全量前 `DROP DATABASE autohot_test` 重建，见协议 §6）。

### ⑤ 测试与隔离机制

- 扩展 `tests/analyze.test.ts` 现有用例：沿用其 `article(marker)` fixture 与 `tag()` 前缀（`tests/setup.ts`），每条坏输出文章用独立 marker id，不与其他用例共享主键；断言收据 `subject LIKE article:<id>@%`（已隔离到单篇）。无新增全局状态，不需显式清理。
- 现有 `:219` 的"无 analyses 行"断言保持不变，防止有人将来误加假 analysis 行。

### ⑥ 迁移与数据影响

**无迁移、无回填。** `processing_error` 是 free text，`LIKE` 统计对存量行自动生效；存量旧行的错误消息无标记，不会被计入——这是可接受的（只统计改动后新发生的降级；若需历史口径，用备选的 Zod 文本匹配 SQL 补）。`analyses.output` 是 jsonb 但本方案不写入，不影响其数据。

### ⑦ 风险与回滚

- 风险：改公共 llm 错误消息可能让某条断言精确文本的测试失败——已 grep，现有测试只对 `ModelOutputError` 类型与 `purpose`/`status` 断言（`tests/analyze.test.ts:216-218`），不比全文；`failureGroupSql` 取前 120 字符仍会聚到同一组。
- 回滚：撤回 `llm.ts:245` 的标记拼装与测试扩展即可，无 schema/数据变更，可独立回滚。

---

## 项 3｜P2-04 尾巴：迁移账本的完整性

### 结论先行

**维持不做，本项正式关闭，并把结论补进 `docs/assessment-report.md` §9.1。** 唯一待判场景"生产库上某个已应用的迁移文件被人在部署包里改了"，在本项目 `docker-compose` 一次性 `setup` 容器 + 仓库构建镜像的部署方式下，要么 CI 拦下、要么属于已被更严重问题掩盖的纯人为破坏，加 sha256 列无法提供有意义的防护。

### ① 现状确认（代码片段）

账本表由 `migrate.ts` 自建、只记文件名，`scripts/migrate.ts:56-60`：

```ts
    await session`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await session<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
    let count = 0;
    for (const { name, text, plan } of prepared) {
      if (applied.has(name)) continue;
```

只看名字：已应用的迁移，`applied.has(name)` 为真 → 直接跳过，**不比对内容**。

CI 内容比对：`scripts/check-migrations.ts:12-17`：

```ts
  const before = new Set(git("ls-tree", "-r", "--name-only", base).split("\n").filter(isMigration));
  const current = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((file) => isMigration(file) && existsSync(path.join(root, file)));
  const problems: string[] = [];
  for (const file of before) {
    if (!existsSync(path.join(root, file)) || readFileSync(path.join(root, file), "utf8") !== git("show", `${base}:${file}`)) problems.push(`${file}: deployed migrations are immutable; add a new migration`);
```

部署方式：`docker-compose.yml:42-46`：

```yaml
  # Applies the database migrations and seeds the demo sources, then exits.
  setup:
    <<: *backend
    restart: "no"
    command: ["sh", "-c", "node scripts/migrate.ts && node scripts/seed.ts"]
```

`api`/`worker` 都 `depends_on: setup: condition: service_completed_successfully`（`:56-58, :82-84`）；`x-app`/`x-backend` 用 `build: .` + `image: aihot-app`（`:6-7, :10-11`），镜像由仓库构建。`check-migrations.ts` 的 `base` 参数在 CI 里传 PR 基线（`:35-36`）。

### ② 场景分析：那个改动是否真实可能发生

**承重断言 D（部署拓扑）**：迁移 SQL 随**镜像**分发（`build: .`），`setup` 是一次性容器，`restart: "no"`，跑完 `node scripts/migrate.ts` 即退出；没有把宿主机 `database/migrations/` 挂载进容器（`x-backend` 的 volumes 只有 `data:/data`，`:20-21`）。已核对 `docker-compose.yml` 全文。

要让"生产库已应用的迁移文件在部署包里被改"发生，只有几条路径：

| 路径 | 能否绕过 CI 内容比对 | 评价 |
|---|---|---|
| 开发改了已发布 `.sql` 并提交 | 不能——`check-migrations.ts:16` 逐字节比对 `base` 与当前文件，直接 fail | 已被挡 |
| 改文件但跳过 CI（强推 / 直接 build 镜像） | 能 | 但这需要写权限绕过 + 绕过 CI，属于流程失守；此时 sha256 账本同样可被改 `migrate.ts` 的人一并绕过，**不构成独立防线** |
| 直接在生产容器里改文件 | 每次部署 `build: .` 重建镜像且 `setup` 一次性，改动不持久；且改运行中的已退出 `setup` 容器无意义 | 不可行 |
| 手工删/改 `schema_migrations` 行让迁移重放 | 能 | 这是直接改库，与加不加 sha256 列无关 |

**判断**：唯一"技术上可能"的路径是"有人绕过 CI 强推改动 + 重建镜像"，而该行为本身已是比"账本无哈希"严重得多的权限/流程问题，且能绕过 CI 的人同样能改 `migrate.ts` 让哈希校验失效——**sha256 列不增加任何独立防护**。上一轮"收益接近 0"的判定成立。同时 `migrate.ts:56` 建表、`:60` 按名跳过，意味着即便加了哈希列，已应用迁移的内容变更也不会被重新执行或校验，除非另写检测逻辑（又是一套新机制，违反 §1-7）。

### ③ 不做理由与关闭动作

- **理由**：① CI 内容比对（`check-migrations.ts`）已覆盖正常发布流程；② 绕过路径属流程失守，哈希列非独立防线、可被同一 actor 绕过；③ 部署拓扑（一次性 setup + 镜像内 SQL）使"改了文件还被生产库应用"在正常运行中不可能；④ 上一轮复核已判"收益接近 0"（`assessment-report.md:219`）。
- **关闭动作**：在 `docs/assessment-report.md` §9.1 第 8 项（`:288`）把 `P2-04 sha256 账本列` 标为「⚪ 已关闭：部署拓扑 + CI 比对已足够，绕过即流程失守（见 `docs/plans/tier2-cleanup.md`）」，并在 §顶部"2 项测量后主动砍掉"口径里并入本项理由（与 sha256 同批记账）。

### ④ 迁移与数据影响 / 风险与回滚

无改动、无迁移、无数据影响、无回滚需求。本项产出仅为"关闭结论 + 文档记账"。

---

## 推荐顺序

| 顺序 | 项 | 动作 | 理由 |
|---|---|---|---|
| 1 | 项 3（P2-04） | 关闭 + 改 `assessment-report.md` 记账 | 零代码，纯文档，立即腾出一项；口径与既有"主动砍掉"一致 |
| 2 | 项 1（P2-03） | 关闭 + 记账 + 写复核条件 | 零代码，有实测数字支撑；关掉唯一"悬空"项，消除"没人管"的错觉 |
| 3 | 项 2（P0-05） | 小改：llm 错误消息加标记 + 测试扩展 + 验收 SQL | 唯一有代码产出者放最后——它要改公共 llm 层，且前提已修正（`analyses` 不写行），需验收方先确认修正后的方向再派活 |

**一句话**：三项里两项应关闭、一项缩小成"1 行标记 + 1 条 SQL + 1 条测试"。没有一项需要新界面、新列或新迁移。
