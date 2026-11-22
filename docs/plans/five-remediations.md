# 5 项整改的可实施方案

基线：`4f35671`（2026-11-22，autohot）。以下行号均为实测。只写方案，未改代码。

## 与任务书的 4 处偏差（以实测为准）

| # | 任务书说法 | 实测 | 影响 |
|---|---|---|---|
| 1 | 历史数据靠“已有的 publication.republish-source **定时作业**”收敛 | `schedules.ts` 无该 cron。`requestRepublish`（`jobs/publication.ts:15`）只在后台改信源时入队，`republishSource` 由该队列消费 | **方案必须补一次性触发手段**，否则历史数据永不收敛 |
| 2 | `provenance.ts:78` | 实际是 `packages/backend/src/content/provenance.ts:78` | 仅路径笔误 |
| 3 | `hasItemPage` 四个调用点 | 五个：`og.ts:17`、`availability.ts:17`、`detail.ts:92`、`detail.ts:219`、`content/provenance.ts:78` | 项 1 影响面描述需含 `:219` |
| 4 | `hot.ts:177` 的 `WHERE merged_into IS NULL` | `:177` 是 `heatRows` 的聚合查询；补算查询在 `:295-303`，确实没有该过滤。`HEAT_WINDOW_HOURS=48` 在 `:59` | 项 2 结论不变，行号需修正 |

---

## 项 1：BLOCK 内容收进 withdrawn

### 1.1 现状确认

- `publication/publish.ts:307` `relevance` 已在作用域；`:310-313` visibility 推导：
  ```ts
  const visibility = source.participation_mode === "isolated"
    ? "withdrawn"
    : (override?.visibility ?? (withdrawnByAnalysis || (suppressOriginal && !title) ? "withdrawn" : "public"));
  ```
- `publication/rules.ts:67` `hasItemPage` 只看 `visibility`/`sourceMode`，与任务书判断一致；五个调用点如偏差表 3。
- 池与精选早已排除 BLOCK：`publish.ts:316` 的 `isPoolEligible` 要求 `relevance === "pass"`，`isSelectable` 依赖 `eligible`。**泄漏面只有详情页、OG 图、availability 接口、provenance 的“曾可读”判断**。
- `detail.ts:86-88` 注释明确写“items the lists leave out (low relevance…) keep a noindex page”，这是有意设计，本次改的是这个设计。
- `sitemap` 实际不受影响：`rules.ts:94` 的 `isIndexable` 要求 `selected || seoIndexedAt`，BLOCK 两者皆无。

### 1.2 改动清单

**A. `publication/publish.ts:310-313`**（唯一的规则落点）
```ts
const visibility = source.participation_mode === "isolated"
  ? "withdrawn"
  : (override?.visibility
      ?? (withdrawnByAnalysis || relevance === "block" || (suppressOriginal && !title)
            ? "withdrawn" : "public"));
```
`override?.visibility` 仍在最外层：管理员显式设为 public 的 BLOCK 条目保持可见，这是人工覆盖优先的既有语义。

**B. `publication/detail.ts:86-88` 注释**改写为：低相关条目不再保留页面（随投影为 withdrawn 一并 404）；“合并重复、暂无中文摘要”仍保留 noindex 页。

**C. `publication/rules.ts:67` 不动**，在函数上方补一句注释：BLOCK 的不可见由投影侧 `publish.ts` 落成 withdrawn，`hasItemPage` 不读 relevance（它拿不到，`publications` 也无该列）。

