# 已闭环项的五处质量补丁方案

基线：`15726ea`（工作区另有 `docs/plans/final-six.md` 两行未提交，与本方案无关）。
范围：上一轮"已做完的做的好吗"审计中判为 🥉 的五项。P0-04 我已从 C 改判 B（原验收真过了，见下方偏差 1），不进本方案。
**只写方案，不改代码。** 行号全部实测于基线，落笔前逐处 `sed` 复核过。

## 0. 与上一轮审计的偏差（实测纠正）

| # | 上一轮审计说 | 实测 | 对本方案的影响 |
|---|---|---|---|
| 1 | P0-04 早期事实仍丢（C） | **原验收过**：`tests/story-digest-eval.test.ts:28-40` 的 60 篇用例把第 5 篇放 `i===4`，是某 fact 的代表；被更正标记另有 `:59-64` 断言。缺口只在"同 fact 非代表且非一手且不在最近 40"的边角 | 不进方案，避免为边角改选取算法 |
| 2 | P0-06 可用伪造 XFF 绕过 IP 限流（C） | **半成立**：`apps/web/server.ts:161-167` 已把 XFF 收敛成单值（取 Caddy append 的**最后一个**，攻击者伪造值在前被丢弃），且 `docker-compose.yml` 里 api 无 ports。但当前 `.env:120` 是 `TRUST_PROXY=false` → web 传的是 Caddy 容器 IP，**所有访客共用一个 `ip:` key**，10 次失败就锁死所有人 | 修法从"api 侧校验 IP"改为"代码读 `clientIp()` + 修配置"，见第 3 项 |
| 3 | P1-13 与 Caddy 不等价（C） | 成立，但 HSTS 差异是**正确**的：`deploy/Caddyfile:5` 用 `header ?`（仅 HTTPS），`request-target.test.ts:68` 明确断言 HTTP 直连没有 HSTS | 只补 4 个头，不动 HSTS |

---

## 1. P1-09 关注页聚合：消除后端 N+1

### ① 现状确认

- `modules/following/server.ts:23-24`：`slugs.map(slug => Promise.all(pages.map(...loadTopicPage)))`，最坏 30×10=300 次调用。
- `packages/backend/src/publication/topics.ts:333-368` 每次 `loadTopicPage` 内部 `:350-358` 发 4 条 SQL（items / poolTotal / companyBrands / currentSeats），其中 `companyBrands` 在 `:240-249` 还会遍历模块。**约 1200 条查询一次性 `Promise.all`**，pg 默认池 10 → 排队。
- `modules/following/server.ts:8-9` 有上限 `MAX_SLUGS=30`/`MAX_PAGES=10`，但**没有总调用预算**，30×10 是合法输入。
- `tests/topics.test.ts:196-257` 六个用例覆盖合并/去重/分页/30 slug 上限，但 `:233-248` 那个"30 topics"用例正是最坏路径，却只断言 `served===30`，不测耗时与查询数。
- 可见性没问题：`:352` 走 `seatedCondition(at)`（`scope.ts`），withdrawn 被过滤。

### ② 改动清单

**A. `packages/backend/src/publication/topics.ts` 新增批量读取（唯一新函数）**

```ts
/**
 * The items of several topics' first pages, in one read. Unlike loadTopicPage this needs neither
 * topic summaries, module parts nor brands: a feed shows only items. Membership comes from the
 * cached index (up to a minute behind); withdrawal and visibility are checked live here.
 */
export async function loadFollowingItems(
  slugs: string[], pages: number, now = new Date(),
): Promise<{ idsBySlug: Map<string, string[]>; items: FeedItemSummary[]; hasMore: boolean }> {
  const index = await topicIndex(now);
  const idsBySlug = new Map<string, string[]>();
  const all = new Set<string>();
  let hasMore = false;
  for (const slug of slugs) {
    const seats = index.bySlug.get(slug) ?? [];
    const limit = pages * TOPIC_PAGE_SIZE;
    const ids = seats.slice(0, limit).map((s) => s.id);
    idsBySlug.set(slug, ids);
    for (const id of ids) all.add(id);
    if (seats.length > limit) hasMore = true;
  }
  const rows = all.size
    ? await sql<ItemRow[]>`SELECT ${ITEM_COLUMNS} ${ITEM_FROM}
        WHERE p.article_id = ANY(${[...all]}::text[]) AND ${seatedCondition(now)}
        ORDER BY p.timeline_at DESC, p.article_id DESC`
    : [];
  return { idsBySlug, items: rows.map(toFeedItemSummary), hasMore };
}
```

