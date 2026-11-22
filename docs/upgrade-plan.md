# autohot 整改规划（v1，供交叉校验）

> 用途：把本轮代码级审计的结论整理成可执行、可验收、可被第三方逐条复核的整改计划。
> 校验方式：每条都给了 `文件:行号` 和复核命令；附录 A 有可直接跑的命令与 SQL，附录 B 列出了本轮**被推翻或降级**的旧结论。
> 基线：2026-11-22 工作区代码（未提交状态），PostgreSQL 17，Node 24。

---

## 0. 边界：这次整改不改变什么

以下全部保持不动，任何一条整改项都不得违反：

1. **产品定位**：汽车行业热点站，读者是汽车营销链条从业者。
2. **主流水线**：采集 → 判重/正文 → 预筛 → 双评分+写作 → 事件归组 → 热度 → 日报/周报/月报 → 多渠道发布。
3. **三进程架构**：web 只读 API、不连库不调模型；api 只读库和对外服务；worker 承担全部付费与写操作。
4. **判断标准文本化**：行业 KnowHow 写在 `industry/prompts/` 与 `industry/selection.ts`，不把规则硬编码进代码。
5. **付费可追溯**：所有模型/X/Jina 调用必须走回执（receipts），预算熔断与安全阀语义不变。
6. **单一公开读取层**：网页、RSS、API v1、MCP、Agent Markdown 必须共用 `packages/backend/src/publication/` 口径。

整改只做四件事：**修正确性缺陷、补可观测性、降单位成本、提可维护性**。

---

## 1. 证据分级（阅读前必看）

| 级别 | 含义 | 处理方式 |
|---|---|---|
| ✅ A | 本轮已直接读代码确认，行号可复现 | 可直接排期 |
| ⚠️ B | 代码路径成立，但影响面/数量需线上数据确认 | 先跑附录 A 的 SQL，再决定是否排期 |
| ❓ C | 依赖部署环境或外部服务行为，本地无法判定 | 列为待拍板，不排期 |

每条整改项标注级别。**A 级不成立即视为本计划失效**，请直接驳回该条。

---

## 2. 总览

| ID | 优先级 | 模块 | 问题一句话 | 级别 | 工作量 |
|---|---|---|---|---|---|
| P0-01 | P0 | publication | BLOCK 内容仍有公开详情页，与文档承诺矛盾 | ✅A | 0.5d |
| P0-02 | P0 | worker/jobs | `COLLECT_ENABLED=false` 时正文队列无消费者 | ✅A | 0.5h |
| P0-03 | P0 | weibo-monitor | 转发微博只存评论，丢掉被转发的原公告正文 | ✅A | 1d |
| P0-04 | P0 | events | 长事件更正后综述只取最后 40 篇，早期事实丢失 | ✅A | 1d |
| P0-05 | P0 | editorial/events | 结构抽取损坏静默降级为 standalone，漏建事件 | ✅A | 1d |
| P0-06 | P0 | api/auth | 登录全局 50 次/15 分钟，可被攻击者锁死唯一入口 | ✅A | 0.5d |
| P0-07 | P0 | operations | 告警通道关闭时仍标记“已发送”，故障永不重试 | ✅A | 0.5d |
| P0-08 | P0 | web/api | 详情页缓存 600s，上游数据 60s，撤回不能及时生效 | ✅A | 0.5d |
| P0-09 | P0 | events/hot | 撤稿/合并后旧 `incomplete` 热度行永久残留 | ✅A | 0.5d |
| P1-01 | P1 | editorial | 两次评分无条件执行，可省约八成第二次调用 | ⚠️B | 1d |
| P1-02 | P1 | providers/admin | `cost` 列恒为 null，价格表无种子，成本页靠估算 | ✅A | 1.5d |
| P1-03 | P1 | editorial | `understandFloor=30` 远低于门槛 58，精写大量沉没 | ✅A | 0.5d |
| P1-04 | P1 | events | 综述每次新增报道都重写，单故事最高数十版 | ⚠️B | 1d |
| P1-05 | P1 | selection | T1 官方源门槛 54 实际不可达，官方一手近零入选 | ⚠️B | 2d |
| P1-06 | P1 | eval/CI | 标注样本集中 T2，无 CI 回归护栏 | ✅A | 3d |
| P1-07 | P1 | events/publication | 同集团多源未合并，热度按 source 重复计 | ⚠️B | 2d |
| P1-08 | P1 | publication | 实体多、displayTag 少，品牌页靠标题字符串匹配 | ✅A | 1.5d |
| P1-09 | P1 | modules/following | 关注 N 个品牌首屏发 N 个并行请求，无聚合接口 | ✅A | 1d |
| P1-10 | P1 | reports | 周月报写作失败出降级刊后不再补写，缺刊告警只覆盖日报 | ✅A | 1d |
| P1-11 | P1 | operations/backup | 备份只做 TOC 校验，上传不比哈希 | ⚠️B | 1d |
| P1-12 | P1 | deploy | api/web/worker 无 healthcheck、无资源与日志上限 | ✅A | 0.5d |
| P1-13 | P1 | web | 不经 Caddy 直连时无安全头兜底 | ✅A | 0.5d |
| P1-14 | P1 | docs | 门槛文档停在 60/65/76，实际 54/56/58，类别名也不同 | ✅A | 0.5h |
| P2-01 | P2 | events | 归组全局串行 + 全池 O(N) 余弦，缺粗召回/ANN | ⚠️B | 3d |
| P2-02 | P2 | publication | 日报引用存 JSONB，详情页每次全表 `jsonb_path_exists` | ⚠️B | 2d |
| P2-03 | P2 | events/hot | 热榜逐故事查代表报道，存在 N+1 | ⚠️B | 0.5d |
| P2-04 | P2 | migrations/CI | 无迁移账本哈希、无 advisory lock；push 时迁移检查自我比较 | ✅A | 1d |
| P2-05 | P2 | api/web | 无优雅关闭兜底，SSR 对 API 宕机无熔断 | ✅A | 1d |
| P2-06 | P2 | toolchain | Node 版本三处不一致，无依赖审计 | ✅A | 0.5d |
| P2-07 | P2 | api | OpenAPI 25 个 path 人工同步，易漂移 | ✅A | 2d |
| P2-08 | P2 | tests | 缺 DB 集成/时区/并发门禁 | ⚠️B | 3d |