**D. 新增 `scripts/republish-blocked.ts`**（一次性运维脚本，不常驻、不加开关）
```ts
// 用法：node scripts/republish-blocked.ts
//
// 与队列路径（jobs/publication.ts:25-35）的唯一差异：热榜重排（:27-30 的
// `if (result.reduced > 0) await computeHotRanking()`）在队列里是**每个源**触发一次，
// 本脚本在全部源循环结束后补一次。语义等价（最终都重排到最新状态），且避免 N 个源重排 N 次。
// emit("sourceRepublished") 仍逐源发出，与队列一致（当前无模块实现该 hook，调用是空转，成本为 0）。
installModules(SERVER_MODULES);
const sources = await sql`SELECT id FROM sources WHERE participation_mode = 'editorial'`;
let reduced = 0;
for (const s of sources) {
  const r = await republishSource(s.id);
  reduced += r.reduced;
  if (r.total > 0) await emit("sourceRepublished", { sourceId: s.id });   // 同 jobs/publication.ts:33
  console.log(s.id, r);
}
// 队列在 reduced>0 时立刻重排（jobs/publication.ts:27-30）；脚本绕过队列，必须自己补，
// 否则大量 BLOCK 由 public → withdrawn 后，热榜可能仍挂着这些条目直到下一次 5 分钟快照。
if (reduced > 0) await computeHotRanking();
await closeDb();
```
结构照抄 `scripts/rebuild-timeline.ts:1-13`。**为什么不写 SQL UPDATE**：绕过 ledger、seat、`reduced` 统计与 IndexNow 变更采集，后续无法解释“为什么这些 URL 消失了”。**为什么不能只调 `republishSource` 就完事**：队列包装里还有热榜重排与 `sourceRepublished` 事件两件事，直接调函数会把它们一起跳过；本方案让 `reduced` 必然大量为真，漏掉重排的后果比平时更明显。

### 1.3 副作用（必须写进 PR 说明）

- `publish.ts:437-444` 的 `reduced` 会为 true。走队列时由 `jobs/publication.ts:27-30` 触发 `computeHotRanking()`；**本方案的一次性脚本绕过队列**，已在 1.2-D 里补了循环结束后的那一次重排，不要漏。
- 撤回 URL 会进入 `seo.indexnow` 的“变更”集合，随每小时任务提交（`operations/indexnow.ts:20-23`）。**注意语义**：它只表示“这个 URL 变了”，不声明删除；引擎重新抓取后自行决定去留。且只有 `INDEXNOW_SUBMIT_ENABLED` 与 key 都配置时才真正发出，否则只在 `indexnow.watermark` 里记账。属于外向动作，但不是不可逆的删除请求。
- `og.ts:17` 返回 null → `/og/items/:file` 对这些条目 404（`routes/og.ts:54-55`）。分享卡是否回落默认图取决于 web 侧 meta 兜底，本次未验证，验收时抽查 3 个页面的 `og:image`。
- `availability.ts:17` 这些 id 变为 unavailable，前端预取会拿到该状态。

### 1.4 测试

`tests/publication.test.ts`（BLOCK 相关断言已在 784-792 附近）新增：
1. BLOCK 文章 publish 后 `publications.visibility === "withdrawn"`，`loadItemDetail` 返回 `not_found`。
2. `editorial_overrides.visibility='public'` 时仍为 `public`（覆盖优先）。
3. `content/provenance.ts:78` 的 `wasReadable` 对 BLOCK 为 false（防止撤回记录被误判为“从未公开”）。

### 1.5 迁移与数据影响

无迁移。存量靠 1.2-D 的脚本收敛；脚本幂等，可重复跑。**执行顺序**：先发代码 → 再跑脚本（否则脚本按旧逻辑仍写 public）。

### 1.6 验收

```sql
-- 用每篇最新一次分析，避免 analysis_id 为空的老行被漏数。
-- 排除有 visibility 人工覆盖的行（publish.ts:310 的 override 优先是既有语义，1.2-A 保留），其余必须全为 withdrawn。
SELECT count(*) FROM publications p
JOIN LATERAL (SELECT relevance FROM analyses a WHERE a.article_id = p.article_id ORDER BY a.id DESC LIMIT 1) a ON true
WHERE a.relevance = 'block'
  AND p.visibility <> 'withdrawn'
  AND NOT EXISTS (SELECT 1 FROM editorial_overrides o
                  WHERE o.article_id = p.article_id AND o.visibility IS NOT NULL);   -- 0
```
另抽查 3 条 BLOCK 的 `/api/site/items/:id` 返回 404。

