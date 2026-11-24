# 读者账号与登录墙

阶段 1 提供 API、数据库和留存任务。阶段 2 增加站长后台的申请审批、读者名单和邀请码页面，以及读者端的入座、申请、注册、登录和账户页面。

## 准入流程

1. 站长可单独发码或按批次发码，也可批准邮箱已验证的申请。批准申请后系统发出绑定该邮箱的码，并在当次后台响应中给出 `invitation_url` 和 `invitation_text`。邮件失败时仍会返回明文邀请码，`email_sent=false`，站长可复制文案转发。批量审批逐条返回结果，失败项记录各自的 `error`，成功项仍返回各自的邀请码。
2. 注册需要邀请码和一次性邮箱验证凭据 `ticket`。同时提交姓名 `name`、公司 `company`、职位 `job_title`、微信号 `wechat`、当前条款和隐私版本以及两项同意。名片照片 `business_card_url` 和介绍人 `referrer` 可空。`tracking_consent` 独立，省略时为 `false`。
3. 站长发出的码让读者在注册后直接激活。读者发出的子码先创建 `pending` 账号，站长批准后生效。待审读者可进入自己的账号设置，内容接口只认可 `active`。邮箱是当前启用的登录方式，登录标识独立保存在 `reader_auth_identities`。
4. 子码功能开启时，激活会生成额度内的码。自动激活当次响应返回码。待审转激活时后台审批响应返回码，并尝试发给已验证的读者邮箱。之后只能查到码的状态，可用 `replace_id` 换发未使用的码。换发会撤销旧码，已核销的额度不能换发。

## 配置与发布

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `READER_WALL_ENABLED` | `false` | 只有 `true` 开启 API 和 Web 登录墙 |
| `SESSION_SECRET` | 必填于开墙时 | 邀请码、验证码和限频键的 HMAC 密钥 |
| `READER_INTERNAL_TOKEN` | 必填于开墙时 | 至少 32 个字符，用 `openssl rand -base64 32` 生成。仅供服务端通过 `x-reader-internal` 访问 API |
| `READER_INVITE_TTL_HOURS` | 72 | 站长码、申请码和子码的有效小时数 |
| `READER_CHILD_INVITES_ENABLED` / `READER_CHILD_INVITE_QUOTA` | `false` / 2 | 子码开关与激活发放数量 |
| `READER_IDLE_HOURS` / `READER_SESSION_DAYS` / `READER_MAX_SESSIONS` | 72 / 30 / 3 | 空闲小时数、绝对有效天数和同时保留的会话数 |
| `READER_MAIL_ENABLED` | `false` | 只有 `true` 才调用邮件驱动。默认驱动目前会返回未配置，生产邮箱验证需接入服务商 |
| `READER_INACTIVE_DAYS` | 30 | 不活跃阈值为天数×24 小时。达到阈值后的首个北京时间 11:00 发第一次提醒 |
| `READER_INACTIVE_GRACE_DAYS` | 3 | 首次提醒后的第几天 09:00 发第二次提醒、11:00 检查删除 |
| `READER_ADMIN_EMAIL` | 空 | 选填。读者邮件启用时，接收每周一的待删除汇总 |
| `READER_TERMS_VERSION` / `READER_PRIVACY_VERSION` | `1` / `1` | 前端提交的当前条款、隐私说明版本。修改文案时同步更新 |

验证码 6 位、10 分钟有效、连续 5 次错误作废。同一邮箱 60 秒发一次、每小时至多 5 次，每个 IP 每小时至多 20 次。申请每 IP 每小时至多 5 次，同邮箱同时只能有一条待审。验证码验证后的凭据有效 10 分钟，只能兑换一次。非生产环境关闭邮件开关时，验证码仅写服务端日志，凭据仍须走验证接口取得。

API 登录墙默认拦截全部内容路由，包括 RSS、MCP、Agent、Markdown、媒体代理、`llms.txt` 和站点地图。活动读者会话和内部令牌可通过 API 门禁。站点通过 `@aihot/site` 的 `ADMIN` 启用后台时，真实管理员会话也可通行。开墙后，内容门禁和读者管理接口均拒绝 `DEV_AUTH_ROLE=admin` 提供的开发管理员身份。`x-aihot-ssr` 只是现有 SSR 标记。例外路径集中在 [gate-policy.ts](../modules/reader-accounts/backend/gate-policy.ts)，包括健康检查、账号、管理员及其登录入口、使用独立令牌的 ingest、静态文件和精简 OG 图。日报、周报、月报的分享图仅显示报告名与日期，主题和事件分享图仅显示标题，条目分享图可显示标题与摘要，静态页面分享图可显示栏目说明。含评分或其他详情的文章海报受墙保护。读者 API 与受墙保护的响应均禁止共享缓存，写请求需提供与 Host 和协议匹配的 `Origin`。