三条约束写进函数注释：**① 不再调 `loadTopicPage`（避免 module parts / poolTotal / brands 的附带查询）；② `seatedCondition(now)` 实时过滤撤回，成员关系允许滞后 60 秒（与 index 的 TTL 一致）；③ `ITEM_COLUMNS`/`ITEM_FROM` 复用，不另写公开读取 SQL**（守住"公开出口只从 publication 读"）。

**B. `modules/following/server.ts:23-39` 改为一次调用**

```ts
const { idsBySlug, items, hasMore } = await loadFollowingItems(slugs, pages);
const byId = new Map(items.map((item) => [item.id, item]));
const seen = new Set<string>();
const merged: FeedItemSummary[] = [];
let served = 0;
for (const [slug, ids] of idsBySlug) {
  if (!ids.length) continue;
  served++;
  for (const id of ids) {
    if (seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;                  // withdrawn since the index was read
    seen.add(id);
    merged.push(item);
  }
}
merged.sort((a, b) => a.timelineAt < b.timelineAt ? 1 : a.timelineAt > b.timelineAt ? -1 : 0);
return reply.header("Cache-Control", "public, max-age=30, s-maxage=30").send({ items: merged, hasMore, served } satisfies FollowingFeed);
```

关键：`pages` 的语义从"取 N 页对象"变为"每 slug 取前 `N*TOPIC_PAGE_SIZE` 个座位"，对读者可见结果不变。

### ③ 测试

并入 `tests/topics.test.ts`（已有 following 六个用例，不新开文件）：

1. **新旧等价**：把现有 `:198` 的 `followingFeed` 对照改为——同一组 slugs/pages 分别调 `loadTopicPage` 逐页拼装与 `loadFollowingItems`，`assert.deepEqual(ids(a), ids(b))`。这证明批量化没改变读者看到的内容。
2. **撤回实时性**：造数后调 `loadFollowingItems`，再 `UPDATE publications SET visibility='withdrawn'`，重调一次（用 `t.mock.timers` 推进，参考 `tests/topic-cache-deadline.test.ts:12`），断言该 id 消失——守住"成员可滞后、撤回不可滞后"的取舍。
3. **查询次数**：给 `loadFollowingItems` 加可选 `sql` 注入参数？**不要**——那会把生产签名改成测试形状。改用源码扫描（并入 `tests/architecture.test.ts`）：断言 `modules/following/server.ts` 不再 import `loadTopicPage`。这是结构守卫，不是行为守卫，**在注释里写清它的强度边界**。

### ④ 迁移与数据影响

无。不碰表、不碰 settings、不碰环境变量。

### ⑤ 验收

`30 个 slug × 10 页` 的请求在**不改上限**的前提下，SQL 查询数从 ~1200 降到 1（+1 次缓存 index 命中）；`tests/topics.test.ts` 六个原用例全绿，新增等价用例绿。

### ⑥ 风险与回滚

回滚 = 把 `server.ts:23-39` 恢复成 `loadTopicPage` 两层 map，`topics.ts` 的新函数可留可删（无调用者即惰性代码，但按 AGENTS.md 规矩应一起删）。

### ⑦ 需拍板

- **成员关系滞后 60 秒是否可接受**。`loadTopicPage` 用 `inTopic(topic)` 实时复查成员（`:352`），批量版只用缓存 index。若不接受，需在批量 SQL 里加 `OR`-拼装的 `inTopic()`，查询变大但语义完全一致。**我倾向接受**：index TTL 就是 60 秒，单页路径的 `inTopic` 只防跨主题的成员漂移，关注页不靠它做权限。
- 是否顺带把 `MAX_PAGES` 从 10 降到 3（前端 `following.tsx` 实际请求几页我没改代码确认）。**不建议动**：这是产品口径，不是性能修复。

