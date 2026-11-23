# autohot 整改执行评估报告

> **状态戳（2026-11-23）**：§4.2 的五个"真问题"（P0-08/P1-09/P0-06/P1-06/P1-13）已随质量补丁全部修复并验证（提交 `ef05d69`/`4876752`/`f5c8dab`/`bd5cd0c`/`8d9342f`），§9.1 第一梯队 1–5 项已完成。本文其余结论仍以 `15726ea` 基线为准，读时注意时点。
>
> 评估基线：`7960c57`（方案阶段）→ `15726ea`（代码现状）
> 评估日期：2026-11-22
> 基准文档：`docs/upgrade-plan.md`（31 项整改规划）
> 评估范围：规划所列 31 项的**落地状态**、**实现质量**、**"不做"决策的合理性**，以及四份方案文档与实际代码的对应关系。
> 方法：以当前代码为准（不采信 commit message）；三名只读审计代理分查 P0/P1/P2，关键判定由我逐处 `sed`/`grep` 复核；凡与上一轮结论冲突处以实测为准，冲突记录在附录 B。
> 本报告**只读评估，不含代码改动**。

---

## 1. 执行摘要

### 1.1 一页结论

31 项里，**没有大面积烂尾**：14 项完全闭环、9 项核心已改但原验收留尾巴、5 项按后续任务书排除、2 项测量后主动砍掉、**1 项真悬空**（P2-03 热榜 N+1）。

但"改完"不等于"改好"。对 14 项闭环项做第二轮质量复核后：🥈 合格但有尾巴 9 项、🥉 有真问题 5 项、**A 级（彻底闭环）0 项**。原规划给 31 项全部标 ✅A/⚠️B 的自评偏乐观。

唯一悬空的 P2-03 是个 0.5 天工作量的问题，却没人做——不是因为它难，是因为它在 P2 且没有守门测试提醒。这暴露出真正的管理缺口：**做完的项目没有质量验收，没做的项目没有到期提醒**。

### 1.2 总览表

| 维度 | 结果 | 说明 |
|---|---|---|
| 完成度 | ✅ 14 · 🟡 9 · ⚪ 5 · 🔵 2 · ❌ 1 | 31 项合计；❌ 是 P2-03 |
| 闭环项质量 | 🥈 9 · 🥉 5 · A 0 | 14 项闭环项的第二轮复核（P0-09 经附录 C 修正计入闭环） |
| "不做"决策 | 6 项全部合理 | 3 项需配低成本后续动作，见 §5 |
| 挂起拍板 | 4 件中仅 1 件有结论 | BLOCK 已定 withdrawn，其余 3 件至今无结论 |
| 方案文档 | 5 份（含规划） | 4 份已出方案，1 份质量补丁待实施；落地率见 §6 |
| 未提交改动 | 2 个文件 | `docs/plans/final-six.md`（2 行）、`quality-patches.md`（新增） |

### 1.3 三句话结论

1. **P0 九项没有一项是真失败**：最重的 P0-04（综述丢早期事实）我一度判 C，实测原验收真过了，只是留了边角；真正需要返工的是 P0-05 的尾巴和 P0-06 的配置陷阱（P0-09 经复核改判闭环，见附录 C）。
2. **"不做"的 7 项（5 排除 + 2 砍）理由都站得住**——数学不成立、需要使用者标注、机制已存在、数据不支持，没有一项是懒得做；但其中 3 项该配低成本后续动作，别当"永久关闭"。
3. **当前最该做的不是继续开新项，而是补质量**：撤回后报告页仍缓存 1 小时（P0-08 尾巴）、关注页把 N+1 从前端搬到了后端（P1-09）、金标测试在 CI 恒跳过（P1-06）——这三项是"改了但没改到位"，比没改更容易误导人。

---

## 2. 评估方法

### 2.1 事实基线

- 读 `docs/upgrade-plan.md` 全文，提取 31 项原始问题、改法、验收口径。
- 逐项读当前代码中的实现、常量、SQL、配置、测试，记录 `文件:行号`。
- 交叉看 `git log --oneline -35` 定位改动提交，但**不采信提交说明**——所有状态判定以代码为准。
- 关键判定（推翻子代理结论的 4 处）由我亲自 `sed` 原文复核，见附录 B。

### 2.2 三轮审计

| 轮次 | 目标 | 手段 | 产出 |
|---|---|---|---|
| 第一轮 | 完成度：改没改 | 3 名 Explore 代理分查 P0(9)/P1(14)/P2+拍板(8+4) | 31 项状态表 + 4 件拍板现状 |
| 第二轮 | 质量：改得好不好 | 3 名 Explore 代理分查内容出口/运维告警/接口部署 | 13 项闭环项质量分级 |
| 第三轮 | 裁决与方案 | 我逐处复核 + 写方案 | `docs/plans/quality-patches.md` |

