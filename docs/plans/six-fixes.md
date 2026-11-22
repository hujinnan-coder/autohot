# 6 项小改动的可实施方案

基线：`d88d6ad`（2026-11-22，autohot）。行号均为实测。只写方案，未改代码。

## 与任务书的偏差（以实测为准）

| # | 任务书说法 | 实测 | 影响 |
|---|---|---|---|
| 1 | 周月报 `previous && reason === undefined` 在 `compose.ts` 约 :202-203 | 周月报在 `:203`，日报在 `:95`；`generator.written` 在 `:248` | 无 |
| 2 | 「写作失败仍保存无总述的刊，`written === false` 是降级标记」 | 只对周月报成立。日报的 `generator` 是 `{ version, ...edition.stats, ...issue.stats }`（`:118`），**没有 `written` 字段** | 补写只针对 weekly/monthly，不要给日报加字段 |
| 3 | 缓存项「如关于页/存档页」 | `cachedPage(n>60)` 共 **9 处**（清单见 2.1），全部未传 upstream，其中 `agent.tsx` 必须保持不传；另有 3 处 n=60 已传（`home.tsx:27`、`item.tsx:43`、`item-original.tsx:12`） | 收尾要改 8 个 loader + 1 处显式豁免，不是 1–2 个 |
| 4 | 项 5 要加 `module.ts` 的 `apiPaths` | **不必要**。`ENGINE_API_PATHS` 已含 `/^\/api\//`（`packages/contracts/src/http-policy.ts:194`），`isApiOwned`（`:224`）已覆盖 `/api/site/...`，`apps/web/server.ts:161` 据此转发。`apiPaths` 只对 `/api/` 之外的模块路径有用 | 少改一个文件；详见 5.2 |
| 5 | 项 4「未配置对象存储只留本地，无任何提示」 | 比这更糟：`backupAge` 第一行就是 `if (!backupConfigured()) return []`（`alerts.ts:237`），**未配置时任何备份告警都不产生**；`runBackup` 每天 throw（`backup.ts:250`），只落成 `job_runs` 的 failed，仓库里没有"作业失败"的通用告警 | 本项要动的是 `backupAge` 的早退，不是新增 finding |
| 6 | `digestReports` 在 `events/story-evidence.ts` | 实际在 `packages/backend/src/publication/story-evidence.ts:36`（`events/digest.ts:10` 从 `../publication/` 引入） | 仅路径；此外 `story_digests`（`0002_events_reports.sql:39-48`）没有 per-report 哈希列，这是项 6 必须加列的原因 |

另一条不是偏差、但方案里当证据用的实测：`npm audit` 现在 **0 漏洞**（prod 203 / dev 145 / optional 100 个依赖）；本机 `node -v` 是 **v22.22.2**，低于 `engines: ">=24.22.1"` —— 说明仓库没有版本文件在约束本地环境。

---

## 项 1：周月报降级刊补写 + 缺刊告警

### 1.1 现状确认

- 跳过已存在的期次：`reports/compose.ts:203`（`if (previous && reason === undefined) return …`）。
- 重写通道已经存在：`saveReport`（`:53-77`）。带 `reason` 时把旧内容写进 `report_revisions`（`:63-64`，含 `reason` 列）再覆盖 `reports.content`；不带 `reason` 时只 `INSERT … ON CONFLICT DO NOTHING`。
- 降级标记：`composePeriod` 的 `generator: { version, model, written: overview !== null }`（`:248`）。`overview` 来自 `usable(written.overview, …)`（`:243`），模型失败时 `written` 保持 `{overview: "", sections: {}}`（`:225`）。
- 读取层会兜底：`publication/reports.ts:167-172` 的 `periodOverview` 在 `content.overview` 为空时用"本期带了什么"生成一段。**所以降级刊不是坏页，只是没有真正的总述**——判定要用 `written`，不要用 `overview` 是否为空（读取层不写回，`content` 里仍是空）。
- 调度：`apps/worker/src/schedules.ts:37`，`0,30 * * * *`，`run: () => composeDueReports()`；`composeDueReports` 在 `:312-341`，缺失循环 `:323-338`，`limit=8`。
- 生产代码无 `reason` 调用方（`grep reason compose.ts` 只有声明与传递）；后台没有重写入口。
- 缺刊告警：`operations/alerts.ts:666-690` 只查 `kind='daily'`；`DAILY_PREFIX`/`dailyDate` 在 `:618-620`；结算 `settleDailies`（`:698-722`）只认 daily 键，调用在 `:820`。

**一个必须一起改的耦合**（只加 finding 不改结算会出错）：`checkAlerts` 末尾的通用恢复分支（`:821-828`）对 `state` 里所有"本轮没出现、也不在 `missing` 里"的键都会发 `formatRecovery` 并删除。若周报键只出现在 finding 里、`settleDailies` 又不认它，那么当这期超出扫描窗口、finding 不再产生时，通用分支会把一条**从没出刊**的周报当成"已恢复"发出去。所以结算逻辑必须按 kind 扩展。

### 1.2 改动清单

**A. `reports/compose.ts`：补写降级期次**

常量（`composeDueReports` 上方，`:310` 附近）与签名：
```ts
const RETRY_REASON = "missing overview";
const RETRY_MAX = 2;           // 每期最多补写 2 次（首次发布 + 2 次重写 = 3 次模型调用）
const RETRY_WINDOW = { weekly: 8, monthly: 12 };   // 只补最近 8 周 / 12 个月
```
`kinds` 数组（`:315`）的 `compose` 签名加第二个参数：
```ts
compose: (k: string, reason?: string) => Promise<unknown>
// weekly: (k, r) => composeWeekly(k, r)   monthly: (k, r) => composeMonthly(k, r)
```
在缺失循环（`:323-338`）之后、`if (failed.length) throw`（`:340`）之前，追加第二段：
```ts
// 降级刊：写出来了但没有总述（模型那次失败）。补写一次，仍然有界：
// 期次范围、每期次数上限，都从 report_revisions 的 reason 账本读，不新增状态。
if (modelsOn()) {
  for (const kind of ["weekly", "monthly"] as const) {
    const due = kind === "weekly" ? dueWeekly(now) : dueMonthly(now);
    const rows = await sql<{ key: string }[]>`
      SELECT r.key FROM reports r
      WHERE r.kind = ${kind} AND r.content->'generator'->>'written' = 'false' AND r.key <= ${due}
      ORDER BY r.key DESC LIMIT ${RETRY_WINDOW[kind]}`;
    for (const { key } of rows) {
      if (shutdownSignal.signal.aborted || generated.length >= limit) break;
      const [{ retries }] = await sql<{ retries: number }[]>`
        SELECT count(*)::int AS retries FROM report_revisions v JOIN reports r ON r.id = v.report_id
        WHERE r.kind = ${kind} AND r.key = ${key} AND v.reason = ${RETRY_REASON}`;
      if (retries >= RETRY_MAX) continue;
      try {
        if (await k.compose(key, RETRY_REASON) !== null) generated.push(`${kind}:${key}~retry`);
      } catch (error) { /* 同缺失循环：aborted 不算失败，其余进 failed */ }
    }
  }
}
```
要点：
- **幂等**：补写成功后 `written` 变 `true`，下一轮的查询不再命中；**次数上限靠 `report_revisions.reason` 这个已有账本**（`saveReport` 带 reason 时必写一行），不新增 settings 键，也不需要迁移。
- **防循环**：`RETRY_MAX` 让同一期最多 3 次模型调用；`RETRY_WINDOW` 让上线那一刻不会去补陈年降级刊。
- **成本**：补写走 `chatJson`（`:228`），回执、预算、熔断都在里面，没有新增付费路径。
- 补写在缺失刊之后执行，共用 `limit` 与 `generated`，不会挤掉当期缺失刊。