---

## 2. P0-08 撤回后长缓存页绕过：补齐上游绝对截止时间

### ① 现状确认

- 详情页已修好：`apps/api/src/routes/site.ts:93/102` 下发 `X-Accel-Expires: @now+60`；`apps/web/app/routes/item.tsx:43` `cachedPage(60)`。
- **报告类路由没下发**：`site.ts:173-212` 的 5 个路由只走 `sendJsonWithEtag`（`apps/api/src/http/respond.ts:89-95`，只写 ETag/Cache-Control/Vary），**没有 `X-Accel-Expires`**。
- 于是 web 侧 `cachedPage` 拿不到 upstream deadline：`apps/web/app/lib/api.server.ts:116-118` 的 `sourceDeadline` 为空，`:115` `deadline = second + seconds` 完全用页面自己的数字。
- **降 TTL 确实有用**：报告内容是 JSONB 静态存的，但读取时 `reports.ts:334-341` `issueAvailability` 每次把 sections/flashes/themes/picks/related 里的 itemId 重新查一遍 `listedCondition(now)`，`:203` `stillPublic` 过滤掉已撤回项。所以缓存一过期，下一次读取就反映撤回——不需要重写报告。
- 页面侧数字：`report-detail.tsx:33` **3600**、`report-latest.tsx:23` **600**、`daily-archive.tsx:23` **600**、`story.tsx:36` **300**、`hot.tsx:31` 120。
- 架构测试 `apps/web/tests/cache.test.ts:36-59` 只检查"`cachedPage(n>60)` 要传第三个参数 + `responseHeaders:`"——**传了空的 `Headers` 也算过**，这正是漏洞没被挡住的原因。

### ② 改动清单

**A. `apps/api/src/routes/site.ts` 给 6 个路由下发绝对截止时间（照抄 `:75`/`:93` 的写法）**

```ts
reply.header("X-Accel-Expires", `@${Math.floor(Date.now() / 1000) + 60}`);
```

落点：`:173` reports index、`:181` latest-page、`:190` navigation、`:197` month、`:204` report detail、`:160` story detail。全部 60 秒。理由：报告是"发布后基本不变、但撤回/更正会重写"的内容，60 秒与详情页同一口径。

**B. `apps/web/app/routes/` 把四个页面的第一个参数降到 60**

`report-detail.tsx:33` `3600→60`、`report-latest.tsx:23` `600→60`、`daily-archive.tsx:23` `600→60`、`story.tsx:36` `300→60`。**只改数字，不动 `upstream` 实参**——A 落地后 upstream 会给出更紧的 deadline，`cachedPage` 的 `Math.min` 自动生效，数字只是第二道保险。

**C. `apps/web/tests/cache.test.ts:36-59` 加强架构断言**

在 `:55` 的 `hasUpstream` 检查之后追加：对 `report-detail/report-latest/daily-archive/story/hot` 五个文件，断言源码同时含 `responseHeaders: upstream` **且** `cachedPage\(\s*(?:60|[1-9]?\d)\s*,`（即第一个参数 ≤60）。不搞复杂 AST，正则与现有风格一致。

### ③ 测试

1. `tests/public-cache.test.ts`（已有 60 秒撤回窗口测试与三种报告的造数，`:20-31`）追加一条：遍历上面 6 个 API 路径，`assert.match(String(res.headers["x-accel-expires"]), /^@\d+$/)` 且 `deadline - now <= 61`，断言 404 路径例外（`no-store`）。
2. `apps/web/tests/cache.test.ts`：新增一个假 API 用例，让报告接口返回 `@now+60`，页面 loader 请求 `cachedPage(3600,...)` 的 report-detail 路由，断言最终 `X-Accel-Expires` 不晚于 `now+60`。**并入已有文件**，不新开。
3. 架构断言 C 是源码扫描，会随数字改坏立刻变红。

### ④ 迁移与数据影响

无。缓存头只影响响应，不改数据。

### ⑤ 验收