### 2.3 判定口径

| 状态 | 含义 |
|---|---|
| ✅ 闭环 | 问题本身消失，且原验收口径达成 |
| 🟡 部分 | 核心改动在位，但原计划的部分子项未做 |
| ⚪ 排除 | 后续任务书明确"不在本次范围" |
| 🔵 砍掉 | 测量后数据不支持改造 |
| ❌ 悬空 | 无人做、无方案、无测试提醒 |
| 🥈 / 🥉 | 质量复核：合格有尾巴 / 有真问题（🥇 A 为彻底闭环） |

---

## 3. 31 项逐项评估

### 3.1 P0（9 项：8 闭环 / 1 部分）

| 项 | 状态 | 当前证据 | 缺口 / 质量判定 |
|---|---|---|---|
| P0-01 BLOCK 公开详情 | ✅ | `publish.ts:312` 投影 withdrawn；`detail.ts:88` 404；`publication.test.ts:802` | 🥈 无旁路（RSS/sitemap/search/日报/热榜/brand/following 全走 `publications` + `scope.ts`）；但 withdrawn 只改状态字段不删正文，单点防御；测试未断言响应体不含标题/正文 |
| P0-02 正文队列无消费者 | ✅ | 按**拍板 B 案**：`apps/worker/src/main.ts` 注册条件不动；`alerts.ts:337` 注明阀门关闭+打开即自愈；`deploy.md:199` | 🥈 队列留 created、2h 后进 later 告警（`alerts.ts:329-340` SQL 含 created）正确；文案失真指控已撤回（附录 C #3：created 被保留期删除后 `sweepUnprocessed` 会按 `QUEUED_STALE` 重新入队，"打开采集自动继续"仍成立）；尾巴仅剩无守门测试 |
| P0-03 转发微博丢原帖 | ✅ | `weibo-monitor/backend/timeline.ts:76-82` 保留原帖正文，`:92-98` raw 存 id/时间/作者；`weibo-monitor.standalone.test.ts:79-126` | 🥈 去重按 URL 不受影响；但评分/摘要读拼接正文，原帖观点可能算到转发者头上（未测）；`timeline.ts:94` 仅 string id 入 raw，数值 id 丢失 |
| P0-04 综述丢早期事实 | ✅ | `digest.ts:28-35` 选取集=最近40+每 fact 代表+一手；`:70-89` 哈希基于选取集；`story-digest-eval.test.ts:28-40` 60 篇用例 + `:59-64` 已更正标记 | 🥈 **原验收真过了**（我上一轮误判 C，见附录 B）。边角缺口：同 fact 非代表、非一手、不在最近 40 的被更正报道进不了输入；40 仍是硬上限 |
| P0-05 坏结构静默降级 | 🟡 | 坏输出已抛 `ModelOutputError` 走重试（替代 `.catch(null)` 静默降级） | **缺** `structureDegraded` 标记与后台诊断（原计划第 3、4 点）——**方案评审时明确拆出**（新增功能、非修 bug 最小范围），非遗漏。降级不再静默，但运营仍看不到"哪些稿子降级过" |
| P0-06 登录全局锁死 | ✅ | `admin-auth.ts:29-60` 只数失败、全局键只 `log.warn` 不拦截；`:169` key；`respond.ts:144` 有现成 `clientIp()` 未用 | 🥉 **真问题在配置不在代码**：`compose.yml:100` 与 `.env:120` 默认 `TRUST_PROXY=false` → web 传 Caddy 容器 IP，所有访客共用 `ip:` key，10 次失败锁死管理员。伪造 XFF 在标准部署下**不成立**（`web/server.ts:161-167` 已收敛）。详见 §4.2 |
| P0-07 告警关闭仍标已发送 | ✅ | `feishu.ts:157` 三态；未投递记 `undeliveredAt` 并补发；`agent-wake.test.ts:189` | 🥈 主路径对；hub 路径仅凭 HTTP 200 判 sent 不校验业务码；非 private 告警的 id 含 `Date.now()`，部分失败重试会重复；`sendDigest` 忽略返回值，关闭期日报无补发记录 |
| P0-08 缓存 600s vs 60s | ✅ | `site.ts:93/102` 下发 `@now+60`；`item.tsx:43` `cachedPage(60)` | 🥉 **只修了详情页**：报告类 API 路由（`site.ts:173-212`）没下发 `X-Accel-Expires`，web 侧 `cachedPage` 拿不到 upstream deadline；`report-detail.tsx:33` 仍 3600、`report-latest`/`daily-archive` 600、`story` 300 → 撤回内容留存最长 1 小时。详见 §4.2 |
| P0-09 热度 incomplete 残留 | ✅ | 补算跳过已合并 + 30 天保留 + 并发索引 | 🥈 复审改判闭环（附录 C #1）：`heatSeries` 的 `complete` 过滤本就存在（正是否决原诊断的依据），删除由 30 天保留承担；`hot.test.ts:153` 是修正版方案 §2.3 要求的既定行为断言，不是固化缺陷 |