**B. `operations/alerts.ts`：缺刊扩到周月报**

键前缀与解析（改 `:618-620`）：
```ts
const GAP_PREFIX = { daily: "report.daily:", weekly: "report.weekly:", monthly: "report.monthly:" } as const;
type GapKind = keyof typeof GAP_PREFIX;
/** state 里的键 → 哪一种刊、哪一期；日报还要求是合法日期，周月报要求期次形状。 */
const gapOf = (stateKey: string): { kind: GapKind; key: string } | undefined => {
  for (const kind of Object.keys(GAP_PREFIX) as GapKind[]) {
    if (!stateKey.startsWith(GAP_PREFIX[kind])) continue;
    const key = stateKey.slice(GAP_PREFIX[kind].length);
    if (kind === "daily" ? !isValidDate(key) : !/^\d{4}-(W\d{2}|\d{2})$/.test(key)) return undefined;
    return { kind, key };
  }
  return undefined;
};
```
`dailyReportFindings`（`:666`）保留日报逻辑不动，末尾追加：
- 目标期次：`dueWeekly(now)`、`dueMonthly(now)`（从 `@aihot/backend/reports/compose` 引入，均已在 `:284`/`:292` 导出）。
- 起点门槛：沿用 `composeDueReports` 的规则（`:328`）——`firstDaily` 不存在、或该期结束日早于 `firstDaily` 的，不算缺刊（站点起步前没有可汇总的日报）。
- 到期判定：周报在它覆盖那一周之后的周一 `EDITION_TIMES.weekly` 到期，月报在次月 1 日 `EDITION_TIMES.monthly` 到期；与日报一样留 2 小时宽限（`:681` 的 `+ 2 * 3600_000`）。用 `isoWeekRange`/`monthRange`（compose.ts 内部已有，需要 `export`）取期末。
- 扫描窗口：`daily` 7 天（现状 `dailyScanFrom`）；`weekly` 最近 4 周、`monthly` 最近 3 期。超出窗口的缺刊不再产生 finding，由结算按"不再提醒"处理。
- finding 形状与日报同构：键 `GAP_PREFIX[kind] + 期次`，`level: "now"`，标题「〈期次〉 的周报还没生成」，带 `impact`/`heals`/`action`/`detail`。**级别必须是 `now`**：已完成的告警语义里 `later` 只进 09:00 摘要，缺刊是读者能看见的缺口，和日报同级。

`settleDailies`（`:698`）改成 `settleReports`：
- `dailyDate` → `gapOf`；按 `kind` 决定窗口（`dailyScanFrom` / `weeklyScanFrom` / `monthlyScanFrom`）。
- 窗口内且仍未出刊 → 进 `missing`（保留在 state，不删）。
- 窗口外仍有 state、且曾 `sentAt` → 发一条"没能补出，停止提醒"并删除（沿用现有 `:711-719` 的语义），`sent` 里记 `${key}:expired`。
- 日报分支的判定与文案逐字不变，`tests/daily-report-alerts.test.ts` 全绿是本项的硬门槛。

### 1.3 测试

`tests/report-recovery.test.ts`（已有"automatic runs rewrite published issues"与本地模型 stub，`stub` 可数命中次数）：
1. **降级刊被补写**：造一个 `content.generator.written=false` 的 weekly（其余内容合法）→ 跑 `composeDueReports`（stub 返回可用 overview）→ 该期 `content.overview` 非空、`generator.written=true`、`report_revisions` 多一条 `reason='missing overview'`、`revision` +1。
2. **补不出来就不再补**：stub 一直返回 `overview: ""` → 连续跑 `RETRY_MAX + 2` 轮 → `report_revisions` 中该 reason 的行数恰为 `RETRY_MAX`，stub 命中数不再增长（用 stub 的计数断言"不再调模型"，而不是只断言没报错）。
3. **正常期次不被重写**：`written=true` 的周报连跑三轮，`revision` 不变、无新 revision 行。
4. **回执与预算没被绕过**：断言补写那次调用在 `receipt_attempts` 里有 `origin='live'` 的一行（用 `chatJson` 的既有路径自然成立，这条是防止实施时改成直调 provider）。

`tests/daily-report-alerts.test.ts`（已有 `checkAlerts`/`collectFindings` 与假飞书）：
5. **周报缺刊**：只造 daily，不造 weekly，`now` 取某周一 12:00 → finding 含 `report.weekly:<上周>`，`level='now'`。
6. **已出刊不报**：同场景补上该周 weekly → 不再出现。
7. **补出后恢复、state 清空**：先报一次（`sentAt` 写入），再插入该期 reports，跑一轮 → `state` 里该键被删、`sent` 含 `<key>:recovered`。
8. **窗口外不误报"已恢复"**：把 `now` 推到该期 5 周之后、仍不造 weekly → 不发恢复消息，而是发"停止提醒"并删键（这条直接守住 1.1 末尾说的那个坑）。

### 1.4 迁移与数据影响

无迁移。存量降级刊在上线后按 key 倒序、每轮每类最多 2 期被补写（8 周 / 12 月窗口内最多 8 / 12 期，几轮内收敛）。`report_revisions` 会多出 `reason='missing overview'` 的行——这是审计记录，不是垃圾。若希望**只补当期、不动历史**，把 `RETRY_WINDOW` 设 `{weekly: 1, monthly: 1}` 即可（列为待拍板）。

### 1.5 验收

```sql
-- 近 8 周 / 12 月内仍是降级的期次：补写收敛后，这里只剩"补写也写不出"的期
SELECT kind, key FROM reports
WHERE kind IN ('weekly','monthly') AND content->'generator'->>'written' = 'false'
  AND created_at > now() - interval '90 days'
ORDER BY kind, key DESC;

-- 每期补写次数不超过上限
SELECT r.kind, r.key, count(*) AS retries
FROM report_revisions v JOIN reports r ON r.id = v.report_id
WHERE v.reason = 'missing overview'
GROUP BY 1,2 HAVING count(*) > 2;   -- 期望 0 行
```
告警侧：只有一个 daily 的库、`now` 为周一 11:00 时收到周报缺刊；插入该期后收到"已恢复"。

### 1.6 风险与回滚

补写会增加模型调用（每期 ≤2 次，且只在有降级刊时）；回退只需删掉 1.2-A 的第二段（告警部分可独立保留），`RETRY_REASON` 的账本行留在 `report_revisions` 里无害。

---

## 项 2：缓存头架构测试（P0-08 收尾）

### 2.1 现状确认