撤回一篇被日报引用的报道后，**报告详情页、最新一期页、往期索引页、事件页**在 60 秒内都不再显示它（用 `raw()` 请求断言响应体不含该标题），与详情页同一口径。`apps/web/tests/cache.test.ts` 的架构测试能拦住未来把数字改回 3600 的提交。

### ⑥ 风险与回滚

回滚 = 恢复 6 个数字（立即生效）+ 撤掉 API 的 `X-Accel-Expires`（需重新部署 api）。代价：报告页 API 负载上升（60s vs 3600s），站点日更、量级小，可接受。若有 CDN 忽略 `X-Accel-Expires`，页面侧 60 秒仍是硬上限，安全。

### ⑦ 需拍板

- **报告是否该与详情页同 TTL（60 秒）**。报告内容更稳定，理论上可放宽到 300 秒，但撤回场景要求"及时"，且 60 秒与全站口径统一。**我建议 60 秒**。
- 是否顺带给 `hot.tsx`（120s）和 `topics.tsx`/`about.tsx`（300s）也设上限。它们不含单篇报道标题摘要的部分场景，但 `hot.tsx` 含。**建议本轮只做 `hot`**，其余留到有具体撤回投诉再动。

---

## 3. P0-06 登录限流：修配置 + 读收敛后的 IP

### ① 现状确认（这一项我推翻了自己的上一轮判定）

- `apps/api/src/routes/admin-auth.ts:29-35`：`IP_LIMIT=10`、`GLOBAL_LIMIT=50`、`MAX_KEYS=5000`，`:36-53` 全局 50 次只 `log.warn("security.login_throttled")`，不拦截——原问题"锁死唯一入口"**已解除**。
- `:169` 用 `req.ip` 作 key；`apps/api/src/app.ts:41` 是 `trustProxy: true`。
- **信任链实测**：`apps/web/server.ts:23` `TRUST_PROXY = env === "true"`；`:161-167` 对 api-owned 路径，取 `x-forwarded-for` 的**最后一个**（Caddy 的 `$proxy_add_x_forwarded_for` 把真实访客放在末尾，攻击者伪造值在前面被丢弃），然后**覆盖**成单值 `x-forwarded-for`/`x-real-ip` 转给 api。所以 `TRUST_PROXY=true` 时伪造无效。
- **真正的缺口是配置**：`docker-compose.yml:100` `TRUST_PROXY: ${TRUST_PROXY:-false}`，而当前 `.env:120` 和 `.env.example:119` 都是 `false`；`docs/deploy.md:48/57` 却写 `true`。`false` 时 web 传 `req.socket.remoteAddress`——**Caddy 容器 IP，所有访客共用**。结果：任意 10 次失败（不需要同一攻击者）就触发 `too-many`，把管理员和其它访客一起挡 15 分钟。这比原规划修掉的"全局 50 次锁死"更容易触发。
- 已有 `apps/api/src/http/respond.ts:143-145` `clientIp(req)` 读 `x-real-ip`，**已存在但 admin-auth 没用**。
- `tests/admin-session-revocation.test.ts:183-209` 四条用例真断言了"100 IP 各错一次后管理员仍可登录"，但请求直接打 api、手动带 XFF，**绕过了 web 代理这一层**，所以没发现配置陷阱。

### ② 改动清单

**A. `apps/api/src/routes/admin-auth.ts:169` 改用已有的收敛值**

```ts
import { clientIp } from "../http/respond.ts";
// ...
const key = `ip:${clientIp(req)}`;   // web 已把 XFF 收敛成单值；避免 api trustProxy 再解析一整条链
```

一处 import + 一行替换。`clientIp` 在 `respond.ts:144` 是现成的，不要新写 helper。

**B. 让默认配置正确（两处文档 + 一处 compose）**

- `docker-compose.yml:100` 默认值 `${TRUST_PROXY:-false}` → `${TRUST_PROXY:-true}`。改动理由是默认部署路径**（Caddy → web）必须让 web 读 XFF**，否则所有访客共用一个 IP key。
- `.env.example:119` 与 `docs/deploy.md:48` 统一成 `TRUST_PROXY=true`，并补一句"直连 web（无 Caddy/Nginx）时设回 false，否则会信任访客自带的 XFF"。`docs/deploy.md:57` 已有 Nginx 的说明，保持。