开墙后 `robots.txt` 禁止全部抓取且不再声明站点地图，匿名访问站点地图返回 401。条目和事件的分享页对匿名读者提供精简预览，并使用 `X-Robots-Tag: noindex, nofollow`。其余内容页要求登录，待确认读者可打开 `/account` 和 `/account/pending`。Web 页面响应使用 `Cache-Control: private, no-store` 和 `X-Accel-Expires: 0`。生产切换时清除已有的 HTML、API 和 OG 缓存，并保持搜索主动推送开关关闭。

开登录墙前须关闭 `DEV_AUTH_ROLE`。非生产部署若仍启用开发管理员，服务会拒绝启动。

API 端口不得对公网开放，外部流量必须经生产 Web 服务或可信反向代理访问。入口根据连接地址覆盖客户端传入的访客地址头，由 Web 或反代向 API 转发可信的 `X-Real-IP` 和 `X-Forwarded-For`，并原样转发公网 `Host` 与 `X-Forwarded-Proto`。有可信反代时可为 Web 设置 `TRUST_PROXY=true`，并限制 Web 端口只接受反代流量。Web 直接接收访客连接时设为 `false`。

SSR 在服务端携带内部令牌直连 API。使用 Docker Compose 时，Web 会收到与 API 相同的登录墙开关和内部令牌。单独启动两个进程时给两者配置相同的值。Web 代理浏览器请求时会丢弃 `x-reader-internal`。如果反代直接转发到 API，也应丢弃外部请求中的该头。

## 接口

所有读者 API 响应使用 `Cache-Control: private, no-store`。浏览器写操作带同源 `Origin`。读者管理接口只在站点启用后台时接受管理员会话，后台写操作还需 `x-csrf-token`。表中的路径以所在分组的前缀为基准，`/` 表示前缀本身。

| 分组 | 方法与相对路径 | 用途 |
| --- | --- | --- |
| `/api/reader` 公开 | `POST /otp/send`、`POST /otp/verify` | 发验证码、验证并返回 `ticket` 和 `expiresAt` |
| 公开 | `POST /register`、`POST /login`、`POST /logout` | 注册并建立会话、用邮箱加验证码或 ticket 登录、退出当前会话 |
| 公开 | `GET /session` | 当前登录态、状态、昵称、资料是否完整和同意版本。浏览器轮询不续期。携带内部令牌和 `x-reader-page-view: 1` 的 Web 页面检查按现有规则续期 |
| 公开 | `POST /applications` | 用邮箱 ticket、资料及 `reason` 提交申请 |
| 公开 | `GET /invite/check?code=…`、`GET /preview/:id`、`GET /preview/story/:id` | 检查邀请码是否有效及是否绑定邮箱。读取条目或事件的分享预览 |
| Web 服务端 | `GET /landing-samples` | 开墙时用内部令牌读取最近两条精选的简要信息 |
| `/api/reader` 已登录 | `GET /me`、`PATCH /me`、`DELETE /me` | 查看或修改个人资料及追踪同意、注销账号 |
| 已登录 | `POST /events` | 批量上报 `{ events: [...] }`，单批最多 50 条、32 KiB。允许 `view_item`、`view_story`、`view_topic`、`view_report`、`search`、`follow_change`、`report_open`、`dwell` |
| 已登录 | `GET /me/events`、`GET /me/export`、`DELETE /me/events` | 查看、导出、清空本人记录。导出最近最多 5000 条事件和 200 条同意记录，省略更早记录时分别以 `truncated` 和 `consents_truncated` 标明 |
| 已登录 | `GET /me/invites`、`POST /me/invites` | 查看子码、在额度内生成或换发子码 |
| `/api/admin/reader-lookups` | `GET /` | 按逗号分隔的 `reader_ids` 补齐名单和邀请码中的读者姓名与微信号，按 `application_ids` 返回仍可重签的申请 ID。两项分别最多 100 和 50 个 ID。后台从 `GET /api/admin/me` 读取 CSRF |
| `/api/admin/readers` | `GET /`、`GET /:id` | 名单、个人资料、兴趣画像、近期动作与邀请上下游 |
| 同上 | `POST /:id/approve`、`POST /:id/disable`、`POST /:id/restore` | 批准待审、停用、恢复 |
| `/api/admin/reader-invites` | `GET /`、`POST /`、`POST /batch`、`POST /:id/revoke` | 邀请码与批次、直发、批发、撤销。批发要求 `count` 和 `batch_tag` |
| `/api/admin/reader-applications` | `GET /`、`GET /:id` | 申请列表和详情，详情附同公司已有读者 |
| 同上 | `POST /:id/approve`、`POST /:id/reject`、`POST /batch-approve` | 通过、可选 `reason` 和 `notify` 的拒绝、按 `ids` 批量审批 |
| 同上 | `POST /:id/reissue` | 为已通过且邀请码未使用的申请重签，旧码作废。响应与通过申请一致，邮件发送失败时仍返回新码。申请状态不符、旧码已使用或正在重签时返回 409 |