### 1.7 风险与回滚

代码回退 + 再跑一次脚本即可恢复可见性。IndexNow 已提交的“变更”会在下次发现时再次提交（`indexnow.watermark` 按 URL+revision 指纹比对），无需手工干预；搜索引擎侧的收录恢复有延迟。

---

## 项 2：story_heat_hourly 保留策略

### 2.1 现状确认

- `0002_events_reports.sql:106-112`：PK `(story_id, hour)`，`story_id` 有 `ON DELETE CASCADE` → **确实无孤儿行**。
- 读取点只有两处，均过滤 `complete`：`hot.ts:311-313`（`heatSeries`，默认 `days=7`，调用方 `stories.ts:157` 用默认值）、`stories.ts:203-218`（sparklines，`SPARK_HOURS=24`）。
- 保留：`retention.ts` 的 `dailyRetention` 不碰该表；`hot.ts:263` 只清 `hot_rankings` 30 天。
- 补算：`hot.ts:295-303` 的 `stale` 查询无 `merged_into` 过滤。已合并故事的信号在 `merge.ts:23-25` 被搬到存活故事，`heatRows` 对它返回空行，于是 `saveHeat([])` 什么也不写 —— **每小时被选中、每小时白跑一次，永不修复**。

### 2.2 改动清单

**A. `events/hot.ts:295-303`** 补算查询加过滤：
```sql
WHERE NOT complete AND hour < ${hour} AND hour > ${windowStart}
  AND story_id IN (SELECT id FROM stories WHERE merged_into IS NULL)
```

**B. `operations/retention.ts` 的 `dailyRetention`** 增加一段（与既有删除并列，返回计数）：
```ts
const heatHours = await sql`DELETE FROM story_heat_hourly WHERE hour < ${new Date(now.getTime() - 30 * 86400_000)}`;
// return { ..., deletedHeatHours: heatHours.count }
```

**C. 新迁移 `database/migrations/0174_story_heat_hour_retention_index.sql`**
```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS story_heat_hourly_hour_idx ON story_heat_hourly (hour);
```
理由：PK 首列是 `story_id`，按 `hour` 范围删除会全表扫；该表只增不减，越晚加锁越久。符合 0055 起的单语句与 `CONCURRENTLY IF NOT EXISTS` 规范。

**D. 保留期取 30 天的理由**：最长的读取窗口是事件页 7 天（`heatSeries` 默认），热榜 sparkline 24 小时；30 天是 4 倍余量，且与本仓库其他表的保留期（`job_runs` 30 天、`hot_rankings` 30 天）一致。不做“每月/每年趋势”预留。

**E. 不做**：在 `merge.ts` 事务里顺带删除被并故事的 incomplete 行。会把合并事务变重，收益只是提前 30 天回收，交给 A + B 即可。

### 2.3 测试

`tests/hot.test.ts`（已有 `snapshotHeat` 用例，:138 起）新增：
1. 造一个 incomplete 行 + `stories.merged_into` 非空，跑 `snapshotHeat`，断言该行未被改写、且 `repaired` 不因它增加。
2. `dailyRetention` 删除 30 天前的行、保留 29 天的行（构造两行，跑一次，查表）。

### 2.4 迁移与数据影响

只有 C 的索引，无回填。存量老行在首次 `ops.retention`（每日 03:30）后按 30 天清掉；首次删除量可能较大，单条 DELETE 即可，若线上行数超千万再考虑分批（当前无需）。

### 2.5 验收