合计：P0 约 5 人日，P1 约 18 人日，P2 约 15 人日。

---

## 3. P0：正确性 / 合规 / 安全

### P0-01 BLOCK 内容仍有公开详情页 ✅A

**证据**
- `packages/backend/src/publication/rules.ts:67`
  ```ts
  export function hasItemPage(p: { visibility: string; sourceMode: string }): boolean {
    return p.visibility !== "withdrawn" && p.sourceMode === "editorial";
  }
  ```
  判定完全不看 `relevance`。
- `docs/selection.md` 承诺 BLOCK 内容“不出现在任何公开页面”。
- 对照：`isPoolEligible()`（同文件 `:53`）要求 `relevance === "pass"`，说明列表层是对的，只有详情页漏了。

**现状**：`relevance='block'` 且 `visibility='public'` 的资料能直接打开详情页，也会被 sitemap/分享图链路拿到。

**影响**：合规与品牌风险；行业外内容（如社会新闻）可被搜索引擎收录。

**改法（二选一，需拍板）**
- 方案 A（推荐）：`hasItemPage` 增加 `relevance === "pass"`；BLOCK 直接 404，数据侧把历史 BLOCK 行的 `visibility` 改为 `withdrawn`。
- 方案 B：保留页面但强制 summary-only + noindex，并同步修改 `docs/selection.md` 的措辞。

**验收**
1. 单测：`hasItemPage({visibility:"public",sourceMode:"editorial",relevance:"block"}) === false`。
2. 线上 SQL 返回 0：见附录 A-1。
3. 抽查 3 条 BLOCK 的 `/item/:id` 返回 404；`/api/site/items/:id` 返回 404。

---

### P0-02 `COLLECT_ENABLED=false` 时正文队列无消费者 ✅A

**证据**
- `apps/worker/src/main.ts:25`
  ```ts
  if (process.env.COLLECT_ENABLED === "true") await registerSourceJobs(boss);
  ```
- `packages/backend/src/jobs/sources.ts:21`：`registerSourceJobs` 内部才调用 `registerExtractionJobs(boss)`。

**现状**：关闭采集（省钱模式/排障模式）后，ingest 上报与微博推送仍会写入正文提取任务，但队列没有 worker 消费，文章永久停在“待正文”。

**影响**：安全阀语义被破坏——本意是“不抓外部源”，实际变成“整个正文链路停摆”，且无告警。

**改法**：把 `registerExtractionJobs(boss)` 从 `registerSourceJobs` 移出，在 `main.ts` 无条件注册；`registerSourceJobs` 只保留 fetchSource/fetchXShard/mpCheck。

**验收**：`COLLECT_ENABLED=false` 启动 worker，日志出现 extraction 队列注册；手动入队一条正文任务能被消费；`COLLECT_ENABLED=true` 时抓取任务仍注册。

---

### P0-03 转发微博丢掉被转发的原公告正文 ✅A

**证据**：`modules/weibo-monitor/backend/timeline.ts:69-73`
```ts
bodyText: post.retweeted_status ? `【转发 @${originalAuthor}】\n${text}` : text,
```
只拼了转发者自己的评论 `text`，`post.retweeted_status.text` 从未进入 `bodyText`。

**现状**：“转发车企公告 + 一句评论”是汽车热点最常见形态。AI 只能看到“转发 @X”加评论，看不到价格、配置、召回范围、时间等关键事实。

**影响**：预筛误判（评论里没有行业词）、评分偏低、事实抽取为空 → 事件建不起来或归错组。这是内容质量的结构性漏洞，不是个别 case。

**改法**
1. `bodyText` 改为：`【原帖 @作者 时间】\n{retweeted.text}\n\n【转发评论 @作者】\n{text}`。
2. `raw` 里保留 `retweeted_status.id`、`created_at`、`user.screen_name`，供后续追溯。
3. 若原帖是长文（`isLongText`），走已有长文展开逻辑；拿不到时明确标注“原帖正文缺失”，而不是静默只给评论。
4. 分析侧：`editorial` 的输入构造保持原样（吃 `bodyText`），无需改提示词。

**验收**
1. 单测：构造一条带 `retweeted_status.text` 的 card，断言 `bodyText` 同时包含原帖与评论。
2. 造一条“转发 + 评论”样例，跑完整分析，`structure.fact` 不为 null 且 `subjects` 能识别出原公告主体。