**C. 不新增全局拦截**。全局 50 次只告警是**有意设计**（原规划改法第 3 条就是"写审计并告警，不锁死"），12 位密码是主要防线。不要擅自加回拦截。

### ③ 测试

并入 `tests/admin-session-revocation.test.ts`（已有 `:183-209` 四条登录/IP 用例）：

1. 新增一条"经 web 代理的 IP 隔离"用例。**难点**：该文件直接打 api，没有 web 进程。做法不是起 web，而是模拟 web 已经做过的事——请求带**单一** `x-real-ip`（不带 XFF），断言 `clientIp` 读到的就是它、不同 `x-real-ip` 的失败互不计数。这验证 A 的取值来源正确。
2. 配置守卫并入 `tests/architecture.test.ts`：读 `docker-compose.yml`，断言 `TRUST_PROXY` 默认值不是 `false`（正则 `/TRUST_PROXY:\s*\$\{TRUST_PROXY:-(true)\}/`），并断言 `docs/deploy.md` 含 `TRUST_PROXY=true`。**这条测试守的是部署文档与默认值的漂移**，是唯一能发现"配置陷阱回归"的自动化手段。

### ④ 迁移与数据影响

无。`attempts` 是进程内 Map，重启即清。

### ⑤ 验收

- 默认 compose 起站（不改 `.env`），从**两个不同来源 IP** 各打 6 次错误密码（合计 12 次 > IP_LIMIT=10），管理员用正确密码仍能登录。`TRUST_PROXY=false`（直连模式）下同一测试不应通过——这正是配置守卫的意义。
- `tests/admin-session-revocation.test.ts` 原有 100-IP 用例仍绿。

### ⑥ 风险与回滚

回滚 = 恢复 `req.ip`、恢复 `false` 默认值。**风险点**：若有人直连 web:3000 且 `TRUST_PROXY=true`，可伪造 XFF 绕过 IP 限流。compose 里 web 确实映射了 `${PORT}:3000`（`docker-compose.yml:104-105`），所以**必须同时在部署文档写明"只允许 Caddy/Nginx 访问 3000"**；无法做到（例如云厂商 LB 直连）时用 `false` 并接受共享 IP key。这条写进待拍板。

### ⑦ 需拍板

- **是否把 web 端口从 compose 的 `ports` 移除，只让 Caddy 可达**（`expose: 3000` + caddy 同网络）。这是根治伪造 XFF 的办法，但会改变本地直连调试方式。**我建议先只改文档 + 默认值，暂不动端口映射**——需要你确认生产环境 3000 是否对公网开放。
- 是否把 `IP_LIMIT` 从 10 提到 20（12 位密码是主防线，10 次略紧）。**不建议动**：无锁死证据，别改数字。

---

## 4. P1-06 金标护栏在 CI 恒跳过

### ① 现状确认

- `tests/analyze.test.ts:327-334`：`.data/gold.jsonl` 不存在就 `return t.skip("缺少 .data/gold.jsonl，护栏未生效")`。
- `.gitignore:8` 是 `.data/`，CI checkout 必然没有该文件 → **这条测试永远 skip**。
- `.github/workflows/check.yml:80-81` 只跑 `npm test`，不跑 `scripts/eval-selection.ts`；eval 脚本的 `:51` 从 `--gold` 指定的文件读，默认路径也指向忽略目录。
- 同文件 `:308-326` 的门槛顺序与 `scoresSelect` 断言**是有效的**（NaN 比较会抛错，不是静默通过）， `:335+` 的 class 门槛断言也有效。缺的只是金标解析这一条。

### ② 改动清单

**A. 新增 `tests/fixtures/gold-smoke.jsonl`（数据文件，不是测试文件）**

3 条最小金标，覆盖 `select`/`reject`/`either` 三种决策与一个带 `selectionClass` 的样本，字段按 `scripts/eval-selection-core.ts:14-32` 的 `GoldRow` zod schema 填（caseId / material / sourceFacts / gold）。用真实本站字段名（`sourceTier: "T1_5"`、`language: "zh"`），不要编造 schema 外字段。