```sql
-- 补算不再纠缠已合并故事：连续两小时快照后，仍为 incomplete 且故事已合并的行数不增长
SELECT count(*) FROM story_heat_hourly h JOIN stories s ON s.id = h.story_id
WHERE NOT h.complete AND s.merged_into IS NOT NULL AND h.hour > now() - interval '2 hours';
-- 保留生效
SELECT count(*) FROM story_heat_hourly WHERE hour < now() - interval '31 days';  -- 0
```

### 2.6 风险与回滚

风险低。索引可 `DROP INDEX CONCURRENTLY`；删除策略回退只需去掉 retention 里那一段，历史行不再增长但已删数据不可恢复（趋势只读 7 天，无业务影响）。

---

## 项 3：迁移加固

### 3.1 现状确认

- `scripts/migrate.ts:51` 建 `schema_migrations(name, applied_at)` 并逐条记账；`:96` `finally` 里 `session.release()`。
- `scripts/check-migrations.ts:13-16` 以 `git ls-tree base` 逐文件比对内容，已发布迁移不可改。
- `.github/workflows/check.yml:52` `MIGRATION_BASE: ${{ github.event.pull_request.base.sha || github.sha }}` → push 到 main 时 base=HEAD，`before` 集合与当前集合相同，内容比对恒过。
- 无 advisory lock：`setup` 容器若与手工 `node scripts/migrate.ts` 并发，两边都会读到“未应用”并各自执行。

### 3.2 改动清单

**A. `scripts/migrate.ts`：插在 `try {` 之后、现有那两条 `SET` 之前**（不是“`CREATE TABLE` 之前”——那个位置有两种解释，照错的解释实施会直接坏掉）

现有代码（`:47-51`）：
```ts
const session = await sql.reserve();
try {
  await session`SET lock_timeout = '1s'`;
  await session`SET statement_timeout = '10s'`;
  await session`CREATE TABLE IF NOT EXISTS schema_migrations (...)`;
```
改成：
```ts
const session = await sql.reserve();
try {
  // 等锁期间必须解掉 statement_timeout，否则 60s 的等待会被下面的 10s 掐成 query_canceled
  await session`SET lock_timeout = '60s'`;
  await session`SET statement_timeout = '0'`;
  await session`SELECT pg_advisory_lock(hashtext('aihot.schema.migrations'))`;
  // 恢复现有语义（与改动前 :49-50 一致），后续 DDL 仍受 1s/10s 约束
  await session`SET lock_timeout = '1s'`;
  await session`SET statement_timeout = '10s'`;
  await session`CREATE TABLE IF NOT EXISTS schema_migrations (...)`;   // 原有，不动
```
- **为什么顺序不能颠倒**：若把 `pg_advisory_lock` 插在那两条 `SET` 之后，第二个进程读到的是 `statement_timeout='10s'`，等锁 10 秒后被取消，报 `57014 query_canceled`（`canceling statement due to statement timeout`），而不是等完再输出 “database is up to date”。这是本条最容易实施错的地方。
- `SET statement_timeout = '0'` 是不限时，只覆盖"等锁"这一段；紧接着恢复成 `'10s'`，迁移语句本身仍受原有超时保护。后续每条迁移内部还会用 `set_config` 自行设定（`:63-64`），不受影响。
- 用阻塞式 `pg_advisory_lock` 而不是 `try_`：第二个进程应当**等待**前一个跑完，随后读到的账本已是最新，自然输出 “database is up to date”。
- 键用 `hashtext` 常量，不引入配置；必须用同一个 reserved session（session 级锁）。
- `finally`（`:95-97`）中在 `RESET` 之后、`release()` 之前执行 `SELECT pg_advisory_unlock(hashtext('aihot.schema.migrations'))`；连接关闭也会释放，显式释放便于测试观察。