- `cachedPage`（`apps/web/app/lib/api.server.ts:79-92`）：`seconds` 是页面自己想要的 TTL；只有 `upstream` 给了 `X-Accel-Expires`（`@` 绝对秒）或 `Cache-Control` 含 `no-cache/no-store` 时才收紧到上游截止时间。**不传 `upstream` = 完全不看上游**。
- `apiGet` 已支持收集上游头：`init.responseHeaders`（`:23`），`res.headers.forEach(... set ...)`（`:34`）；`loadOr404` 透传（`:50-52`）。
- `cachedPage(n>60)` 且**未传** upstream 的 9 处：

| 文件 | 行 | n | 调用的接口 | 处置 |
|---|---|---|---|---|
| `routes/agent.tsx` | 62 | 300 | `/api/health`（只当探针，取布尔） | **豁免**，见下 |
| `routes/report-latest.tsx` | 22 | 600 | `/api/site/reports/:kind/latest-page` | 传 upstream |
| `routes/report-detail.tsx` | 32 | 3600 | `/api/site/reports/:kind/:key` + `/navigation/:key` | 传 upstream（两请求共用一个 Headers） |
| `routes/topics.tsx` | 21 | 300 | `/api/site/topics` | 传 upstream |
| `routes/daily-archive.tsx` | 22 | 600 | `/api/site/reports/daily` | 传 upstream |
| `routes/story.tsx` | 35 | 300 | `/api/site/stories/:publicId` | 传 upstream |
| `routes/changelog.tsx` | 23 | 300 | `/api/site/changelog` | 传 upstream |
| `routes/hot.tsx` | 29 | 120 | `/api/site/hot` | 传 upstream |
| `routes/about.tsx` | 25 | 300 | `/api/site/contact` + `/api/site/stats` | 传 upstream（两请求共用一个 Headers） |

`agent.tsx` 是**必须保持不传**的一处，原因具体：它唯一的请求是 `/api/health`（`agent.tsx:61`），该接口返回 `Cache-Control: no-store`（`apps/api/src/app.ts:91`）。把它当上游传进 `cachedPage`，会被 `api.server.ts:85` 判成"不可缓存"，整个页面从 300 秒变成 0 —— 这是"盲目给所有页面加 upstream"会踩的坑。健康检查的缓存头说明的是探针本身，不是页面数据的时效。

- API 侧目前只有三条路由下发 `X-Accel-Expires`：`/api/site/timeline`（`routes/site.ts:75`）、`/api/site/items/:id`（`:93`）、`/api/site/items/:id/original`（`:102`）。除 `agent.tsx` 外，上表 8 个页面用的接口都只给 `Cache-Control: public, max-age=…`，不含 `no-store`（已逐条核对 `site.ts` 内 5 种取值；`no-store` 只出现在 `stories/:id/followups`、`groups/:factId/reports`、`items/availability` 三条，都不在上表）。
- 结论：**这 8 处现在不是线上 bug，是防回归缺口**——一旦某个报告接口开始下发 `X-Accel-Expires`，这些页面会继续用 600/3600 秒覆盖掉它。

### 2.2 改动清单

**A. 8 个 loader 各加一个 Headers**（模板照 `home.tsx:20-27`；`agent.tsx` 除外，理由见 2.1）：
```ts
const upstream = new Headers();
const data = await loadOr404<X>(`/api/site/...`, { signal: request.signal, responseHeaders: upstream });
return cachedPage(600, { ... }, upstream);
```
`report-detail` 与 `about` 各有两个请求：共用一个 `Headers`（当前两者都不下发 deadline，行为不变）。

**B. `api.server.ts:34` 一处加固（多请求页面取最早截止）**：
```ts
res.headers.forEach((value, name) => {
  const target = init?.responseHeaders; if (!target) return;
  const prior = target.get(name);
  // 一个页面从多个接口拼起来时，共享缓存只能用到最早的那个截止时间。
  if (name.toLowerCase() === "x-accel-expires" && prior?.startsWith("@") && value.startsWith("@")) {
    target.set(name, `@${Math.min(Number(prior.slice(1)), Number(value.slice(1)))}`);
  } else target.set(name, value);
});
```
理由：`Headers.set` 是后写覆盖，`report-detail`/`about` 两个请求一旦都下发截止，会取到"较晚"那个，正好是 P0-08 想修的反方向。

**C. 新增架构测试**（见 2.3）。

### 2.3 测试

放 `apps/web/tests/cache.test.ts`（已有：真生产服务器 + 假 API，失败域就是"页面缓存头"），加一个**纯静态**用例（读源码，不起服务）：
1. 扫 `apps/web/app/routes/*.tsx`，正则 `cachedPage\(\s*(\d+)\s*,` 取 `n`。
2. 断言：`n > 60` 且文件里有 `apiGet(` / `loadOr404(` 的调用，必须有第三个实参（没传 upstream 就红）。
3. 断言：该文件里存在 `responseHeaders:`（证明第三参不是凭空 new 的 Headers，而是真的从上游收集过）。
4. 断言：每个调用 `cachedPage` 的路由都导出了 `pageHeaders as headers`（否则 loader 返回的 headers 根本不会发出，是同一处回归的另一半）。
5. **显式豁免表**，不允许静默跳过：
```ts
/** 只有探针请求的页面：健康检查的 no-store 说明的是它自己，不是页面数据。 */
const NO_UPSTREAM: Record<string, string> = {
  "agent.tsx": "/api/health 返回 no-store；传进 cachedPage 会把 300 秒压成 0",
};
```
   并断言：豁免表里的文件**必须**仍存在一处 `n>60` 的 `cachedPage`（列表不会腐烂），且**不得**出现第三个实参（防止有人一边豁免一边乱传）。
6. 自测四条（改完手工验，不进 CI）：删掉 `topics.tsx` 的第三参 → 红；把 `responseHeaders:` 删掉 → 红；给 `agent.tsx` 补上第三参 → 红（豁免表与代码不一致）；现状 → 绿。

为什么放这个文件而不是新开：失败域就是"页面缓存头"，该文件已经在守它，符合约束 7；这是纯静态断言，不影响该文件现有的起服务用例。

### 2.4 迁移与数据影响

无。

### 2.5 验收

`npm run test:web` 全绿；对上面 8 个页面逐个删掉第三参，测试必须变红（抽查 3 个即可）。另手工抽查一条：给 `/api/site/reports/daily` 临时加上 `X-Accel-Expires`，`daily-archive` 的响应头截止时间应跟着变——这条能证明"传了 upstream"真的生效，而不只是测试过了。

### 2.6 风险与回滚

传 upstream 后若上游给 `no-cache/no-store`，页面缓存会降到 0 —— 已核对 8 个页面涉及的接口都不含（`agent.tsx` 的 `/api/health` 含，所以它走豁免表）。这是本项最容易做过头的地方：**"给所有页面加 upstream"是错的**，测试里的豁免表就是为了把这条判断固定下来。回滚 = 去掉 8 处的第三参与 `responseHeaders`，测试随之删掉。

---

## 项 3：版本统一 + Dependabot

### 3.1 现状确认