---

### P0-04 长事件更正后综述丢失早期报道 ✅A

**证据**：`packages/backend/src/events/digest.ts:34`
```ts
const lines = reports.slice(-40).map(...)
```
`slice(-40)` 只取最近 40 篇；`opts.corrected`（更正重写）走的是同一个函数，并不会因为更正而扩大范围。

**现状**：一个持续数周的事件（如某车型上市后持续交付/召回），第 41 篇之前的报道在“更正重写”时对模型不可见。而更正恰恰最需要全文重看。

**影响**：更正后的综述可能丢掉早期关键事实（首发时间、初始价格、最初口径），且模型被要求“不要沿用以前版本”，等于强制遗忘。

**改法**（不要简单放大 40）
1. 输入分层：`根事实（首篇/一手）` + `每个独立 fact 的代表篇` + `最近 N 篇` + `被更正的报道`，去重后拼接。
2. 给每篇标注 `【早期】【一手】【已更正】`，让模型知道取舍。
3. 超长时按“事实维度”裁剪，而不是按时间截断。
4. 同步改 `scripts/eval-story-digests.ts` 的输入构造，保持评测与线上一致。

**验收**
1. 单测：60 篇报道 + 第 5 篇被更正，断言输入包含第 5 篇且带【已更正】标记。
2. 用 3 个长事件回放，人工对比新旧综述是否保留首发事实。

---

### P0-05 结构抽取损坏静默降级为 standalone ✅A

**证据**
- `packages/backend/src/editorial/analyze.ts:135-142`：`StructureSchema` 大量使用 `.catch(null)` / `.catch("unknown")`，模型输出格式坏了与“合法 unknown”落到同一结果。
- `packages/backend/src/events/group.ts:502`：`if (unsupported) { markGrouped(..., { addsValue:false, reason:"材料不足以确认当前消息" }); return { verdict:"standalone" }; }`

**现状**：模型返回截断 JSON 或字段类型错，`scope` 被兜底成 `unknown`、`fact` 变成 null，归组把它当“材料不足”，标记完成、建 standalone，**不重试**。

**影响**：静默漏建事件、热度漏算；因为任务标记完成，重跑也不会修。属于“看起来成功”的数据损坏。

**改法**
1. 区分两类失败：关键字段（`scope`/`fact`）**解析失败/缺失** → 抛 `ModelOutputError` 走有限重试（已有回执机制会复用，不会重复付费）；模型**合法返回** `unknown`/null → 保持现状。
2. 在 `StructureSchema` 外再包一层判别：用 `safeParse` 先看原始是否合法，合法才允许 `.catch` 兜底。
3. 分析记录里增加 `structureDegraded: true` 便于统计与回捞。
4. 后台“内容诊断”暴露该标记。

**验收**
1. 单测：喂一段截断 JSON，断言抛错而非产出 `scope:"unknown"`。
2. 单测：合法 `{"scope":"unknown",...}` 仍走 standalone。
3. 上线后 7 天统计 `structureDegraded` 占比，应接近 0。

---

### P0-06 管理员登录可被全局锁死 ✅A

**证据**：`apps/api/src/routes/admin-auth.ts:35-46`
```ts
const attempts = new Map<string, number[]>();
function over(key, limit, now) { ...; recent.push(now); ...; return recent.length > limit; }
function tooManyAttempts(ip) {
  const perClient = over(`ip:${ip}`, 10, now);
  return over("all", 50, now) || perClient;
}
```
两个问题：
1. `over()` **无论成功失败都计数**，正常登录也消耗额度。
2. 全局键 `all` 上限 50/15 分钟，攻击者换 IP 即可打满，锁死唯一管理员入口。

**影响**：可用性攻击，且锁死后无告警、无旁路（除非重启进程）。

**改法**
1. 只对**失败**计数：`over()` 拆成 `peek()` 与 `recordFailure()`，验证通过后清空该 IP 记录。
2. 全局阈值提高（如 300/15 分钟）或改为“按 IP 段 + 全局异常速率”判定。
3. 触发限流时写一条 `security.login_throttled` 审计并告警。
4. 保留现有 12 位密码强度要求（这是主要防线）。

**验收**
1. 单测：连续 20 次正确密码不受限；连续 10 次错误后第 11 次被拒；成功一次后该 IP 计数清零。
2. 单测：100 个不同 IP 各错 1 次，管理员仍能正常登录。

---

### P0-07 告警通道关闭时仍标记“已发送” ✅A

**证据**
- `packages/backend/src/notify/feishu.ts:156-160`：`sendAlert` 在未启用时 `console.log` 后 `return "disabled"`，**不抛错**。
- `packages/backend/src/operations/alerts.ts:766`：`await sendAlert(...)` 之后无条件 `state[f.key] = { ...entry, sentAt: ... }`，返回值被丢弃。

**现状**：`FEISHU_INTERNAL_ENABLED` 关闭（默认）时，问题被发现、被记成“已通知”，之后再也不会重发；恢复通道后也补不回来。

**影响**：告警系统在最需要它的时候（配置缺失）静默失效，且状态不可信。比“没告警”更危险，因为运维以为已通知。