**B. `.github/workflows/check.yml:48-53`** 改为脚本解析，覆盖三种边界：
```yaml
- name: Online migration safety
  run: |
    base="${{ github.event.pull_request.base.sha || github.event.before }}"
    zero="0000000000000000000000000000000000000000"
    if [ -z "$base" ] || [ "$base" = "$zero" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$base" HEAD; then
      base="$(git rev-parse HEAD~1 2>/dev/null || true)"
    fi
    if [ -n "$base" ]; then node scripts/check-migrations.ts --base "$base"; else echo "no baseline commit; skipped"; fi
```
覆盖：首次 push（`before` 全零）、force-push（`before` 非祖先）、对象取不到（`cat-file` 失败）。仓库的 checkout 已设 `fetch-depth: 0`（`check.yml:42-44`），`before` 对象在正常 push 上可取到，回退分支只在异常情况生效。

**C. 账本加 `sha256` 列：不做。** 理由：`check-migrations.ts` 已在 CI 对 base 做逐字内容比对，能拦住“改了已发布文件”；账本哈希只能在“运行期文件被改”时提供额外保护，而迁移文件在部署后不会变；加列要迁移、要回填、要改读取，收益接近 0。

### 3.3 测试

`tests/migrations.test.ts`（已存在）新增：
1. **并发不互踩**：两个 `sql.reserve()` 模拟并发——第一个持有 advisory lock，第二个 `runMigrations` 应阻塞等待而不是抛错或重复执行；第一个释放后，第二个读到最新账本、返回 `0`（`database is up to date`）。
2. **等待不受 `statement_timeout` 影响**（防"插入位置放错"回归）：用一个持有锁的 session，另起一个 session 按**错误顺序**（先 `SET statement_timeout='1s'` 再 `pg_advisory_lock`）取同一把锁，断言报 `57014` / `query_canceled`；再按**正确顺序**（`statement_timeout='0'` → 取锁）取锁，断言等待 3s 后成功拿到，未被取消。这条验的是"等锁不是被超时掐断"，只断言"最终成功"是验不出来的。
3. baseline 解析写在 workflow 的 shell 里、不进 Node，因此不为它造函数。手工验证一次：新建分支 → 改一个已发布迁移 → push 到 main，确认 CI 变红（改前为绿）。

### 3.4 迁移与数据影响

无迁移。advisory lock 不影响已有账本。

### 3.5 验收

- 同时启动两个 `node scripts/migrate.ts`：一个输出 `N migration(s) applied`，另一个等待后输出 `database is up to date`，无报错。
- 在分支上改一个已发布迁移并 push 到 main：CI 变红（此前为绿）。

### 3.6 风险与回滚

锁泄漏会让后续迁移永久等待；用 `lock_timeout=60s` 兜底，进程退出连接关闭也会释放。回退只需删两行。

---

## 项 4：成本可见（范围收窄为文档 + 告警）

### 4.1 现状确认

- `service_prices` 无种子是设计：`admin/costs.ts:70-85` 的 `upsertCostPrice` 带审计与咨询锁；`0010_service_prices.sql` 只建表。
- 预算按**次数**：`receipts.ts:240-257` 读 `budgets(per_minute, per_hour, per_day)`，与单价无关。
- `cost` 列语义是供应商返回的真实费用（`receipts.ts:341` 写 `outcome.cost?.amount`）；`balances.ts:174-180` 用 `cost IS NULL` 判“未计价”，回填估算会破坏错峰半价口径（`balances.ts:182-195` 用峰值价 ×0.5 折算）。
- **成本页已有空态**：`apps/web/app/routes/admin/costs.tsx:551` 显示“service_prices 表为空”，`:36` 按行标“未定价”。所以不重复造 UI。
- 缺的是：首次部署没人告诉运营要录价；不看成本页的人不会知道。

### 4.2 改动清单

**A. `docs/deploy.md` 的 `## 花多少钱`（:287 起）** 增加一段“首次部署后必须录价”：
- 路径：后台 → 成本 → 单价，逐服务/模型录入；
- 抄**供应商价目页的峰值价**，不要自己折算错峰；
- 错峰半价与节假日由代码按北京时间自动折算（`balances.ts:160-195`），价格表只存峰值价；
- 未录价时成本页显示“未定价”，预算熔断仍按次数生效（`receipts.ts:240-257`），不要误以为没在控量。