### 3.2 P1（14 项：5 闭环 / 4 部分 / 5 排除）

| 项 | 状态 | 当前证据 | 缺口 / 判定 |
|---|---|---|---|
| P1-01 二次评分短路 | ⚪ | `SCORE_CALLS=2` 原样 | 后续任务书排除。数学上不等价于省一次调用（规则 `s1+s2≥2T`，任一次偏低即落选），搁置正确 |
| P1-02 成本闭环 | 🟡 | 录价入口 + 未计价进 09:00 摘要已做 | 历史回填、价格种子、金额熔断未做——**对抗校验明确否决的子项**（价格由后台录入、熔断按次数、`cost` 列语义是 actual，回填破坏"未计价"口径），非遗漏；`llm.ts:227` 仍 `cost:null` 属预期 |
| P1-03 understandFloor | ⚪ | `understandFloor:30` 原样 | 排除。需标注样本校准，且门槛顺序断言会把随手改数字测红 |
| P1-04 综述重写节流 | 🟡 | `digest.ts:83` inputs_hash 跳过无变化重写 | 新增一篇仍照写；无"≥K 篇/距上次≥T"节流 |
| P1-05 T1 门槛 54 | ⚪ | `T1:54` 原样 | 排除。同 P1-03，需样本校准 |
| P1-06 标注护栏 | ✅ | `analyze.test.ts:308-326` 门槛顺序 + `scoresSelect` 边界 + class 断言**真实有效** | 🥉 `:327-334` 金标断言在 `.data/gold.jsonl` 缺失时 `t.skip`，而该目录被 `.gitignore:8` 忽略 → **CI 恒跳过**；`check.yml:80-81` 只跑 `npm test` |
| P1-07 同集团多源 | ⚪ | `signal_group_id` 字段在 `0001_core.sql:20`、参与者键在 `hot.ts:120`/`group.ts:84`、后台编辑在 `admin/source.tsx:213` | 排除。机制齐备，剩下是运营补录；但补录清单目前**没人跟** |
| P1-08 displayTag | ⚪ | `taxonomy.ts:86` 注释写明 null 是设计；`topics.ts:103` 有兜底（唯一实体标签自动归品牌页） | 排除合理，不是标题硬匹配 |
| P1-09 关注页聚合 | ✅ | `/api/site/following/feed`；前端 `following.tsx:149` 单请求 | 🥉 **N+1 从前端搬到后端并放大**：`following/server.ts:23-24` 30 slug×10 页×4 SQL≈1200 条一次性并发，pg pool 默认 10 → 排队。详见 §4.2 |
| P1-10 周月报补写 | ✅ | `compose.ts:42/358/365` 限次重写；`alerts.ts:629+` 缺刊扩到周月报；`report-recovery.test.ts:68-105` | 🥈 重试账本在模型调用之外读，两进程并发可超支；reason 统一 `"missing overview"` 不区分降级原因；`periodScan` 只扫最近 4 周/3 期 |
| P1-11 备份可验证 | 🟡 | `.part` 改名 + HEAD 比 Content-Length + 未配置即报错 | **无** sha256 比对、无每月 `pg_restore` 演练 |
| P1-12 部署可观测 | ✅ | 三服务 healthcheck/内存/日志上限；web 另有 `stop_grace_period:20s` | 🥈 worker 无 healthcheck（仅 settings 心跳）；web healthcheck 把 3xx 算健康（与 api 口径不一）；SSR 熔断打开时 `/` 返回 503 会误判 web 不健康；db/caddy 无日志上限 |
| P1-13 安全头兜底 | ✅ | `web/server.ts:110-116` 四个头 | 🥉 只写在 `pageResponse` 的 `writeHead` 闭包内 → 静态资源（`:68-73` 仅 nosniff）、重定向（`:153-159`）、500/400（`:80-86`）三条路径无兜底。HSTS 差异是正确的，不算缺口。详见 §4.2 |
| P1-14 门槛文档同步 | 🟡 | `docs/selection.md` 数字仍 60/65/76，但 `:25` 加注"框架示例值，本站以 selection.ts 为准" | 按上游规则的处理方式，不是漏改 |

### 3.3 P2（8 项：1 闭环 / 4 部分 / 2 砍 / 1 悬空）