- `package.json:12-14`：`"engines": { "node": ">=24.22.1" }`。
- `docs/deploy.md:306`：「需要 Node.js 24.11 以上」；`docs/sources.md:138`：「Node.js 24.11 以上」。两处都低于 engines，照文档装 24.11 会被 npm 的 engines 检查拒。
- `Dockerfile:3`：`FROM node:24-trixie-slim AS base`（主版本浮动，构建时取 24 系最新；与 engines 的 24.22.1 下限不挂钩）。
- `.github/workflows/check.yml:44`、`:104`：`node-version: 24`。
- 无 `.nvmrc` / `.node-version`（实测 `ls -a`）；本机是 v22.22.2 —— 与 engines 不符却没有任何东西提醒。
- 无 `.github/dependabot.yml`（`.github/` 下只有 ISSUE_TEMPLATE、pull_request_template.md、workflows）。`AGENTS.md`「版本升级由 dependabot 提」目前是空承诺。
- `npm audit` 实测：0 漏洞（prod 203 / dev 145 / optional 100 / total 396）。

### 3.2 改动清单

**A. 版本口径统一到 `24.22.1`**（engines 是唯一被 npm 强制的一条，且生产在跑的就是它；往高处对齐比往低处改 engines 安全）。
- `docs/deploy.md:306`、`docs/sources.md:138` → 「Node.js 24.22.1 以上」。

**B. `Dockerfile:3` → `node:24.22-trixie-slim`**（minor 浮动，补丁自动进来）。三种取舍：

| 写法 | 补丁 | 可复现 | 结论 |
|---|---|---|---|
| `node:24-trixie-slim`（现状） | 自动 | 只到主版本 | 会把 24 系的任何变化带进生产，与 engines 下限脱节 |
| `node:24.22.1-trixie-slim@sha256:…` | 不自动（靠 dependabot） | 完全 | 最稳但最重，且 dependabot 一周一次才动 |
| **`node:24.22-trixie-slim`** | 自动 | 到 minor | **推荐**：补丁照进，minor 漂移由 dependabot 强制显形 |

**C. `check.yml:44`、`:104` → `node-version: "24.22.1"`**（写死与 engines 一致；若采纳 `.nvmrc`，可改 `node-version-file: .nvmrc` 让三处只有一个真源——见待拍板）。