**改法**
1. `sendAlert` 返回值参与决策：`disabled` / `pending` 时不写 `sentAt`，改记 `undeliveredAt`。
2. 恢复通道后，下一轮扫描对 `undeliveredAt` 非空且未恢复的项补发。
3. `alerts.ts` 里私聊分支 `tellPrivate` 同样处理。
4. 运行页展示“未投递告警”计数。

**验收**
1. 单测：关闭通道跑一轮，`state.sentAt` 为空且 `undelivered` 为真；打开通道再跑一轮，发出且 `sentAt` 有值。
2. 重启进程后状态保持（落库）。

---

### P0-08 详情页缓存截止时间与上游不一致 ✅A

**证据**
- `apps/api/src/routes/site.ts:88-94`：`/api/site/items/:id` 只设 `cacheControl: "public, max-age=60, s-maxage=60"`，**没有** `X-Accel-Expires`。对照 `:75` 的 timeline 路由显式设置了该头。
- `apps/web/app/routes/item.tsx:40`：`cachedPage(600, ...)`。
- `apps/web/app/lib/api.server.ts:79-84`：`cachedPage` 只在**上游给了** `X-Accel-Expires` 时才取最小值；没给就用自己的 600s。

**现状**：详情页数据在浏览器/边缘缓存 600s，上游 API 数据只保证 60s 新鲜。撤回、改稿、换图后最长 10 分钟仍显示旧内容。

**影响**：撤回合规风险（已撤回内容仍可见）；改稿后读者看到标题与正文不一致。

**改法（两层都做）**
1. API：`/api/site/items/:id` 与 `/original` 补 `X-Accel-Expires @now+60`，与 timeline 一致。
2. Web：`item.tsx` 的 600 降为与列表同级（60–120），或保持 600 但依赖第 1 步的最小值约束。
3. 加一条架构测试：所有 `cachedPage(n>60)` 的 loader 必须对应 API 路由下发 `X-Accel-Expires`。

**验收**
1. 单测：模拟上游头 `@now+60`，断言页面 `X-Accel-Expires` 取 60 而非 600。
2. 集成：撤回一条内容，60s 内详情页 404。

---

### P0-09 热度补算清不掉失效的 `incomplete` 行 ✅A

**证据**：`packages/backend/src/events/hot.ts:295-303`
```ts
const stale = await sql`SELECT hour, array_agg(story_id) ... WHERE NOT complete AND hour < ${hour} ...`;
for (const s of stale) {
  const rows = await heatRows(s.hour, ..., s.stories.map(Number));
  repaired += await saveHeat(rows.filter((r) => Number(r.behind_participants) === 0), s.hour);
}
```
只**写入**能算出的行，从不删除“已无有效信号”的行。

**现状**：故事被撤回/合并后，其历史 `incomplete` 行没有人再计算，也没有被清理，永久留在表里。

**影响**：事件页趋势出现永久缺口或错线；`story_heat_hourly` 无界增长；30 天清理只按 `computed_at` 删，救不了这类行。

**改法**
1. 补算时先取该小时所有 `incomplete` 行，对每个 story 计算；算不出（无有效信号）的显式 `DELETE` 或置 `complete=false, voided=true`。
2. `heatSeries` 过滤 `voided`。
3. 增加一致性任务：`story_heat_hourly` 中 `story_id` 已不存在于 stories 的行直接删。

**验收**
1. 单测：故事 A 有一条 incomplete 行，撤回后跑 `snapshotHeat`，该行被删除或 voided。
2. 线上 SQL（附录 A-4）返回 0 条孤儿行。

---

## 4. P1：收益明确，1–2 周内可完成

### P1-01 第二次评分按需跳过 ⚠️B

**证据**：`packages/backend/src/editorial/analyze.ts:56`（`SCORE_CALLS=2`）、`:285`（无条件循环两次）、`:476-478`（`sum >= threshold * 2`）。

**逻辑**：入选判定只用两次之和。若第一次分数与门槛差距足够大（如 `|s1 - threshold| >= 15`），第二次不可能翻转结论，可跳过。分数展示退化为单次分（或标注“单次评分”）。

**收益**：评分是当前最大的单项模型成本。按此前统计，score 占 7 天成本约 41%；跳过比例需用附录 A-2 的 SQL 复核（此前测得 82.8% 可跳过、0 次翻转）。

**改法**
1. `runScores` 增加短路：先算 `s1`，若 `s1 <= threshold - MARGIN` 或 `s1 >= threshold + MARGIN` 且该侧结论稳定，跳过第二次。
2. `MARGIN` 先设 15，用评测脚本在标注集上验证“翻转率 = 0”后再上线。
3. `scores.values` 允许长度为 1；`shownScore`/`scoresSelect` 兼容（单次时用 `2*s1` 近似，或直接 `s1 >= threshold`）。
4. 后台展示区分“双评/单评”。

**验收**
1. 评测：在 315 条标注上，短路版与双评版入选集合完全一致。
2. 线上灰度 3 天：翻转率 0，评分成本下降 ≥50%。

---

### P1-02 成本闭环：价格种子 + 成本回填 + 成本页补全 ✅A