| 项 | 状态 | 当前证据 | 缺口 / 判定 |
|---|---|---|---|
| P2-01 归组性能 | 🔵 | `docs/perf/grouping-2026-11-22.md`：P95 4.3–9.0s（<10s 线）、无积压、池 100–750 行/天、模型段主导 | 测量后不改造，合理。运行时代码无粗召回/并发；复核触发阈值（P95>10s）已写在结论里 |
| P2-02 日报引用表 | 🔵 | 仅 3 期 / 27 KB，`firstDaily` 仍扫 JSONB；无 0176 迁移 | 测量后砍掉，远低于"期数<200 就不做"决策线。复核阈值已写 |
| P2-03 热榜 N+1 | ❌ | `hot.ts:190-224` 仍是 `for (const r of rows)` 内两条 SQL（代表报道 + participants），最多 10 轮 | **唯一真悬空**。无代码、无方案、无守门测试。0.5d 工作量 |
| P2-04 迁移加固 | 🟡 | advisory lock + `schema_migrations` + CI `HEAD~1` 基线已做 | 账本表**无 sha256 列**（只记文件名，不验内容变更） |
| P2-05 退出兜底 + 熔断 | ✅ | `server.ts:189-204` 8s 截止 + `closeAllConnections`；`api.server.ts:25-76` 3 次/5s 熔断；`cache.test.ts:330+` | 🥈 分类正确（只算 transport failure，ApiError 清零 5xx 不误熔断）；但状态是模块级全局共享，不同用户各 1 次失败即可短路所有人 5s；固定窗口无半开探测；测试用真实 `delay(5000)` 易 flaky |
| P2-06 版本/Dependabot | 🟡 | Node 24.22.1 三处统一、Dependabot 已建 | `check.yml:48` 仍 `--no-audit`（方案里明确不加门禁） |
| P2-07 OpenAPI | 🟡 | 路由与 spec 双向比对测试已做 | 生成式 OpenAPI + 响应 schema 校验未做 |
| P2-08 测试门禁 | 🟡 | 跨午夜双断言；`architecture.test.ts:113` `localConcurrency:1` 串行守卫 | 双进程并发按拍板不写（写了必红，且跨文章并发不安全是设计前提） |

---

## 4. 质量复核：14 项闭环项到底做得多好

### 4.1 分级总览

| 分级 | 项数 | 项目 |
|---|---|---|
| 🥇 A 彻底闭环 | **0** | — |
| 🥈 合格有尾巴 | 9 | P0-01、P0-02、P0-03、P0-04、P0-07、P0-09、P1-10、P1-12、P2-05 |
| 🥉 有真问题 | 5 | **P0-06、P0-08、P1-06、P1-09、P1-13** |

没有一项拿到 A，原因高度一致：**主路径做对了，但并发/失败态/边界/配置这类"第二层"没覆盖，测试也只守主路径**。

### 4.2 五个真问题的详细判定

**P0-08 缓存只改了详情页 — 唯一影响读者可见正确性的**
- 根因不是数字写大，而是上游没给截止时间：报告类 API 路由（`site.ts:173-212`）只经 `sendJsonWithEtag`（`respond.ts:89-95`，只写 ETag/Cache-Control/Vary），没有 `X-Accel-Expires`。
- web 侧 `api.server.ts:116-118` 取不到 `sourceDeadline`，`:115` 退化成 `deadline = second + seconds`，完全用页面自己的数字（3600/600/300）。
- **降 TTL 是真有用的**：我验证了报告撤回是读取时动态过滤——`reports.ts:334-341` `issueAvailability` 每次重查所有 itemId 的 `listedCondition(now)`，`:203` `stillPublic` 滤掉已撤回项。缓存过期后下一次读取就反映撤回，不需要重写报告。
- 修复方案见 `docs/plans/quality-patches.md` §2。

**P1-09 关注页 N+1 搬到后端并放大**
- `following/server.ts:23-24` 两层 `Promise.all`，`topics.ts:350-358` 每次 4 条 SQL；30×10=300 次调用、约 1200 条查询一次性并发。
- 上限 `MAX_SLUGS=30/MAX_PAGES=10` 存在，但 30×10 是**合法输入**，没有总调用预算。
- `tests/topics.test.ts:233-248` 的"30 topics"用例正好走最坏路径，却只断言 `served===30`，不测查询数/耗时。
- 修复方案见 `quality-patches.md` §1（新增 `loadFollowingItems` 一次查询）。