**B. `operations/alerts.ts` 新增 `costPriceFindings`**，在 `costSpendFindings`（:444）旁并列，由同一个 cost 段落（:594-601）调用：
```ts
const PRICE_KEY = "cost.prices.missing";
async function costPriceFindings(): Promise<Finding[]> {
  const [r] = await sql<{ prices: number; uncosted: number }[]>`
    SELECT (SELECT count(*)::int FROM service_prices) AS prices,
           (SELECT count(*)::int FROM receipt_attempts
             WHERE cost IS NULL AND origin = 'live' AND started_at > now() - interval '1 day') AS uncosted`;
  if (!r || r.prices > 0 || r.uncosted === 0) return [];
  return [{
    key: PRICE_KEY,
    level: "later",
    title: "成本页没有单价，花费无法估算",
    detail: `过去 24 小时 ${r.uncosted} 次付费调用没有费用记录；去后台 → 成本，按供应商价目页录入峰值单价`,
  }];
}
```
- 用 `detail` 这一个字段，与相邻的 `backup.stale`（:261）、`sources.${p.problem}.${s.id}`（:301）一致：这两处都把"该做什么"写在 `detail` 里。
  > 精确说明：`FindingFields`（`notify/feishu.ts:80-92`）里 `impact` / `heals` / `action` / `detail` **都是可选字段**，所以用 `impact`+`action` 并不会 typecheck 失败。但 `formatAlert`（`feishu.ts:137`）只渲染 `impact`/`heals`/`action`，`detail` 只进 09:00 摘要——二者展现在不同地方。本条按 `detail` 写，跟随同目录绝大多数 finding 的写法；若要让"去后台录价"这句出现在飞书告警正文里（而不只在摘要），再补一个 `action` 字段即可，`detail` 保留。
- **口径说明（不要自作主张加过滤）**：`cost IS NULL` 会连 `status='pending'` 的 attempt 一起计入。这是有意的——`origin='live'` 与预算计数的口径一致（`receipts.ts:250`），且 24 小时内仍 pending 的调用确实是"未确认的花费"。不要额外加 `status IN ('received','failed')`，那会让"卡住的调用"从成本视野里消失。

**C. `operations/alerts.ts:594-601` 的清理**必须跟着加，否则 `cost.` 前缀在 :807 被跳过恢复通知，state 会永久残留并按 `REPEAT_MS` 反复提醒：
```ts
const priceFindings = await costPriceFindings();
for (const f of priceFindings) await tell(f);
if (!priceFindings.length) delete state[PRICE_KEY];
```

### 4.3 测试

`tests/alerts.test.ts`（成本类用例在 :213 起、:429 起）新增：
1. `service_prices` 空 + 一条 `cost IS NULL` 的 live attempt → `checkAlerts` 返回含 `cost.prices.missing`。
2. 插入一条价格后同日再跑 → 不再出现，且 `settings` 中该 key 被删除。
3. 无未计价调用（全有 cost）时不出现。

注意：现有用例往 `receipts` 插数据，本用例要插 `receipt_attempts`（`uncostedAttemptTotals` 的口径也是 attempts）。

### 4.4 迁移与数据影响

无迁移、无回填。历史 `cost IS NULL` 保持原样——它正是“未计价”的准确记录。

### 4.5 验收

- 空库首启：告警/运行页出现该提示；成本页仍显示“未定价”。
- 录价后下一轮：提示消失，成本页“今日花费”与 SQL 汇总一致：
```sql
SELECT sum(cost) FROM receipt_attempts WHERE started_at >= date_trunc('day', now());
```

### 4.6 风险与回滚

几乎无。若嫌吵，把 `level` 从 `later` 调到只在首次出现时提醒（`tell` 已有去重），或直接回退这一条 finding。