**B. `tests/analyze.test.ts:327-334` 改为读 fixture**

```ts
test("the gold set parses and has no duplicate case ids", () => {
  const smoke = path.resolve(REPO_ROOT, "tests/fixtures/gold-smoke.jsonl");
  const full = path.resolve(REPO_ROOT, ".data/gold.jsonl");
  const file = existsSync(full) ? full : smoke;      // 本地有全量金标就验全量，CI 验 smoke
  const rows = parseSelectionGoldJsonl(readFileSync(file, "utf8"));
  assert.ok(rows.length >= 3);
  assert.equal(new Set(rows.map((r) => r.caseId)).size, rows.length);
  assert.deepEqual([...new Set(rows.map((r) => r.gold.decision))].sort(), ["either", "reject", "select"]);
});
```

关键是**不再有 `t.skip` 分支**。fixture 缺失时 `readFileSync` 抛错，测试变红——这才是护栏。

**C. `scripts/eval-selection.ts` 不改**。`--gold` 已可指向任意路径（`:51`），CI 不需要跑付费评测；本方案只解决"解析与去重护栏恒跳过"。

### ③ 测试

这条本身就是测试改动，并入 `tests/analyze.test.ts`。自检方法：`git stash` 掉 fixture 后跑该文件，测试必须红（证明不是恒真）；恢复后绿。

### ④ 迁移与数据影响

无。smoke fixture 是新增文件，`.data/` 仍被忽略，不提交任何标注数据。

### ⑤ 验收

在**干净的 CI checkout**（无 `.data/`）跑 `npm test`，这条测试显示 pass 而非 skip，且三种决策都被断言到。删掉 fixture 中一个 `caseId` 改成重复值，测试变红。

### ⑥ 风险与回滚

回滚 = 恢复 `t.skip` 版本并删 fixture。风险：smoke 数据写错（zod 解析失败）会让 CI 红——这是护栏该有的行为，不是问题。

### ⑦ 需拍板

- **CI 是否要跑真实的 `eval-selection.ts`**。那需要模型 key 与样本，付费且慢，AGENTS.md 也要求付费走回执——**不建议本轮做**。当前方案只保证"金标格式与解析"不退化。
- 3 条 smoke 是否够。够，它守的是解析与去重，不守评分正确率。

---

## 5. P1-13 安全头兜底覆盖全部响应路径

### ① 现状确认

- `apps/web/server.ts:106-144` 的 4 个头（X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy）写在 `pageResponse()` 内**包装 `res.writeHead` 的闭包里**，只在走 `ssr()` 的页面响应生效。
- 绕过路径三条：
  - `:68-73` `serveStatic` 自己 `writeHead`，只带 `nosniff`；
  - `:153-159` `resolveRedirect` 直接 `res.end`，从不进 `pageResponse`；
  - `:80-86` 错误兜底 400/500 直接 `writeHead`，也不进。
- `deploy/Caddyfile:5-9` 的 `header ?` 对**所有**响应生效，所以只有直连 web 时缺。
- HSTS 差异**不是缺陷**：`header ?Strict-Transport-Security` 仅在 HTTPS 站点生效，`apps/web/tests/request-target.test.ts:68` 明确断言 HTTP 直连为 undefined。

### ② 改动清单

**A. `apps/web/server.ts`：把四个头挪到 `createServer` 回调最前面（覆盖所有路径）**

```ts
const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const server = createServer((req, res) => {
  // One place for every response: pages, static files, redirects, errors and proxied API answers.
  // Caddy sets the same four; the web layer must match it when reached directly.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!res.hasHeader(name)) res.setHeader(name, value);
  handle(req, res).catch(...);   // 原样保留
});
```

**B. 删掉 `pageResponse` 内 `:110-116` 的那段注入**（避免两处维护）；保留 `:117-121` 的 `.data` MIME 修正与 `:122-142` 的缓存策略。`serveStatic:72` 的 `nosniff` 可留（顶层会跳过已存在的头，无害），也可删，建议留以减少 diff。