**P0-06 真问题是默认值，不是 XFF 伪造**
- 我上一轮判"伪造 XFF 绕过 IP 限流"是**错的**：`web/server.ts:161-167` 取 `x-forwarded-for` 的**最后一个**——Caddy 的 `$proxy_add_x_forwarded_for` 把真实访客追加在末尾，攻击者伪造值在前面被丢弃；web 覆盖成单值再转 api；compose 里 api 无 ports。
- 真缺口：`docker-compose.yml:100` `TRUST_PROXY: ${TRUST_PROXY:-false}`，`.env:120`/`.env.example:119` 都是 `false`，而 `docs/deploy.md:48/57` 写 `true`。`false` 时 web 传 `req.socket.remoteAddress` = Caddy 容器 IP，**所有访客共用一个 `ip:` key**，10 次失败就锁死管理员——比原规划修掉的"全局 50 次锁死"更容易触发。
- 现成的 `clientIp()`（`respond.ts:144`）没被 admin-auth 使用。
- 修复方案见 `quality-patches.md` §3。**需拍板**：生产 web:3000 是否公网可达（compose `:104-105` 有 ports 映射）。

**P1-06 金标护栏在 CI 恒跳过**
- `analyze.test.ts:327-334`：文件不存在就 `t.skip`；`.gitignore:8` 是 `.data/`，CI checkout 必然没有 → 永远跳过。
- 同文件 `:308-326` 的门槛顺序、`scoresSelect` 边界、class 断言是**真实有效**的（NaN 比较会抛错，不是静默通过），问题只在金标那一条。
- 修复方案见 `quality-patches.md` §4（3 条 smoke fixture + 删 skip 分支）。

**P1-13 安全头只覆盖页面响应**
- 四个头写在 `pageResponse` 包装 `res.writeHead` 的闭包里（`:106-144`），只有走 `ssr()` 的页面生效。
- 绕过三条：`serveStatic`（`:68-73` 只带 nosniff）、`resolveRedirect`（`:153-159` 直接 `res.end`）、错误兜底（`:80-86`）。
- HSTS 差异是**正确的**：`Caddyfile:5` 用 `header ?` 仅 HTTPS 发，`request-target.test.ts:68` 明确断言 HTTP 直连没有。
- 修复方案见 `quality-patches.md` §5（挪到 `createServer` 顶层）。

### 4.3 九项「合格有尾巴」的共性

不是做错，是**只覆盖主路径**：

| 共性 | 例子 |
|---|---|
| 并发/多进程没测 | P1-10 账本在模型调用外读，两进程可超支；P1-11 无恢复演练 |
| 失败态没测 | P0-07 hub 返回 200 但业务失败仍标 sent；部分发送重试会重复 |
| 配置与文档漂移 | P1-12 web healthcheck 把 3xx 算健康（与 api 口径不一） |
| 单点防御 | P0-01 withdrawn 只改状态字段不删正文，靠各出口的 visibility 过滤 |

---

## 5. "不做"决策的合理性裁决

后续任务书排除了 5 项，测量后砍掉 2 项，共 7 项。逐项裁决：**没有一项是"不该不做"的误判**，理由都不是懒得做。

| 项 | 理由 | 我的核验 | 裁决 |
|---|---|---|---|
| P1-01 二次评分短路 | 数学上不等价于省一次调用 | 规则 `s1+s2≥2T`，T=58 需 ≥116；`s1=73` 配 `s2=0` 仍落选。任何 `\|s1−T\|≥15` 的快判都有反例 | ✅ 合理，搁置正确 |
| P1-03 understandFloor | 必须标注样本校准 | AGENTS.md 明令；新加的门槛顺序断言会把随手改数字测红 | ✅ 合理，但见① |
| P1-05 T1 门槛 | 同上 | 同上 | ✅ 合理，但见① |
| P1-07 同集团多源 | 机制已有，剩运营补字段 | 字段/参与者键/后台编辑框都在 | ✅ 合理，但见② |
| P1-08 displayTag | null 是设计 | `taxonomy.ts:86` 注释写明；`topics.ts:103` 有唯一实体标签兜底 | ✅ 合理 |
| P2-01 归组性能 | 测量后不改造 | P95 4.3–9.0s < 10s 线、无积压、模型段主导 | ✅ 合理，但见③ |
| P2-02 日报引用表 | 只有 3 期/27 KB | 远低于"期数<200"决策线 | ✅ 合理，但见③ |

**三个"合理但别彻底不管"的低成本后续动作：**