**证据**
- `packages/backend/src/providers/llm.ts:227`：所有 LLM 回执写入 `cost: null`。
- `packages/backend/src/providers/receipts.ts:341`：`cost = ${outcome.cost?.amount ?? null}`，因此 `cost` 列恒空。
- `database/migrations/0010_service_prices.sql` 建表，但**无种子数据**（全库 grep 无 `INSERT INTO service_prices`）。
- `packages/backend/src/operations/balances.ts:174-195`：成本页靠 `tokens_*_uncosted` + `service_prices` 估算；价格缺失时估算为 null。

**现状**：成本页只能显示“未计价 token 数”，无法回答“今天花了多少、哪一步最贵”。预算熔断也无法基于金额生效（无单价）。

**改法**
1. 新增迁移：插入各服务/模型的价格种子（deepseek 系、embedding、dashscope、jina、socialdata），单位统一为 元/百万 token 与 次。
2. `llm.ts` 返回 `cost`：从 `service_prices` 读价 × usage 计算，`basis: "estimated"`；供应商返回实际费用时用 `actual` 覆盖。
3. 历史回填脚本：按 `usage` + 现价批量补 `cost`，标注 `cost_basis='backfilled'`，只跑一次。
4. 成本页补齐 group / digest / embedding 三类（此前口径漏项）。

**验收**
1. 跑一条分析，`receipt_attempts.cost` 非空且与手算一致（±1%）。
2. 成本页“今日花费”与 SQL 汇总一致。
3. 预算设 10 元，超限后模型调用被拦截（有明确日志）。

---

### P1-03 `understandFloor` 过低造成精写沉没成本 ✅A

**证据**
- `industry/selection.ts:38`：`understandFloor: 30`。
- `packages/backend/src/editorial/analyze.ts:509`：
  ```ts
  const near = scoresSelect(scores) || (sum !== null && sum > UNDERSTAND_FLOOR * SCORE_CALLS);
  ```
  平均值 >30 就用“内容理解”精写，而入选门槛是 54/56/58。

**现状**：大量 31–53 分的稿件被精写（贵），但永远不会进精选，只落在“全部动态”。

**影响**：此前统计 61–70% 的精写没有入选。这是纯粹的成本浪费，不影响正确性。

**改法**：`understandFloor` 提到 `T1门槛 - 10`（约 44），或改为“距离门槛 ±10 以内才精写”。需同步 `industry/selection.ts` 注释与 `docs/selection.md`。

**验收**
1. 评测：精选集合不变（精写只影响文案质量，不影响入选）。
2. 7 天成本对比：understand 类调用数下降 ≥40%。

---

### P1-04 综述重写节流 ⚠️B

**证据**：`packages/backend/src/events/digest.ts:23-40`（每次构造全量输入重写）；调用侧按“有新报道”触发。

**现状**：热度高的事件每来一篇报道就重写一次综述，单故事历史版本可达数十版。

**改法**：三重条件任一满足才重写——新增报道 ≥K（如 3）、含一手信源、距上次 ≥T（如 6 小时）；更正走强制重写。

**验收**：7 天内 digest 版本数下降 ≥60%，人工抽查 20 个事件综述质量不降。

---

### P1-05 T1 官方源门槛校准 ⚠️B

**证据**：`industry/selection.ts:26` `thresholds: { T1: 54, T1_5: 56, T2: 58 }`；同文件注释明确写“T1、T1_5 没有样本可校准，只是跟着压在 T2 下面”。

**现状**：T1 官方一手（部委、车企官网）实测均分显著低于媒体，门槛 54 实际不可达，官方一手近零入选——而官方一手本应是最高价值内容。

**改法**
1. 补 30–50 条 T1 标注（该选/不该选/两可）。
2. 用 `scripts/eval-selection.ts` 扫门槛，按“T1 每日入选 3–8 条”定值。
3. 保持 `understandFloor < T1 < 类别门槛 < T2` 的顺序约束（测试依赖）。

**验收**：T1 日入选数进入 3–8 区间；T2 入选量不变（±10%）。

---

### P1-06 标注集分层 + CI 回归护栏 ✅A

**证据**：`scripts/eval-selection.ts`；`tests/` 无评测门禁；`.github/workflows/check.yml` 只跑常规测试。

**现状**：315 条标注集中在 T2+rss（少数源），默认抽样 holdout 很小；改提示词/门槛没有自动回归，出现过“预算耗尽报告”流入的情况。

**改法**
1. 标注集分层：按信源分级 × 类别 × 分数段分层，固定 dev/holdout。
2. 导出 `tests/fixtures/selection-golden.json`，CI 跑“入选集合与金标一致率 ≥ 阈值”。
3. 提示词版本哈希变化时强制跑评测，未达标不合并。
4. 评测报告归档，带模型名与提示词哈希。

**验收**：PR 改 `industry/prompts/` 时 CI 必跑评测并给出对比表。

---

### P1-07 同集团多源合并 ⚠️B

**证据**：事件热度按 `source` 计独立来源（`events/hot.ts` 参与者去重键为 source/participant）；`sources` 表无集团字段。

**现状**：同一媒体矩阵多站（如太平洋汽车多子站、TechCrunch 系）转载同一篇，被判为多个独立来源，热度虚高冲榜。

**改法**
1. 新增 `source_groups`（group_key, source_id）与后台维护入口。
2. 热度参与者键从 `source_id` 改为 `coalesce(group_key, source_id)`。
3. 迁移时按域名后缀/已知矩阵预填一批。