**为什么放在 `createServer` 而不是 `handle`**：`handle` 里 `:169` 的 `serveStatic` 与 `:161` 的 `proxyToApi` 都可能提前 `return`，放在最外层才能保证无遗漏。`proxyToApi` 内部 `res.writeHead(up.statusCode, endToEnd(up.headers))`（`api-proxy.server.ts:24`）会透传 api 的头；顶层 `setHeader` 的同名头在 Node 里被 `writeHead` 参数覆盖——api 不设这四个头，所以实际保留，符合预期。

### ③ 测试

并入 `apps/web/tests/request-target.test.ts`（已有 `:60-69` 的页面头用例）：

1. 把现有用例改名为"页面、静态、重定向、错误响应都带 Caddy 的四个头"，在一条测试里依次请求：
   - `/`（页面，已有）；
   - 一个静态资源路径（参照同文件 helper，取实际存在的 `/assets/*` 或 favicon）；
   - 一个触发 `resolveRedirect` 的路径（同文件 `:51` 附近有 404/重定向用例可复用请求构造）；
   - 一个触发 500 的路径（文件首行注释提到 origin-form `//` 会抛 500，直接用那个）。
   每类都断言四个头、并断言 HSTS 仍为 undefined。
2. **不要**加 CSP 断言——Caddy 也没有，两边一致。

### ④ 迁移与数据影响

无。

### ⑤ 验收

关掉 Caddy 直连 `web:3000`，对页面/静态/重定向/错误/API 代理五类响应抓头，四个头齐全且与 `deploy/Caddyfile` 取值一致（HSTS 除外）。开 Caddy 后无重复头、取值不变。

### ⑥ 风险与回滚

回滚 = 恢复 `pageResponse` 内的四头注入、删掉顶层循环。风险：顶层 `setHeader` 在 `res.destroy()` 前设置，对已销毁连接无影响；`proxyToApi` 若 api 将来也设同名头会以 api 为准，这是期望行为。

### ⑦ 需拍板

- **是否连 HSTS 一起兜底**。不建议：需要判断 `X-Forwarded-Proto`/`req.socket.encrypted`，且在 HTTP 直连时发 HSTS 会导致浏览器拒绝后续 HTTP 访问，现有测试也明确不要。
- 是否需要 CSP。不建议：Caddy 没有，`deploy/Caddyfile` 也没配，加了就不等价，且需要按站点资源清单设计，超出本轮范围。

---

## 6. 推荐实施顺序与依赖关系

| 序 | 项 | 依赖 | 为什么这个顺序 |
|---|---|---|---|
| 1 | **2（缓存）** | 无 | 唯一直接影响读者可见正确性的项（撤回内容留存 1 小时）；API 与 web 两侧都要改，先做完再验撤回 |
| 2 | **1（关注页 N+1）** | 无 | 独立模块，`publication/topics.ts` 加一个函数，不影响其它项；测试可并行写 |
| 3 | **3（登录配置）** | 无 | 需要你确认 web 端口是否公网可达；确认前只能做 A+B（代码+文档），C（端口）待定 |
| 4 | **4（金标 fixture）** | 无 | 纯测试，随时可做；放在代码项之后是为让 CI 尽早开始守新代码 |
| 5 | **5（安全头）** | 建议排在最后 | 改的是所有响应的公共出口，回归面最大（web 测试 13 个用例 + smoke），最后做便于独立定位 |

依赖图是**并行的**：五项之间没有代码依赖，只有"测试设施"层面的顺序建议。若只做一项，做第 2 项。

## 7. 一句话总结

五项里只有**缓存**是真正在修读者可见的错误（撤回后报告页仍能看一小时），**关注页**是把已经搬错位置的 N+1 真正消掉，**登录**的判定我推翻了自己上一轮——伪造 XFF 不成立，真问题是 `.env` 默认 `TRUST_PROXY=false` 让所有访客共用一个 IP key，**金标**是把恒 skip 的测试救活，**安全头**是把兜底从页面扩展到全部出口。全部无迁移、无付费调用、无新开关。