- ① **P1-03/P1-05 该做测量，不该连测量也搁置**。现在没有任何数字能说明"30–58 分段里有多少篇写了 understand 却最终没入选"、"T1 被 54 卡掉的有多少"。两条只读 SQL 就能出结论，不违反"不凭感觉定数"，反而能决定值不值得让使用者花时间标注。
- ② **P1-07 的运营补录目前没人跟**。`signal_group_id` 空着 = 同集团多源仍在重复计热度。建议留一次性补录清单（哪些源同集团、填什么 group id），而不是等项目复活。
- ③ **P2-01/P2-02 是 2026-11-22 的快照，不是永久结论**。复核触发条件已写在 `docs/perf/` 那篇：归组 P95 越过 10s（尤其再出现停摆）就减候选数；日报期数过 200 就重估引用表。建议把这两个阈值也写进结论正文，别只留在测量记录里。

---

## 6. 方案文档与落地情况

### 6.1 五份文档

| 文档 | 内容 | 落地情况 |
|---|---|---|
| `docs/upgrade-plan.md` | 原始规划，31 项 + 附录 A SQL + 附录 B 被推翻的旧结论 | 基准文档，已执行大部分 |
| `docs/plans/five-remediations.md` | 5 项整改方案（经第三方复核修订 3 必改 + 2 瑕疵，含修订记录） | 大部分落地 |
| `docs/plans/six-fixes.md` | 6 项小改动方案（周月报补写/缓存架构测试/版本统一/备份收尾/关注页聚合/综述标记） | 大部分落地 |
| `docs/plans/final-six.md` | 最后 6 项（P0-02 两案并列、P1-06、P2-01 只测量、P2-02、P2-05、P2-08） | 测量结论已落地；护栏/测试部分落地；**工作区有 2 行未提交**（purpose 清单 5→7） |
| `docs/plans/quality-patches.md` | 本次质量补丁 5 项 | **纯方案，未实施** |

### 6.2 落地与纸面的分界

**已落地（代码可验证）**：BLOCK withdrawn、登录只数失败、告警 undeliveredAt、详情页 60s、综述选取集、结构坏输出重试、正文队列 B 案文案、转发微博原帖、关注页聚合接口、周月报补写、三服务 healthcheck、安全头兜底、门槛顺序断言、退出兜底+熔断、跨午夜测试、迁移 advisory lock、Node 版本统一、OpenAPI 双向比对、归组测量、日报引用测量。

**纸面或半落地**：
- P0-05 的 `structureDegraded` 诊断（方案评审时明确拆出、未另行立项）
- P2-04 的 sha256 账本（advisory lock 做了，哈希列复核后判定收益接近 0、主动不做）
- P1-11 的每月恢复演练（方案写了，没做）
- `final-six.md` 里的 P1-06 分层报告、`--baseline` 参数（部分做了，见 P1-06 金标恒 skip）
- `quality-patches.md` 全部 5 项（刚写完，一项未动）

---

## 7. 4 件挂起拍板事的现状

| # | 拍板事 | 现状 |
|---|---|---|
| 1 | BLOCK 内容处置 | ✅ **有结论并落地**：withdrawn（404），管理员 override 可读，测试在 `publication.test.ts:802` |
| 2 | 全文翻译做不做 | ❌ **至今无结论**。需求文档写了但 `site_fulltext=false`、`translations` 0 行 |
| 3 | 推送留不留 | ❌ **至今无结论**。`selected-content.ts:13` 仍是 `PUSH_TIERS = ["T1", "T1_5"]`，而 T1 近零入选 → 推送在空转 |
| 4 | "每天 50 条"指报道还是事件 | ❌ **至今无结论**。口径不同结论相反，直接影响 P1-05 门槛校准目标 |

这三件未决事项是 P1-03/P1-05 无法开工的根因——不是代码问题，是**需要使用者本人输入**（AGENTS.md 也明令不要替他决定）。

---

## 8. 待拍板清单（汇总）

### 8.1 质量补丁五项（新）

来自 `quality-patches.md`：

| 项 | 待拍板 | 我的建议 |
|---|---|---|
| 缓存 | 报告页 TTL 是否统一降到 60s；`hot.tsx` 的 120s 是否顺带改 | 建议 60s，hot 顺带改；其余长缓存页本轮不动 |
| 关注页 | 成员关系滞后 60s 是否可接受；是否把 `MAX_PAGES` 从 10 降到 3 | 建议接受滞后，不动 MAX_PAGES（产品口径） |
| 登录 | **生产 web:3000 是否公网可达** | 建议只改文档+默认值，暂不动端口映射；需你确认 |
| 金标 | CI 是否跑真实 `eval-selection.ts`（需模型 key、付费） | 不建议本轮做，只救活格式护栏 |
| 安全头 | 是否连 HSTS/CSP 一起兜底 | 都不建议（HSTS 需 HTTPS 判断；CSP 两边都没有，加了不等价） |

### 8.2 最后六项方案（旧）

来自 `final-six.md`，部分已拍板：