列表用 `offset` 分页，每页最多 50 条。条目兴趣由主动上报的 `target_id`、`brand_slug` 和 `topic_slug` 统计，不自动记录 API 访问路径。搜索可传 `query`。停留仅收 `dwell_bucket`，分档为 `under_10s`、`10_29s`、`30_59s`、`60_179s`、`180s_plus`。

## 数据留存

- 服务端保存会话令牌哈希。会话在受保护请求中续期，同会话最多每 10 分钟写一次。超出并发额度踢掉最早的会话，停用或注销立即作废。
- 邮箱验证码、邀请明文和会话令牌均不入库。浏览明细只在明确同意后写入，不采集设备指纹。关闭追踪立即停止写入，已有明细可单独清空。
- 名单的 7 天、30 天活跃次数按 UTC 活跃日计数，依据登录与会话刷新，与浏览追踪同意分开。注销会删除账号、身份、会话、同意记录、个人活动、申请和个人关联，保留已生成的匿名汇总。

| 数据 | 留存期限和删除方式 |
| --- | --- |
| 不活跃的读者账号及关联个人数据 | `active` 账号默认连续 30×24 小时未登录或浏览后进入两次邮件提醒流程。两次提醒都成功发送、账号仍无活动才会永久删除 |
| 验证码与申请限频 IP 键 | 使用加密哈希，限频窗口为 1 小时，到期后由每日维护清理 |
| 登录日志 IP | 保存 30 天，由每日维护清理 |
| 待审申请 | 自提交起保存 90 天，每日维护删除整条申请 |
| 已拒绝、已通过的申请 | 自决定起保存 90 天，每日维护删除整条申请。已签发的邀请码按自身记录管理 |
| 未使用的过期或撤销邀请码 | 每日维护清除绑定邮箱和备注，保留邀请码记录 |
| 追踪同意记录 | 每人保留最近 50 条，切换追踪同意时清除更早的记录 |
| 浏览明细 | 每人最多 20000 条，写入时清除超额的最早明细。每日维护将留满 180 天的明细转为按 UTC 日期和事件种类计数的站点级匿名汇总 |

申请中的姓名、公司、职位、微信号、邮箱、介绍人、申请理由及审批备注随整条申请删除。通过申请后签发的邀请可按其用途保留绑定邮箱。上线前在站点的隐私说明中写明申请资料和浏览明细的留存期限。

### 不活跃账号清理

最近活动取最后活跃、激活和注册时间中的最晚值。登录或受保护页面浏览触发的会话续期都算活动。首次提醒后再次活动会立即清空提醒和截止时间，重新累计不活跃时长。只有处于 `active` 的读者进入清理流程。

以下时间均为北京时间。

1. 每天 11:00，`reader-accounts.inactive-notice` 先处理到期账号，再对连续未活动满 30×24 小时的账号发第一次提醒。邮件写明默认在 3 天后的 11:00 删除账号、全部个人资料和浏览记录，并提供登录链接。
2. 到期当天 09:00，`reader-accounts.inactive-final-notice` 发第二次提醒。错过当天的 09:00 时段后补发时，邮件写明顺延后的删除日期。
3. 删除只在 11:00 的任务中执行。两次提醒均成功发送、第二次至少早于删除 60 分钟、首次提醒后没有活动，才会删除。缺少第二次提醒或间隔不足时，截止时间顺延至下一次 11:00。自动删除与自行注销共用清理流程，保留已生成的匿名汇总。

提醒和删除只在 `READER_MAIL_ENABLED=true` 时执行。发送失败会回滚本次提醒记录。每日 11:00 的删除和首次提醒合计每次最多处理 200 个账号，其他任务各最多处理 200 个账号。`job_runs` 记录处理数量。

每周一 11:00，`reader-accounts.inactive-digest` 汇总已收到第一次提醒且仍在等待删除的读者。汇总列出姓名、公司、职位、第一次提醒时间和预定删除时间。有等待中的读者时，`FEISHU_INTERNAL_ENABLED=true` 会启用飞书通知。读者邮件也已启用且填了 `READER_ADMIN_EMAIL` 时，同时向该地址发送汇总。

隐私说明必须如实写明这条不活跃账号及关联数据的自动删除规则，具体文案由站长确认。