**验收**：同一集团 3 站转载 1 篇，热度只计 1 个来源；榜单前后对比无异常跳变。

---

### P1-08 主题标签覆盖 ✅A

**证据**：`packages/backend/src/publication/topics.ts:83`
```ts
const shown = t.entityId ? [ENTITIES[t.entityId]?.displayTag ?? null] : t.tags;
```
`ENTITIES` 中多数实体无 `displayTag`，回退为 `null`。

**现状**：实体识别出来了，但前台无展示标签；品牌页聚合 `:103` 依赖 `entity:%` 单标签，覆盖不足时只能靠标题字符串匹配。

**改法**
1. 补齐核心实体（车企/品牌/车型平台）的 `displayTag`。
2. 对无 displayTag 的实体，回退用实体中文名而非 null。
3. 品牌页聚合增加“标题包含品牌别名”兜底，并统计覆盖率。

**验收**：入选稿实体标签覆盖率 ≥95%；品牌页各品牌近 7 天内容数 >0 的比例 ≥90%。

---

### P1-09 关注页聚合接口 ✅A

**证据**：`modules/following/web/following.tsx:149-163`
```ts
fetch(`/api/site/topics/${slug}${p>1?`?page=${p}`:""}`)
...
Promise.all(jobs).then(...)
```
每个关注品牌一个请求，并行发出，首屏等全部 settle。

**现状**：关注 20 个品牌 → 首屏 20+ 请求；移动端弱网下白屏时间长；每个请求独立游标，翻页语义混乱。

**改法**
1. 新增 `GET /api/site/following?slugs=a,b,c&cursor=...`，服务端合并、统一排序与游标。
2. 服务端限制 slugs 数量（如 ≤30）与返回条数。
3. 前端改为单请求 + 本地缓存上次结果做骨架。

**验收**：关注 20 品牌首屏请求数 = 1；首屏可交互时间下降 ≥50%（本地 Lighthouse 对比）。

---

### P1-10 周月报失败补写 + 缺刊告警 ✅A

**证据**：`packages/backend/src/reports/compose.ts:201-240`
```ts
const previous = await savedReport(kind, key);
if (previous && reason === undefined) return { key, entries: previous.entries };
...
} catch (error) { ... "period writer failed; the issue goes out with its plain overview" }
```
写作失败仍保存一期（无总述），下次定时任务因 `previous` 存在直接跳过，**永不补写**。

**现状**：降级刊长期留在站点；缺刊告警只覆盖日报（`operations/alerts.ts:633` 附近），周/月报缺失无人知。

**改法**
1. 报告记录增加 `degraded: true`；定时任务对 `degraded` 的期次允许一次重写（带 `reason: "retry-degraded"`）。
2. 缺刊告警扩展到 weekly/monthly，按各自周期判定。
3. 后台报告页标出降级刊。

**验收**
1. 单测：写作失败 → 存降级刊 → 下一轮重写成功 → `degraded=false`。
2. 单测：周报缺失触发告警。

---

### P1-11 备份可验证 ⚠️B

**证据**：`packages/backend/src/operations/backup.ts:231-240`（列文件与本地 sha256）；上传路径未见“上传后回读比对”。

**现状**：pg_dump 只做 TOC 校验；对象存储上传不比对 sha256；半成品与成品同名落盘；未配置对象存储时静默只留本地。

**改法**
1. 上传后 `HEAD` 取 `ETag/Content-Length` 与本地 sha256/size 比对，不一致即失败告警。
2. 先写 `.part`，校验通过再 rename。
3. 未配置对象存储时启动即告警（而非静默）。
4. 每月一次真实 `pg_restore` 到临时库并跑 `SELECT count(*)` 校验。

**验收**：故意改坏一个上传对象，备份任务失败并告警；恢复演练成功。

---

### P1-12 部署可观测与资源边界 ✅A

**证据**：`docker-compose.yml:48-85`：`api`/`worker`/`web` 均无 `healthcheck`，无 `mem_limit`/`cpus`，无日志轮转；只有 `db` 有 healthcheck（`:36`）。

**改法**
1. api 增加 `/healthz`（已有则接 healthcheck），web 增加 TCP/HTTP 检查，worker 用心跳表判定。
2. 三个服务加 `deploy.resources.limits` 与 `logging.options`（max-size/max-file）。
3. `depends_on` 加 `condition: service_healthy`。

**验收**：`docker compose ps` 三服务 healthy；`docker kill` api 后自动重启且 web 返回 503 而非挂起。

---

### P1-13 网页安全头兜底 ✅A

**证据**：`apps/web/server.ts:68` 仅静态资源加 `X-Content-Type-Options`；页面响应只写缓存头（`:106-140`），无 CSP/X-Frame/Referrer。`deploy/Caddyfile:5-9` 有一套安全头，但仅在用 Caddy 时生效。

**改法**：在 `server.ts` 的 `pageResponse` 统一注入与 Caddy 等价的一组头（重复设置无害）；CSP 先以 `frame-ancestors 'self'` + `default-src 'self'` 起步，避免破坏内联样式。

**验收**：不经 Caddy 直连 3000，响应头包含 5 项；页面功能无回归（分享图、内嵌预览正常）。

---

### P1-14 文档门槛与代码同步 ✅A