---

## 项 5：OpenAPI 路径一致性测试

### 5.1 现状确认

- `site/public/openapi-v1.json` 恰 25 个 path（已枚举）。
- 路由不是全静态：`v1.ts:151-162` 用 `for (const p of ...)` 批量注册 dailies/weeklies/monthlies；`agent.ts:87-104` 同样用循环。
- `app.printRoutes()` **不可用于枚举**：默认模式做前缀压缩，实测把 `/openapi-v1.json` 打成 `penapi-v1.json`；`commonPrefix:false` 下子路径是相对名，`/api/v1` 下只打印 `agent`、`items`，需自己重建树。已实测排除。
- `app.hasRoute({ method:"GET", url })` 实测：25/25 全部命中（`{x}` → `:x`）。但 `hasRoute` 只能单向（spec → 现实），无法发现“新增了路由却没写进 spec”。

### 5.2 改动清单

**A. `apps/api/src/app.ts`：`buildApp` 增加一个仅测试用的可选钩子**
```ts
import type { RouteOptions } from "fastify";
export async function buildApp(options?: { onRoute?: (route: RouteOptions) => void }): Promise<FastifyInstance> {
  const app = Fastify({ ... });
  if (options?.onRoute) app.addHook("onRoute", options.onRoute);
  ...
```
两行，无运行时行为变化，不是配置开关。**为什么必须改生产文件**：`onRoute` 必须在注册前挂载，而 `buildApp` 内部完成注册，外部拿不到挂载时机；替代方案（复制 app.ts 的 12 行注册代码到测试）会随生产代码漂移。

**B. 新增 `tests/openapi-paths.test.ts`**
```ts
const routes: Array<{ method: string; url: string }> = [];
const app = await buildApp({ onRoute: (r) => {
  const methods = Array.isArray(r.method) ? r.method : [r.method];
  for (const m of methods) routes.push({ method: m, url: r.url });
}});
await app.ready();
const norm = (u: string) => u.replace(/\{(\w+)\}/g, ":$1").replace(/\/$/, "");
const INTERNAL = new Set(["/api/v1", "/api/v1/*", "/openapi-v1.json"]); // v1.ts:221 readOnlyMethods
const actual = new Set(routes
  .filter((r) => r.method === "GET" && r.url.startsWith("/api/v1/") && !r.url.includes("*") && !INTERNAL.has(r.url))
  .map((r) => norm(r.url)));
const spec = (await app.inject("/openapi-v1.json")).json();
const documented = new Set(Object.keys(spec.paths).map(norm));
```
断言两条：
1. `documented ⊆ actual`（spec 里写了的都必须真实存在）；
2. `actual ⊆ documented`（真实存在的 v1 GET 都必须被文档化）。
最后断言 `documented.size === 25`，防止 spec 被整体删空导致双向空集通过。

**C. 为什么新开文件**：`public-categories.test.ts` 守的是“分类枚举在各出口一致”，失败原因与路径缺失无关；混在一起会让一次路径漏写报成分类失败。本文件只守“路径集合一致”，独立失败信息更准确。

**D. 范围划定**：`modules/*` 目前没有任何 `/api/v1` 路由（已 grep 确认）。`onRoute` 会捕获未来模块注册的 v1 路径，届时必须同步 spec——这是预期行为，写进测试注释。

### 5.3 测试本身怎么验

三条手工验证（改完自测，不进 CI）：
1. 删 spec 里 `/api/v1/hot-topics` → 测试红（方向 1）。
2. 在 `v1.ts` 加一条未文档化路由 → 测试红（方向 2）。
3. 现状 → 绿。

### 5.4 迁移与数据影响

无。

### 5.5 验收

CI 的 `npm test` 自然覆盖，无需改 workflow；本地 `DATABASE_URL=... npm test` 通过。

### 5.6 风险与回滚