**D. 新增 `.github/dependabot.yml`**：
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly, day: monday }
    open-pull-requests-limit: 5
    groups:
      npm-minor-patch:
        applies-to: version-updates
        update-types: ["minor", "patch"]
    ignore:
      - dependency-name: "*"
        update-types: ["version-update:semver-major"]
  - package-ecosystem: docker
    directory: "/"
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
```
要点：
- **npm workspaces 只有一个根 `package-lock.json`**，`directory: "/"` 就覆盖 `apps/*`、`packages/*`、`industry`、`site`、`modules/*`；按 workspace 各写一条会重复提 PR。
- `groups` 把 minor+patch 合成一个 PR，避免 396 个依赖把 PR 列表刷满；`open-pull-requests-limit: 5` 兜住上限。
- major 先 `ignore`：架构变化（Fastify 5、React Router 7 之类）必须人读 release notes，自动 PR 只会堆积。想升时临时删掉 ignore 或手开 PR。

**E. `npm audit` 门禁：本项不加。** 实测 0 漏洞，加是可行的；但新 advisory 会让与业务无关的 PR 变红，而 dependabot 已经在提安全更新。若以后要加，建议 `npm audit --omit=dev --audit-level=high` 只在每周的 schedule 里跑，不进 PR 门禁（列为待拍板）。

### 3.3 测试

无单元测试可写（这是配置与文档）。用 CI 与镜像自证：

### 3.4 迁移与数据影响

无。

### 3.5 验收

- `npm ci` 没有 `EBADENGINE`（engines 与 CI 版本对齐）。
- 本地按文档写的 24.22.1 装，`node -v` 满足 engines（改前照文档装 24.11 会被拒）。
- `docker build` 后 `docker run --rm <img> node -v` 输出 `v24.22.x`。
- dependabot 上线一周后：npm（一个 minor/patch 组 PR）、docker、github-actions 三类各至少一个 PR。
- 文档里搜 `24.11` 应无命中。

### 3.6 风险与回滚

dependabot 一次开太多 PR（已用 groups + limit 5 抑制）；minor 浮动意味着两次构建可能有补丁差异（这正是期望），要完全确定就改回 digest 锁。回滚 = 删 `dependabot.yml`、Dockerfile 改回 `24-trixie-slim`。

---

## 项 4：备份收尾

### 4.1 现状确认（哪些已做、哪些没做）

已做，不要重做：
- **传输完整性**：单次 PUT 把真实 sha256 作为 SigV4 `payloadHash`（`backup.ts:111`）；分片逐片签名（`:149`）。签名保证了"发出去的字节"与 sha 一致。
- **上传前校验**：`pg_restore --list`（`:204`），在 dump 之后、上传之前。
- **未配置对象存储会抛**：`:250` throw，不是静默（任务书判断正确）。

真实缺口三个：
1. **上传后没有核对**。SigV4 只覆盖请求体，不保证对象在桶里完整落地、没被中间层截断、没被同名对象覆盖成别的大小。`out.push({ bytes: size, sha256: sha })`（`:240`）记的是**本地**的事实。
2. **落盘不是原子的**。`const dump = path.join(dir, \`${name}-${stamp}.dump\`)`（`:183`）直接以最终名交给 `pg_dump --file`；`files`（`:205`）同理交给 `tar -czf`。中途失败会留下一个名字看起来完整、实际半截的文件，而 `KEEP_LOCAL`（`:18`、`:243-246`）会把它当正常备份参与"保留最新 3 份"——真出事时人可能拿它去恢复。
3. **未配置对象存储时彻底无声**。`backupAge` 第一行 `if (!backupConfigured()) return []`（`alerts.ts:237`）——这条是用来避免开发机误报的，代价是"生产忘了配 `DB_BACKUP_STORE_*`"也一起静默；`runBackup` 每天 throw 只落成 `job_runs` 的 failed，仓库里没有通用"作业失败"告警（`alerts.ts` 只对 `ops.backup` 查过 age，没有查 status）。

### 4.2 改动清单

**A. 原子落盘（`backup.ts:183-205`）**
```ts
const dump = path.join(dir, `${name}-${stamp}.dump`);
const dumpPart = `${dump}.part`;
// pg_dump → dumpPart；pg_restore --list dumpPart 通过后 rename(dumpPart, dump)
```
- `files` 同样：`tar -czf ${files}.part` → 校验（见下）→ `rename`。
- 失败路径：`catch`/`finally` 里 `rm(part, { force: true })`，清理失败不掩盖原错误。
- **不要改 `KEEP_LOCAL` 的前缀**：`${name}-2`（`:243`）看起来像笔误，其实是"数据库名 + 年份首位 2"的巧合匹配（dump 名是 `${name}-2026…`），而 `${name}-files-` 用来区分文件包。`.part` 的名字仍以这两个前缀开头，会被同一套清理覆盖，不会泄漏。
- 收益：`*_stamp.dump` 这个文件名从此只代表"已经过 `pg_restore --list` 校验的完整文件"。

**B. 上传后 HEAD 核对**
```ts
async function verifyObject(s: Store, key: string, size: number) {
  const url = new URL(`${s.endpoint}/${key}`);
  const res = await fetch(url, { method: "HEAD", headers: signV4({ method: "HEAD", url, region: s.region,
    accessKey: s.secretId, secretKey: s.secretKey, payloadHash: EMPTY_SHA, headers: {} }),
    signal: AbortSignal.timeout(60_000) });
  const length = Number(res.headers.get("content-length"));
  if (!res.ok || length !== size) throw new Error(`backup verify ${key}: HTTP ${res.status}, ${length} bytes (expected ${size})`);
}
```
- 调用点：`upload()` 内部末尾（单次 PUT 分支与分片完成分支各一次）。放在 `upload` 里而不是调用方，是因为"传完必须可核对"属于 `upload` 的契约。
- 只比 `Content-Length`，不比 ETag：S3 兼容实现里 ETag 对分片对象是 `md5(part-md5s)-n`，与本地 sha256 无法直接比；要比内容得 GET 回来，与"备份不该再花一个下行"冲突。长度 + 200 已经能拦住截断、空对象、键写错。

**C. 让"只在本地"可见（`alerts.ts:236-237`）**
- 不需要给 `backup.last` 加字段：`!backupConfigured()` 本身就能区分"这台机器没有对象存储"，而 `objects[].key` 的 `local-only:` 前缀（`:240`）已经是"没上传"的既有证据。
- `backupAge` 的早退改成：
```ts
const [b] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
if (!backupConfigured()) {
  // 从没跑过备份的开发机不打扰；跑过却一直只在本地，是一条要人拍板的配置问题。
  if (!b) return [];
  return [{ key: "backup.local-only", level: "later", title: "数据库备份只留在本机，没有上传",
    detail: `最近一次 ${beijingStamp(b.value.at)}；本机只保留最近 ${KEEP_LOCAL} 份，机器坏掉就没有备份`,
    action: "配置 DB_BACKUP_STORE_*（腾讯 COS 的 S3 兼容接口）后跑一次 ops.backup；若确定只要本地备份，忽略这条" }];
}
// 原有 uploaded/age 判断照旧
```
- 保持 `runBackup` 在 `!s` 时 throw：备份没出门就是没成功，`job_runs` 该记 failed。新增的 `later` finding 与它不冲突（一个进 job 历史，一个进 09:00 摘要）。

### 4.3 测试

`tests/backup.test.ts`（已有本地假对象存储）：
1. **HEAD 核对通过**：假 store 对 HEAD 返回对象的真实长度 → `upload` 成功。
2. **HEAD 长度不符**：假 store 返回 `size - 1` → `upload` 抛错，错误信息含 `verify`。这条守住"截断没被发现"。
3. **HEAD 404**：对象没落地 → 抛错。
4. **原子落盘（成功路径）**：跑一次 `runBackup`，目录里 `*.dump` 存在、`*.dump.part` 不存在。
5. **原子落盘（失败路径）**：让 `pg_restore --list` 失败（用不存在的 dump 或注入），断言最终文件名不存在、只剩 `.part` 且已被清理——若现有测试不好注入，退化为断言"最终文件名只在校验通过后出现"（用 mtime/存在性检查）。
6. **未配置 store 的告警**（`tests/alerts.test.ts` 的备份用例，若无则并入 `tests/backup.test.ts`）：清掉 `DB_BACKUP_STORE_*`、写一条 `backup.last` → `collectFindings` 含 `backup.local-only` 且 `level='later'`；没有 `backup.last` 时不产生任何 finding（守住"开发机不打扰"）。

### 4.4 迁移与数据影响

无迁移，也不改 `backup.last` 的形状（判定只看 `backupConfigured()` 与 `backup.last` 是否存在）。

### 4.5 验收

- 把假 store 的 HEAD 改成返回错误长度 → 备份 job 失败，`backup.last` 不写下"看起来成功"的 `uploaded: true`（`out` 在 upload 之后才 push，抛错时不会写 summary）。
- 断网场景：`upload` 抛错 → job failed → `backupAge` 的 `!uploaded` 分支照旧报。
- 未配置 store：09:00 摘要有"备份只留在本机"，而不是什么都没有。

### 4.6 风险与回滚

每天多几个 HEAD 请求（可忽略）；`rename` 在同一文件系统内是原子的，`config.dataDir` 下满足。回滚 = 去掉 HEAD 调用与 `.part` 改名（两者互不依赖，可分开退）。

---

## 项 5：关注页聚合接口

### 5.1 现状确认

- 前端请求：`modules/following/web/following.tsx`，`Feed` 在 `:128` 起；请求循环在 `:139-153`——**每个 slug × 每页一个** `fetch("/api/site/topics/<slug>?page=N")`，`Promise.all` 后 `setVersion`。
- 合并：`:170-186`，按 `id` 去重、按 `timelineAt` 降序；`hasMore` = 任一 slug 的 `pageCount > pages`；`failed` = 请求失败的 slug 数。**页码制**：`pages` 是"每个 slug 取前几页"，不是游标。
- 数据结构：`TopicPage`（`packages/contracts/src/site.ts:524-532`）含 `topic/modules/items/page/pageCount/pageSize`；条目是 `FeedItemSummary`（`:86`）。
- 后端：无聚合接口。可用读取函数 `loadTopicPage(slug, page, now?)`（`packages/backend/src/publication/topics.ts:333`）；它内部用 `topicIndex()`（`:230`），索引缓存 60 秒（`:229`），所以 N 次调用共享一次 `readIndex`。
- 模块挂载：`ServerModule.http(app)`（`packages/backend/src/modules.ts:181`）在 `apps/api/src/app.ts:106` 注册，**在引擎的 v1 fallback 之前**；`site/modules/server.ts` 是清单；`site/modules/index.ts` 已有 `following`（客户端那份）。
- `module.ts` 的 `apiPaths`：**不需要加**。`/^\/api\//` 已把所有 `/api/*` 判给 api 进程（`http-policy.ts:194`、`isApiOwned` `:224`、`apps/web/server.ts:161`）。`apiPaths` 的用途是 `/api/` 之外的模块自有机路径。
- `following` 模块没有 `server.ts`；`@aihot/following` 的 `exports` 只有 `./module`、`./web`。

### 5.2 改动清单

**A. 新增 `modules/following/feed.ts`（只有类型，无运行时依赖）**
```ts
import type { FeedItemSummary } from "@aihot/contracts/site";
/** 关注页的合并信息流：每个 slug 取前 pages 页，按 id 去重后按时间倒序。 */
export interface FollowingFeed {
  items: FeedItemSummary[];
  /** 还有任一 slug 的页数超过 pages。 */
  hasMore: boolean;
  /** 实际参与合并的 slug 数（未知 slug 与越界页不计）。 */
  served: number;
}
```
`modules/following/package.json` 要同时改三处（照 `modules/labeling/package.json` 的写法，它正是"有 server.ts 的模块"的模板）：
```jsonc
"exports": {
  "./module": "./module.ts",
  "./web": "./web.tsx",
  "./feed": "./feed.ts",      // 新：前后端共用的响应类型
  "./server": "./server.ts"   // 新：server.ts 插口
},
"dependencies": {
  "@aihot/api": "*",          // 新：sendProblem / siteHandler
  "@aihot/backend": "*",      // 新：defineServerModule / publication 读取层
  "@aihot/contracts": "*"
}
```
类型放模块内而不是 `packages/contracts`：框架不该知道某个模块的信息流形状（约束 6 的同一道理）。

**B. 新增 `modules/following/server.ts`**
```ts
import { defineServerModule } from "@aihot/backend/modules";
import { findTopic, loadTopicPage } from "@aihot/backend/publication/topics";
import { sendProblem } from "@aihot/api/http/respond";
import { siteHandler } from "@aihot/api/routes/site";
import type { FeedItemSummary } from "@aihot/contracts/site";
import type { FollowingFeed } from "./feed.ts";