| 项 | 待拍板 | 状态 |
|---|---|---|
| P0-02 | A 案（deferred）还是 B 案（留 created） | ✅ **已拍板 B**，已落地 |
| P1-06 | 分层维度用 `samplingStratum` 还是信源分级；`browseFloor < understandFloor` 断言留不留 | 未拍板，部分落地 |
| P2-01 | P95 阈值 10s、回放样本 100 篇 | 测量已完成，阈值已确认 |
| P2-02 | 是否先测后砍 | ✅ 已测后砍 |
| P2-05 | 8s/5s 参数、是否连带改 compose | 已按 8s/5s 落地 |
| P2-08 | 是否要真起第二进程做双进程集成测试 | 未拍板，按拍板不写（写了必红） |

### 8.3 最初四件

见 §7：BLOCK 已定；全文翻译、推送留不留、50 条口径三件未定。

---

## 9. 建议路线图

### 9.1 优先级

**第一梯队 — 补质量（本轮方案直接可做）**

1. **P0-08 缓存**（`quality-patches.md` §2）：唯一影响读者可见正确性；API 与 web 两侧都要改，改完验撤回。
2. **P1-09 关注页**（§1）：独立模块，加一个 `loadFollowingItems` 一次查询；可与缓存并行。
3. **P1-06 金标**（§4）：纯测试，3 条 fixture + 删 skip；让 CI 尽早开始守新代码。
4. **P1-13 安全头**（§5）：改公共出口，回归面最大，放最后便于独立定位。
5. **P0-06 登录**（§3）：需先拍板 web 端口是否公网可达；确认前只能做代码+文档部分。

**第二梯队 — 清尾巴**

6. P2-03 热榜 N+1（唯一悬空，0.5d，`WHERE story_id = ANY` 批量化）
7. P0-05 `structureDegraded` 诊断标记
8. P2-04 sha256 账本列
9. P1-11 每月 pg_restore 演练

**第三梯队 — 低成本测量（不需要改代码）**

10. P1-03/P1-05 的两条只读 SQL（沉没成本、T1 卡掉量）
11. P1-07 同集团源补录清单
12. P2-01/P2-02 复核阈值回填 `docs/perf/`

### 9.2 依赖关系

五项质量补丁之间**没有代码依赖**，只有顺序建议。第一梯队里若只做一项，做缓存。

第二梯队里 P2-03 单独动 `hot.ts`；P0-05 动 `group.ts`，与 P2-01 的复核触发条件相关但当前不冲突。

第三梯队不阻塞任何代码改动，随时可做。

### 9.3 流程建议（比具体补丁更重要）

这次评估暴露的真问题不是哪一项没做完，而是：

- **做完的项没有质量验收**：14 项闭环里 5 项有真问题，且都是"测试只守主路径"导致的。建议以后每项整改的验收标准加一条"失败态/并发/配置漂移有没有测试"。
- **没做的项没有到期提醒**：P2-03 挂了整个规划周期无人问津。建议把"排除项"和"悬空项"分开记账，排除项写理由和复核条件，悬空项进待办。
- **拍板事项没有倒计时**：4 件里 3 件从最初规划拖到现在，直接卡住 P1-03/P1-05。建议给未决拍板设一个"下次评审时若仍无结论则按推荐方案执行或正式关闭"的规则。

---

## 附录 A：关键证据索引

| 主题 | 文件:行号 |
|---|---|
| 规划基准 31 项 | `docs/upgrade-plan.md:36-70` |
| 4 件拍板 | `docs/upgrade-plan.md:574-584` |
| BLOCK 投影 | `packages/backend/src/publication/publish.ts:312`；`detail.ts:88`；`tests/publication.test.ts:802` |
| 正文队列 B 案 | `packages/backend/src/operations/alerts.ts:329-340`；`docs/deploy.md:199` |
| 转发微博原帖 | `modules/weibo-monitor/backend/timeline.ts:76-98` |
| 综述选取集 | `packages/backend/src/events/digest.ts:28-35, 69-89`；`tests/story-digest-eval.test.ts:28-40,59-64` |
| 登录限流 | `apps/api/src/routes/admin-auth.ts:29-60,169-180`；`apps/api/src/http/respond.ts:143-145`；`apps/web/server.ts:161-167` |
| 告警三态 | `packages/backend/src/notify/feishu.ts:157-207`；`tests/agent-wake.test.ts:189-241` |
| 缓存头下发 | `apps/api/src/routes/site.ts:75,93,102,160,173-212`；`apps/web/app/lib/api.server.ts:112-125`；`apps/web/app/routes/{item,report-detail,report-latest,daily-archive,story}.tsx` |
| 撤回动态过滤 | `packages/backend/src/publication/reports.ts:203,334-341` |
| 关注页聚合 | `modules/following/server.ts:8-24`；`packages/backend/src/publication/topics.ts:333-368`；`tests/topics.test.ts:196-257` |
| 金标护栏 | `tests/analyze.test.ts:308-334`；`.gitignore:8`；`.github/workflows/check.yml:80-81` |
| 周月报补写 | `packages/backend/src/reports/compose.ts:40-42,358-376`；`tests/report-recovery.test.ts:68-105` |
| 安全头 | `apps/web/server.ts:68-73,80-86,106-144,153-159`；`deploy/Caddyfile:5-9`；`apps/web/tests/request-target.test.ts:60-69` |
| 退出兜底/熔断 | `apps/web/server.ts:189-204`；`apps/web/app/lib/api.server.ts:25-76`；`apps/web/tests/cache.test.ts:330-396` |
| 热榜 N+1 | `packages/backend/src/events/hot.ts:190-224` |
| 测量结论 | `docs/perf/grouping-2026-11-22.md` |
| 质量补丁方案 | `docs/plans/quality-patches.md` |