**证据**：`docs/selection.md:26-35` 写 `60/65/76`、类别 `ecosystem/leaderboard`；实际 `industry/selection.ts:26` 是 `54/56/58`、类别 `supplier/data`。`understandFloor` 文档 50、实际 30；`browseFloor` 文档 40、实际 22。

**影响**：照文档配置会把门槛设错，入选量腰斩或暴涨。这是最容易误导下一个维护者的地方。

**改法**：文档改为从 `industry/selection.ts` 引用式描述，或加一条测试断言“文档中的数字与代码一致”。

**验收**：新增测试解析文档代码块并与 `SELECTION` 比对，不一致即失败。

---

## 5. P2：需验证或长期建设

| ID | 内容 | 关键证据 | 做法要点 |
|---|---|---|---|
| P2-01 | 归组召回性能 | `events/recall.ts`（14/60 天全池召回 + Node 内 O(N) 余弦）、`events/group.ts` 本地并发=1 | 先回放生产数据拿 P95 与队列积压；再上粗召回（倒排/分桶）→ 有界 LRU → 最后才考虑 pgvector。**不要先加并发**，会引入重复建事件 |
| P2-02 | 日报引用规范化 | `publication/reports.ts:426` 每次详情扫全部日报 `jsonb_path_exists` | 建 `report_citations(report_key, item_id)`，写入时同步，查询走索引 |
| P2-03 | 热榜 N+1 | `events/hot.ts:184` 逐故事查代表报道 | 改为一次 `WHERE story_id = ANY($1)` 分组 |
| P2-04 | 迁移加固 | `scripts/migrate.ts:35` 仅按文件名排序；`:49` 有 lock_timeout 但无 advisory lock；`check.yml:52` push 时 `MIGRATION_BASE=github.sha` 等于自我比较 | 加 `pg_advisory_lock`；建 `schema_migrations(name, sha256, applied_at)` 账本；CI 在 push 时与 `HEAD~1` 比较 |
| P2-05 | 优雅关闭与熔断 | `apps/api` 无超时兜底；`apps/web` 无 `closeIdleConnections`；SSR 对 API 宕机硬等 | 统一 `AbortSignal.timeout`；加 15s 上限与 503 快速失败 |
| P2-06 | 供应链一致 | `package.json` engines 24.22.1 / 文档 24.11 / Dockerfile 浮动 tag | 统一版本；加 Dependabot 与 `npm audit` 门禁 |
| P2-07 | OpenAPI 契约 | `apps/api/src/routes/*` 25 个 path 手工同步 | 生成式 OpenAPI + 契约测试（响应 schema 校验） |
| P2-08 | 测试门禁 | `tests/` 以单测为主 | 补 DB 集成测试（迁移+读写）、时区边界（Asia/Shanghai 跨日）、并发归组 |

---

## 6. 实施批次

**第 1 批｜半天，纯小改，风险最低**
P0-02、P0-06、P0-07、P0-08（API 侧）、P1-12、P1-13、P1-14。
验收：`npm run typecheck` + `npm test` 全绿；compose 起五容器 healthy。

**第 2 批｜2–3 天，内容正确性**
P0-01（需拍板方案）、P0-03、P0-04、P0-05、P0-09。
验收：新增 6 个单测全绿；用 10 条真实微博/长事件回放，人工比对前后分析结果。

**第 3 批｜1 周，成本与选稿**
P1-01、P1-02、P1-03、P1-04、P1-05、P1-06。
验收：评测报告显示入选集合与基线一致；7 天成本对比下降；T1 日入选 3–8 条。

**第 4 批｜1 周，体验与运维**
P1-07、P1-08、P1-09、P1-10、P1-11。
验收：关注页单请求；报告降级可补写；备份校验失败能告警。

**第 5 批｜持续**
P2 全部，按“先测量后改造”推进。

**每批统一门禁**：typecheck、lint、单测、`architecture.test.ts`、迁移可重复执行（空库 + 存量库各一次）。

---

## 7. 需要拍板的 4 件事（不拍板无法开工）

1. **BLOCK 内容处置**：直接 withdrawn（404），还是保留页面但 summary-only + 改文档？影响 P0-01 方案。
2. **全文翻译做不做**：需求文档写了“外稿提供中文全文翻译”，但全部源 `site_fulltext=false`、`translations` 表 0 行。做则先只翻摘要/首段控成本；不做则改文档。
3. **推送留不留**：`PUSH_TIERS` 实际只剩 T1，而 T1 近零入选，推送在空转。放开到 T2 高置信，还是下线？
4. **“每天不超过 50 条”指报道还是事件**：近 4 天报道 86–149/天、事件 15–41/天，口径不同结论相反，直接影响 P1-05 门槛校准目标。

---

## 附录 A：复核命令与 SQL

> 表名依据 `database/migrations/0001_core.sql`：内容投影表是 `publications`（不是 items），分析明细在 `analyses.output`，付费明细在 `receipt_attempts`。

**A-1 BLOCK 仍有公开详情页**
```sql
SELECT count(*) FROM publications p
JOIN analyses a ON a.id = p.analysis_id
WHERE a.relevance = 'block' AND p.visibility = 'public';
-- 期望整改后为 0；若 p.analysis_id 为空，按 article_id 取 analyses 最新一条同比
```