`buildApp` 的签名向后兼容（可选参数），唯一调用方是测试。风险是未来有人用 `printRoutes` 式思路绕过——把理由写进注释即可。

---

## 待拍板

1. **项 1 的 IndexNow 副作用**：脚本执行后会给搜索引擎提交一批“变更”通知（前提是已启用 IndexNow）。若希望先观察再提交，可在 `INDEXNOW_SUBMIT_ENABLED=false` 的窗口执行脚本，之后再打开——但那样 watermark 里会积压一批待提交项，打开后仍会一次性发出。这是产品/SEO 取向，需你定。
2. **项 2 的保留期**：30 天是按现有读取窗口推的。若计划做“事件年度趋势”，需要提前改成 365 天（表体积约 12 倍），现在定比以后改便宜。

## 附：执行顺序

1. 项 3（迁移锁 + CI 基线）——先让后续迁移安全。
2. 项 2 的索引迁移（0174）——单独发，`CONCURRENTLY` 不锁表。
3. 项 1 代码 + 项 5 测试——互不影响，可同批。
4. 项 1 的一次性脚本——代码上线后执行（脚本自带 `computeHotRanking()`，不依赖队列）。
5. 项 4 文档 + 告警——随时可发。

---

## 修订记录

本版针对第三方逐行复核意见修订，共 5 处；其余内容（偏差表 4 条、各项行号与现状确认、执行顺序、两个待拍板项）保持原样。

| # | 位置 | 原问题 | 本次改法 |
|---|---|---|---|
| 1 | 项 3.2-A | 插入点写成"`reserve()` 之后、`CREATE TABLE` 之前"有歧义。紧邻 `CREATE TABLE` 之前已有 `SET lock_timeout='1s'` 与 `SET statement_timeout='10s'`（`scripts/migrate.ts:49-50`），照此插入会让 60s 等锁被 10s 掐成 `57014 query_canceled` | 插入点写死为"`try {` 之后、**现有两条 SET 之前**"，并给出完整顺序：`lock_timeout='60s'` → `statement_timeout='0'` → `pg_advisory_lock` → 恢复 `'1s'` / `'10s'`，附错误顺序的失败现象说明 |
| 2 | 项 3.3 | 并发测试只验"阻塞而非抛错"，验不出插入位置是否放对 | 拆成三条：并发等待后返回 up to date；**新增**"错误顺序报 `57014` / 正确顺序等待 3s 成功"的反向断言；baseline 解析仍走手工验证 |
| 3 | 项 1.2-D | 注释称"走与队列完全相同的路径"不成立——直接调 `republishSource` 跳过了队列包装里的 `computeHotRanking()`（`jobs/publication.ts:27-30`）与 `emit("sourceRepublished")`（`:33`） | 脚本逐源补 `emit`（与队列一致），循环结束后按累计 `reduced > 0` 补一次 `computeHotRanking()`；头部注释写明与队列路径的差异及理由（最终态等价、避免 N 次重排）。项 1.3 的第一条副作用同步修正 |
| 4 | 项 1.6 | 两条验收 SQL 是包含关系（`visibility='public'` 是 `visibility<>'withdrawn'` 的子集），且第二条的"除非有 override"让期望值不可判定 | 合并为一条，排除 `editorial_overrides.visibility IS NOT NULL` 的人工覆盖行，期望值明确为 0 |
| 5 | 项 4.2-B | `Finding` 用了 `impact` + `action` 两个字段，与相邻 finding 的写法不一致；另 SQL 未过滤 `pending` | 改为单 `detail` 字段（附精确说明：`FindingFields` 里 `impact`/`action`/`detail` 均为可选，原写法不会 typecheck 失败，但 `formatAlert` 只渲染 impact/heals/action，故按 `detail` 统一；若需进告警正文再加 `action`）。补一句"`pending` 也计入未计价是有意口径"，禁止实施者自行加过滤 |