## 附录 B：本轮自我纠错记录

审计过程中我推翻了自己或子代理的 6 处判定，全部以实测代码为准：

| # | 原判定 | 纠正 | 依据 |
|---|---|---|---|
| 1 | P0-04 早期事实仍丢（C） | 原验收真过，改判 🥈，不进补丁方案 | `story-digest-eval.test.ts:28-40` 第 5 篇是 `i===4` 的 fact 代表，会被选取集捞回；`:59-64` 另有已更正标记断言 |
| 2 | P0-06 伪造 XFF 可绕 IP 限流 | 标准部署不成立；真问题是 `TRUST_PROXY` 默认值 | `web/server.ts:161-167` 取 XFF 最后一项（Caddy append 的真实 IP 在末尾），api 无 ports |
| 3 | P1-13 HSTS 差异是缺陷 | 是正确行为，只补 4 个头 | `Caddyfile:5` `header ?` 仅 HTTPS；`request-target.test.ts:68` 明确断言 HTTP 无 HSTS |
| 4 | P0-02 的 B 案需新增"积压告警" | 已有 `waitingQueues` 覆盖，只需改文案 | `alerts.ts:329-335`，`later` 级别 2 小时 |
| 5 | P0-08 是"数字写大了" | 根因是 API 没下发 `X-Accel-Expires` | `site.ts:173-212` 只走 `sendJsonWithEtag`；`api.server.ts:116-118` 取不到 deadline |
| 6 | P1-06 金标测试"可能静默通过" | 顺序断言用 `assert.ok(a<b)`，NaN 会抛错；真问题是恒 skip | `analyze.test.ts:308-326` 有效；`:327-334` 的 `.data/` 被 gitignore |

另外修正了 `final-six.md` 的付费 purpose 清单：原写 5 个，实测 7 个——`consolidate.ts:59` 动态拼出的 `group_story`/`group_story_review` 被字面搜索漏掉（该改动仍在工作区未提交）。

## 附录 C：第三方复审核对后的修正（2026-11-22）

本报告经第二轮独立核对（逐条对代码验证报告指控），修正 4 处：

| # | 原文 | 修正 | 依据 |
|---|---|---|---|
| 1 | P0-09 判 🟡，指控 `hot.test.ts:153` "把残留当预期写进断言"、未做 `heatSeries` 过滤 | 改判 ✅ 闭环：`heatSeries` 查询本就带 `AND complete` 过滤（这正是对抗校验否决 P0-09 原始诊断的依据）；行删除由 30 天保留承担；该测试断言是修正版方案（five-remediations §2.3 用例 1）明确要求的既定行为 | `hot.ts` heatSeries 查询；`docs/plans/five-remediations.md` §2.3 |
| 2 | P0-05、P1-02、P2-04 的未做子项未标注来由 | 标注"方案评审时明确拆出 / 对抗校验明确否决 / 复核后主动不做"，非遗漏 | 本轮整改的对抗校验记录 |
| 3 | P0-02 "文案在关闭 >14 天时失真" | 撤回：created 任务被 pg-boss 保留期删除后，`sweepUnprocessed`（`jobs/content.ts:249-259`，`QUEUED_STALE` 30 分钟）会重新入队，"打开采集自动继续"仍成立 | `jobs/content.ts` sweep 逻辑 |
| 4 | P0-07 "hub 仅凭 HTTP 200 判 sent / 非 private 告警 id 含 Date.now()" | 降为"待核"（未逐行核实，属低风险尾巴，不改变 🥈 定级） | — |

---

*报告完。所有状态判定基于基线 `15726ea` 的当前代码；`quality-patches.md` 的五项为待实施建议，尚未改动代码。*