const MAX_SLUGS = 30;
const MAX_PAGES = 10;

export default defineServerModule({
  name: "following",
  http(app) {
    app.get("/api/site/following/feed", siteHandler(async (req, reply) => {
      const q = req.query as Record<string, string>;
      const slugs = [...new Set((q.slugs ?? "").split(",").map((s) => s.trim()).filter(Boolean))]
        .filter((s) => findTopic(s) !== null);           // 未知 slug 直接忽略，避免站内主题被删后整页 500
      const pages = Math.min(Math.max(Number(q.pages) || 1, 1), MAX_PAGES);
      if (slugs.length > MAX_SLUGS) return sendProblem(req, reply, { status: 400, code: "bad_request", detail: `slugs 最多 ${MAX_SLUGS} 个` });
      if (!slugs.length) return { items: [], hasMore: false, served: 0 } satisfies FollowingFeed;

      const pagesOf = await Promise.all(slugs.map((slug) =>
        Promise.all(Array.from({ length: pages }, (_, i) => loadTopicPage(slug, i + 1)))));
      const seen = new Map<string, FeedItemSummary>();
      let hasMore = false, served = 0;
      for (const byPage of pagesOf) {
        const first = byPage[0];
        if (!first) continue;                              // 页码越界或主题此刻无内容
        served++;
        if (first.pageCount > pages) hasMore = true;
        for (const page of byPage) if (page) for (const it of page.items) if (!seen.has(it.id)) seen.set(it.id, it);
      }
      const items = [...seen.values()].sort((a, b) => (a.timelineAt < b.timelineAt ? 1 : a.timelineAt > b.timelineAt ? -1 : 0));
      return reply.header("Cache-Control", "public, max-age=30, s-maxage=30").send({ items, hasMore, served } satisfies FollowingFeed);
    }));
  },
});
```
要点：
- **不写 SQL**：只用 `loadTopicPage`（约束 2）。排序/去重规则与前端现状逐条对齐（:170-186），所以结果是同一份数据。
- `sendJsonWithEtag`（`apps/api/src/http/respond.ts:89`）可以换成它来拿 ETag；但该接口的入参随 `slugs` 变化，ETag 收益小、键组合多，先用 `Cache-Control` 即可（若要 ETag，把 `ids` 的排序结果参与 `etagOf`）。
- 返回体只有 `items/hasMore/served`，不含 `topic/modules`：合并信息流不需要每个 topic 的品牌块与模块 parts，这也是体积能接受的原因（上限 30×20 条）。

**C. `site/modules/server.ts` 加一行**（顺序与 `index.ts` 一致，`following` 在前）：
```ts
import following from "@aihot/following/server";
export const SERVER_MODULES: readonly ServerModule[] = [following, labeling, weiboMonitor];
```

**D. 前端改单请求（`following.tsx:128-186`）**
- `cache` 从 `Map<slug:page, TopicPage>` 换成 `useRef<{ key: string; pages: number; items: FeedItemSummary[]; hasMore: boolean } | null>`；上一次结果直接渲染成骨架（现在 cache 里已有旧页，等价）。
- 一个请求：`fetch(\`/api/site/following/feed?slugs=${encodeURIComponent(slugs.join(","))}&pages=${pages}\`)`。
- `failed`：请求失败 → `slugs.length`，否则 0（保留"有 N 个品牌的动态暂时没读到"的文案分支，但语义变成"整次请求失败"）。
- 请求失败时保留上一次的 `items`（现状也是：`cache` 里旧页还在），避免闪空。

**E. 不做**：`module.ts` 的 `apiPaths`（见 5.1）；不改 `/api/site/topics/:slug`（主题页仍在用）；不做服务端推送/预取。

### 5.3 测试

放 `tests/topics.test.ts`（已有 `buildApp`、`loadTopicPage`、真实库与主题构造工具，失败域就是"主题页读取"）。**必须 `installModules(SERVER_MODULES)`**（照 `tests/openapi-paths.test.ts:11`），否则路由根本没注册，测试会 404 而不是断言失败：
1. **合并与排序**：两个 topic、各 2 条（时间交错）→ `items` 4 条、按 `timelineAt` 降序、id 无重复。
2. **去重**：同一篇同时属于两个关注主题 → 只出现一次。
3. **页码**：`pages=2` 且其中一个 topic 只有 1 页 → 仍返回、`hasMore=false`；任一 topic 有第 2 页 → `hasMore=true`。
4. **上限**：31 个 slug → 400；30 个 slug → 200，`items.length <= 30 * TOPIC_PAGE_SIZE`。
5. **未知 slug**：混入一个不存在的 slug → 被忽略（`served` 不含它），其余正常返回，不 500。
6. **没有 slug**：返回空列表，不查库（可用执行时间或桩替身断言，简化为断言返回体）。

前端不单测：仓库里没有前端交互测试（`apps/web/tests` 全是 SSR/服务/纯函数），为这一处引入 jsdom 属于扩大范围。

### 5.4 迁移与数据影响

无迁移。`Dockerfile:20-21` 已经 COPY 了 `modules/following/package.json`，新增的 `@aihot/api`/`@aihot/backend` 依赖在 `npm ci` 阶段就能解析，不用改镜像。

（顺带一个与本项无关但会看到的差异：`Dockerfile:20-21` 只 COPY 了 `following` 与 `labeling` 的 package.json，没有 `weibo-monitor`。若镜像是生产通道，`@aihot/weibo-monitor/server` 在 `site/modules/server.ts` 里被 import，可能因 workspace 未登记而解析失败。不在本项范围，改这里时值得确认一次。）

### 5.5 验收

- 关注 3 个品牌，首屏 Network 里 `/api/site/following/feed` 只有 **1** 条请求；点"加载更多"再 +1（变化前是 3 条/次）。
- 同一批数据下，改造前后的条目 id 序列逐条一致（截图或对比 JSON）；`hasMore` 与"加载更多"按钮出现时机一致。
- 接口条数上限测试通过（`30 × 20`）。

### 5.6 风险与回滚

极端请求（30 slug × 10 页）会打 300 次 `loadTopicPage`（每次约 4 条查询：页条目、poolTotal、brands(缓存)、live seats），DB 压力不比现在小——**这是用 HTTP 次数换等待时间，不是省数据库**。上限靠 `MAX_SLUGS`/`MAX_PAGES` 双封。回滚 = 前端改回逐 slug 请求（接口留着无害）。

### 5.7 完整版 vs 代理版：建议**代理版**

理由（按权重）：
1. **语义本来就一样**。页面现在就是"每个 slug 取前 N 页、合并、按时间排"，不是跨主题游标。代理版返回的集合与现状**逐条相同**，是纯性能改动；完整版要另立一套游标语义，反而会改变读者看到的顺序。
2. **不制造第二份真相**。完整版要么在 `publication/` 里新写跨 topic 查询（复制 `seatedCondition`/`inTopic`/`evidenceCondition` 的组合），要么在模块里写 SQL——前者是两处规则并存，后者违反约束 2。代理版只调 `loadTopicPage`，规则永远只有一份。
3. **收益的差别很小**。完整版省下的是"每个 topic 各算一次 poolTotal/brands"，而 `topicIndex` 已缓存 60 秒、`brands` 也缓存；真正的开销是每页的条目查询，这一点两种版本一样。
4. **代价**：代理版多了一次进程内 fan-out（N 次函数调用）与略大的响应体。N ≤ 30、页 ≤ 10，可接受。

什么情况下改回完整版：关注数常态超过 30、或需要"跨主题统一游标 + 每页固定 20 条"的产品语义。那时应该在 `publication/topics.ts` 里加 `loadFollowingFeed(slugs, cursor)` 并由主题页与关注页共用同一套座位规则，而不是在模块里另写一套。

---

## 项 6：综述输入的【已更正】标记

### 6.1 现状确认

- 选取：`events/digest.ts:32-50`。`recent = reports.slice(-40)`（`:34`）；`corrected` 时取 `recent ∪ 每 fact 代表篇 ∪ 一手`（`:37-42`）。
- 哈希：`publication/story-evidence.ts:52-54`，对**传入的全部** `reports` 的 `[id, fact_id, title, summary, source_name, first_party, at, evidence]` 取 sha256。
- 判定链：`:70` 用**全量** reports 算 `inputsHash`；`:73` `sameReports` 比**全量** id；`:74` 早退；`:78` `dropped` 看全量 id；`:79` `corrected = rewrite || sameReports || dropped`；`:80` 生成输入；`:115` 竞态复核又用全量 hash。
- 读取层校验：`publication/story-text.ts:43-45` —— 用 `saved.article_ids` 过滤出"这一版看过的报道"，再算 hash 比对。**它已经隐含"选取集"概念，只是存的是全量 id。**
- 表：`story_digests`（`0002_events_reports.sql:39-48`）只有 `article_ids text[]` 与 `inputs_hash text`，**没有 per-report 哈希**。

### 6.2 更正信号调研（结论：没有现成标记，但不需要）

候选信号逐个核对：

| 候选 | 位置 | 能否当"被更正"信号 |
|---|---|---|
| `articles.revision` / `article_revisions.content_hash` | `0001_core.sql:93-101` | 只覆盖"正文换版"（内容重抓、正文提取成功） |
| `analyses.input_revision` + analyses 新行 | `publish.ts:271-272` | 只覆盖"分析重跑" |
| `editorial_overrides` | `0001_core.sql:197` | 只覆盖"编辑改标题/摘要/可见性" |
| `publications.revision` | `publish.ts:197` | **不能用**：只在 `sort_at` 变化时 +1，与内容更正无关 |
| `stories.updated_at` / `digest_updated_at` | `digest.ts:122-125` | **不能用**：写综述本身就会改它，是结果不是原因 |

三类真实改动最终都会落到 `digestReports`（`story-evidence.ts:36-50`）读出的那些列上（`p.title/summary`、`f.*`、`an.output->'fact'`、`fa.evidence`）。所以**覆盖全部机制的信号就是"当前投影内容的 per-report 哈希"**——不需要新增标记列，也不需要读 revisions/overrides 两套表。

它顺带修掉哈希不一致：把"输入哈希"定义在**模型实际看到的集合**上，"输入变了"与"模型看到的变了"从此是同一件事。当前的 bug 是：第 41 篇之前、既非一手也非 fact 代表的一篇被更正 → 全量哈希变了 → 触发重写（`sameReports` → `corrected`），但那篇不在输入里 → 模型收到"内容或事实证据经过更正"却看不到任何更正，白花一次钱，还可能凭空改写。

### 6.3 改动清单

**A. `publication/story-evidence.ts`：抽出单条哈希与选取集**
```ts
/** 一条报道在当前投影下的指纹：它变了，综述依据的内容就变了。 */
export function digestReportHash(r: Omit<DigestReport, "story_id">): string {
  return sha256(stableJson([r.id, r.fact_id, r.title, r.summary ?? "", r.source_name, r.first_party, r.at.toISOString(), digestFactEvidence(r)]));
}
// digestInputsHash 保持原签名与语义（对传入集合取哈希），story-text.ts:45 因此不用改。
```
`digestSelection` 放到 `events/digest.ts`（它是提示词与哈希共用的"看哪些报道"规则，属于综述逻辑）：
```ts
export function digestSelection(reports: Omit<DigestReport,"story_id">[]) {
  const recent = reports.slice(-40);
  const recentIds = new Set(recent.map((r) => r.id));
  const byFact = new Map(reports.map((r) => [r.fact_id, r.id]));
  const picked = new Set([...recentIds, ...byFact.values()]);
  for (const r of reports) if (r.first_party) picked.add(r.id);
  return reports.filter((r) => picked.has(r.id));   // 保序（byReportTime）
}
```

**B. `events/digest.ts`：哈希、判定、标记**
```ts
const selection = digestSelection(reports);
const ids = selection.map((r) => r.id).sort();
const inputsHash = digestInputsHash(selection);
const lastHashes = last?.report_hashes ?? null;
const changedIds = lastHashes
  ? selection.filter((r) => lastHashes[r.id] && lastHashes[r.id] !== digestReportHash(r)).map((r) => r.id)
  : [];                                   // 老版本没有 per-report 哈希：退回今日规则，不误标
const changed = changedIds.length > 0;
const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
const dropped = !!last && last.article_ids.some((id) => !ids.includes(id));
const corrected = opts.rewrite === true || changed || sameReports || dropped;
```
- 竞态复核（`:115`）同样换成 `digestInputsHash(digestSelection(await digestReports(tx, [storyId])))`。
- 写库（`:120-121`）加 `report_hashes`：
```ts
const report_hashes = Object.fromEntries(selection.map((r) => [r.id, digestReportHash(r)]));
INSERT INTO story_digests (story_id, version, digest, receipt_id, article_ids, inputs_hash, report_hashes) …
```
- `article_ids` 存 `selection` 的 id（不再是全量）——**这样 `story-text.ts:45` 的 `reports.filter(saved.has)` 自然就是选取集，读取层一行都不用改**，且它的校验从"全量内容没变"变成"模型看过的那部分没变"，与被验证对象一致。
- `subject: story:${id}@${ids.length}`（`:91`）里的 `ids` 也随之变成选取集，回执键随长度略变；影响仅限升级瞬间的一次在途重试（回执找不到就在下一轮重发，不丢钱）。

**C. `buildStoryDigestInput`：加可选 `changedIds`**
```ts
opts: { corrected: boolean; knownArticleIds?: string[]; changedIds?: string[] }
const changed = new Set(opts.changedIds ?? []);
// label 次序：先【已更正】，再【早期】，再【一手】/【新】
```
引导句在 corrected 分支（`:48`）里改：现有「报道内容或事实证据经过更正。请只依据下面这些报道的当前内容重写综述，不要沿用以前版本的说法。」→「标【已更正】的报道，其当前内容与上一版综述所依据的不同；请以它们现在的内容为准，不要沿用以前版本的说法。其余报道用于补足背景。」
`scripts/eval-story-digests.ts` 直接调这个函数，新增参数可选，**脚本不用改**。

**D. 不改 `industry/prompts/story-digest.md`。** 实测该文件全文 13 行、不含任何「【」，标签解释都在 user 消息里（【新】在 `digest.ts:49`，【早期】【一手】同样没有另立说明）。所以【已更正】的解释放进引导句，与现有做法一致；好处是 `DIGEST_PROMPT_VERSION`（`digest.ts:13`）不变，收据键不动。

**E. 迁移 `database/migrations/0175_story_digests_report_hashes.sql`**
```sql
ALTER TABLE story_digests ADD COLUMN IF NOT EXISTS report_hashes jsonb;
```
单语句、可空、无回填、无索引需求（只随版本行一起读写）。符合 0055 起的规范。

### 6.4 迁移与数据影响

- 0175 是一次加可空列的瞬时 DDL，`story_digests` 行数等于历史版本数（每 story 每版一行），不锁表。
- 历史行的 `report_hashes` 为 `null` → `changedIds` 为空 → 退回今日判定（`sameReports || dropped`），不会把老版本误标成"已更正"，也不会因此多花一次调用。
- `article_ids` 的含义从"当时全部报道"变为"当时模型看到的报道"。`story-text.ts` 只用它做过滤，语义更贴切；`story_digests` 无其他读取方（实测只有 `digest.ts` 与 `story-text.ts`）。
- **一次性的升级副作用**：报道数 ≤40 的故事，选取集等于全量，`sameReports` 照旧为真，不受影响；报道数 >40 的故事，旧的 `article_ids` 是全量、新的 `ids` 是选取集，`dropped`（`:578`）会为真 → **推出后第一次运行会重写一次**。这是有意的（让这些版本建立 per-report 指纹），影响只落在长故事上、一次性，不会反复。

### 6.5 验收

1. **哈希与输入一致**（最有说服力的一条）：对 20 个有 digest 的 story，用当前库重算 `digestInputsHash(digestSelection(reports))`，必须等于 `story_digests.inputs_hash`（升级后新写的行；旧行为 null 跳过）。
2. **"看不见的更正"不再白花钱**：造一个 45 篇的故事，取第 3 篇（非一手、非 fact 代表）改其 `publications.summary` → 跑 `composeStoryDigest` → **不触发重写**（`updated:false`，无新收据）。
3. **看得见的更正被标注**：改第 45 篇（在最近 40 内）的 summary → 触发重写，且该次请求的 user 文本里那一行带【已更正】。
4. **回归**：`tests/story-digest-eval.test.ts` 与 `scripts/eval-story-digests.ts` 不改也应通过（函数签名向后兼容）；`tests/content-publication.test.ts:193` 断言 `article_ids` 等于当时的公开报道，测试里的故事都远少于 40 篇，选取集等于全量，不受影响——**若哪个用例造了 >40 篇报道，这里要跟着改**。
5. SQL 佐证：
```sql
-- 升级后新写的版本都带了 per-report 指纹
SELECT count(*) FROM story_digests WHERE version > 0 AND report_hashes IS NULL
  AND created_at > now() - interval '1 day';   -- 期望 0
```

### 6.6 风险与回滚

提示词文件与版本号都不变，所以老故事不会因为这次改动被迫重写；回滚只需忽略 `changedIds`（`report_hashes` 列留着无害），迁移不回退。

---

## 推荐实施顺序

| 批次 | 项 | 理由 |
|---|---|---|
| 1 | **项 3**（版本 + dependabot） | 零代码风险，先落地让后面所有 PR 都在一致的 Node 版本上跑；dependabot 也需要一个干净基线 |
| 2 | **项 2**（缓存头收尾 + 架构测试） | 纯前端 + 一个静态测试；与项 3 可同批，互不影响 |
| 3 | **项 4**（备份收尾） | 独立、不碰内容链路，测试文件自足 |
| 4 | **项 1**（周月报补写 + 缺刊告警） | 六项里唯一要改告警结算（`settleDailies` → `settleReports`）的，回归面最大，单独一批，`daily-report-alerts.test.ts` 全绿是准入 |
| 5 | **项 6**（综述标记 + 哈希一致性） | 要发迁移 0175，且必须读懂 `:74/:115` 的两处早退与竞态；放后面便于用前四项的绿色基线做对照 |
| 6 | **项 5**（关注页聚合） | 纯增强、读者可见变化最大但正确性风险最低；可与项 3 并行，不阻塞任何一项 |

依赖关系只有两处：
- 项 2 与项 1 改的是不同测试文件（`apps/web/tests/cache.test.ts` 与 `tests/daily-report-alerts.test.ts`），没有技术依赖；先做项 2 是因为它是纯机械改动、几分钟能验完，把注意力留给项 1 的结算逻辑。
- 项 6 的 `0175` 在其余五项都不发迁移的前提下是安全的；若这期间有别的改动先占了 0175，顺延即可（0055 起按完整文件名排序，不要求连号）。

## 项 5 的建议

**做代理版**（复用 `/api/site/topics/:slug` + 服务端并行调用 `loadTopicPage`），不做跨主题游标的完整版。核心理由：页面的合并语义本来就是"每主题取前 N 页再合并"，代理版与现状逐条相同、只把 N 个请求合成 1 个；完整版不但要新写跨 topic 的座位查询（规则变成两份），还会改变读者看到的顺序，收益仅是极端深翻页时更均匀。详见 5.7。

## 待拍板

1. **项 1 的补写范围**：只补当期（`RETRY_WINDOW = 1`）还是补最近 8 周 / 12 个月？前者上线当天零成本，后者一次性把历史降级刊都修好（会多花几次模型调用）。
2. **项 1 的重试上限**：`RETRY_MAX = 2`（每期最多 3 次模型调用）。如果这个站在意"总述一定有"，可以放宽到 3–4；`report_revisions` 的账本能兜住无限循环，但每次都是真花钱。
3. **项 3 是否加 `.nvmrc`**：加了本地与 CI 只有一个真源（`node-version-file`），代价是仓库多一个文件；不加就得接受"engines 写了但本地仍可能跑 22"（本机现状）。
4. **项 3 的 npm audit 门禁**：当前 0 漏洞可以加，但会让新 advisory 直接红 PR。建议只在每周 schedule 跑 `--audit-level=high`，不进 PR 门禁。
5. **项 4 的"只在本地"要不要算失败**：方案保持 `runBackup` throw（job 记 failed）+ 一条 `later` 摘要。若你希望"确定只用本地备份"时 job 算成功，则要把 throw 改成返回 `localOnly: true` —— 这是运维取向，不是代码问题。
6. **项 6 的标签措辞**：信号覆盖"编辑更正 / 来源改稿 / 重新分析"三类，用【已更正】还是【内容已更新】？前者更像编辑动作，后者更准确但更长。