**A-2 二次评分可跳过比例（P1-01 依据）**
```sql
SELECT
  count(*) AS scored,
  count(*) FILTER (WHERE abs(s1 - threshold) >= 15) AS skippable,
  round(100.0 * count(*) FILTER (WHERE abs(s1 - threshold) >= 15) / count(*), 1) AS pct,
  count(*) FILTER (WHERE (s1 + s2 >= 2 * threshold) <> (s1 >= threshold)) AS altered
FROM (
  SELECT (output->>'threshold')::numeric        AS threshold,
         (output->'scores'->>0)::numeric        AS s1,
         (output->'scores'->>1)::numeric        AS s2
  FROM analyses
  WHERE jsonb_typeof(output->'scores') = 'array'
    AND jsonb_array_length(output->'scores') = 2
    AND output ? 'threshold'
    AND created_at > now() - interval '7 days'
) t;
-- altered = “双评结论”与“只看第一次分”结论不同的条数，必须为 0 才能上线短路
```

**A-3 成本未计价规模（P1-02 依据）**
```sql
SELECT service, model, count(*) AS calls,
       sum((usage->>'prompt_tokens')::bigint)    AS in_tokens,
       sum((usage->>'completion_tokens')::bigint) AS out_tokens,
       count(*) FILTER (WHERE cost IS NULL)      AS uncosted
FROM receipt_attempts
WHERE started_at > now() - interval '7 days'
GROUP BY 1,2 ORDER BY calls DESC;
```

**A-4 热度未补算残留（P0-09 依据）**
```sql
-- story_heat_hourly 对 stories 有 ON DELETE CASCADE，不会出现孤儿行；
-- 要查的是“早就跨过补算窗口、仍是 incomplete”的行。
SELECT count(*) AS stale_incomplete
FROM story_heat_hourly
WHERE NOT complete AND hour < now() - interval '24 hours';
```

**A-5 精写沉没成本（P1-03 依据）**
```sql
SELECT
  count(*) FILTER (WHERE output->>'writer' = 'understand') AS understood,
  count(*) FILTER (WHERE output->>'writer' = 'understand' AND selected) AS understood_selected,
  round(100.0 * count(*) FILTER (WHERE output->>'writer' = 'understand' AND selected)
        / nullif(count(*) FILTER (WHERE output->>'writer' = 'understand'), 0), 1) AS hit_pct
FROM analyses
WHERE created_at > now() - interval '7 days';
```

**A-6 各信源分级入选（P1-05 依据）**
```sql
SELECT s.tier, count(*) AS items,
       count(*) FILTER (WHERE p.selected) AS selected,
       round(avg(p.score), 1) AS avg_score
FROM publications p JOIN sources s ON s.id = p.source_id
WHERE p.timeline_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 1;
```

**A-7 代码级复核（无需数据库）**
```bash
cd /Users/huxiaohu/Desktop/autohot
sed -n '67p'  packages/backend/src/publication/rules.ts        # P0-01
sed -n '25p'  apps/worker/src/main.ts                          # P0-02
sed -n '69,73p' modules/weibo-monitor/backend/timeline.ts      # P0-03
sed -n '34p'  packages/backend/src/events/digest.ts            # P0-04
sed -n '35,46p' apps/api/src/routes/admin-auth.ts              # P0-06
sed -n '156,160p' packages/backend/src/notify/feishu.ts        # P0-07
sed -n '88,94p' apps/api/src/routes/site.ts                    # P0-08
sed -n '295,303p' packages/backend/src/events/hot.ts         # P0-09
sed -n '26p'  industry/selection.ts                            # P1-14
sed -n '26,35p' docs/selection.md                              # P1-14 对照
```

---

## 附录 B：本轮被推翻/降级的旧结论（校验时请重点看）

审计过程中有三条早期判断经复核后**不成立**，已从计划中移除，记录在此避免误导：

1. **“web 默认绑 0.0.0.0 绕过 Caddy”** —— 不成立。`apps/web/server.ts:17` 默认 `WEB_HOST || "127.0.0.1"`；`docker-compose.yml:79` 显式设 `WEB_HOST: 0.0.0.0` 是容器内正常做法，端口映射由 compose 控制。**已从 P0 移除**，仅保留 P1-13（安全头兜底）。
2. **“换 embedding 维度会静默全 0 相似度”** —— 不成立。`packages/backend/src/providers/embeddings.ts:18` 注释与实现均表明：`EMBEDDING_DIMS` 变化后，尺寸不符的存量向量会重新计算，`VECTOR` schema 会拒绝错误尺寸。**已从 P2 移除**。
3. **“`deploy/docker-compose.yml` 无 healthcheck”** —— 路径错误。编排文件在仓库根 `docker-compose.yml`，`deploy/` 只有 `Caddyfile`。结论本身成立（api/web/worker 确实无 healthcheck），但行号已按根文件修正（P1-12）。

另外两条**降级为 B 级**，需数据验证后再定：

4. **“页面 600s vs 上游 60s 未取最小值”** —— 机制描述不准确。`cachedPage` 确实会取上游 `X-Accel-Expires` 的最小值；真实原因是**详情接口没下发这个头**（`site.ts:88` 对比 `:75` timeline 有下发）。整改动作不变，但归因已修正（P0-08）。
5. **“归组全局串行是主要瓶颈”** —— 需生产数据。串行是事实，但是否为瓶颈取决于池规模与 P95，先测量（P2-01）。
