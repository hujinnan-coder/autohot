# 模型分工与本机调用

这份文档说的是：每个活派给谁、怎么调、花了钱怎么不浪费。改模型前先读这里。

## 谁干什么

| 活 | 谁 | 怎么调 |
|---|---|---|
| 方案、架构、前端、收尾、写派活提示词、看 diff | Claude（OpenRouter，按量） | ZCode 主会话 |
| 后端实现、数据处理、代码审查、界面上的点鼠标 | Codex（$100 订阅，包月） | 本机 `codex exec` |
| 正文粗筛（重复/广告/语言/长度/明显无关） | 本地 `qwen3.5:9b` | 本机 ollama，免费 |
| 筛选、评估、理解、归组 | DeepSeek（`deepseek-flash`） | 流水线 worker |
| 交叉复核 | MiMo（`mimo-v2.6-pro`） | 流水线 worker |

Claude 和 Codex 不要合并成一个账单：Codex 订阅只产出 OAuth token，没有可复用 API key，喂不进 OpenRouter；Claude 号已封，只能按量买，也没别的入口。

## 从 ZCode 调 Codex

装好的 CLI 在 `~/.local/bin/codex`（`codex-cli 0.170.0`，复用 ChatGPT 桌面端登录态，不需要再登录）。

```bash
# 先看：只读，不动文件
~/.local/bin/codex exec -C ~/Desktop/autohot --sandbox read-only \
  "读 docs/architecture.md，说明 publication 读取层被哪些出口调用" < /dev/null

# 再改：限定目录可写
~/.local/bin/codex exec -C ~/Desktop/autohot \
  --sandbox workspace-write -m gpt-6.2-sol \
  "按 docs/model-routing.md 的迁移约定，把 X 改成 Y，跑 npm run typecheck" < /dev/null
```

三个必须记住的点：

- **结尾要加 `< /dev/null`**。不加的时候 Codex 会以为有管道输入，卡在 "Reading additional input from stdin..."。
- **默认模型是 `gpt-6.2-sol`**（`~/.codex/config.toml`），日常用它。终审和疑难加 `--profile astra-max` 切到 astra + max 推理，别一直开着。
- 执行完要自己复核：`git --no-pager diff --stat` 加 `npm run typecheck`，别把「Codex 说做完了」当成做完了。

## 一次只能一个人写

两个 agent 同时改同一个目录必冲突。规矩：

- Claude 在 `feat/<主题>` 分支改前端和架构，Codex 在另一个分支改后端，靠 PR 交接，不靠复制粘贴。
- 同一次任务里，Claude 负责派活和验收，Codex 只负责实现。
- **本机现在有两份同源克隆**：`~/Desktop/autohot`（ZCode 在用，较新）和 `~/Desktop/autohot-codex`（Codex 侧，11-17 的旧提交）。两个仓库同时改会分叉，尽快挑一个留下，另一个归档或删掉。

## 审查三轮封顶

Codex 审查最多跑三轮，第四轮交人。同理：只让贵模型做判断，不让它做机械活——把简单活派下去再 review 回来，等于付两遍钱。

## 流水线的模型配置

改的是 `site/models.ts` 的 preset 和 `.env` 里的这几个键：

| 键 | 现在 | 建议 |
|---|---|---|
| `PREFILTER_MODEL` | `deepseek-v4-pro` | 先用本地 9b 粗筛，剩下的进 `deepseek-flash` |
| `SCORE_MODEL` | `deepseek-v4-pro-think` | 保留思考，但换成 `deepseek-flash` 的 think 档 |
| `UNDERSTAND_MODEL` | `deepseek-v4-pro` | `deepseek-flash` |
| `GROUP_MODEL` | `deepseek-v4-pro` | `deepseek-flash` |
| `GROUP_REVIEW_MODEL` | `mimo-v2.6-pro` | 保留，这是第二意见的价值 |
| `EMBEDDING_MODEL` | `bge-m3` | 保留；要并到本机 ollama 跑就改 `EMBEDDING_BASE_URL` 指 `http://127.0.0.1:11434/v1` |

依据是公开榜：`deepseek-v4-pro` 综合 59.5 分（第 47），`deepseek-v4.1-flash` 66.0 分（第 22），价格还是前者 1/4 左右。当前 `.env` 里那把 DeepSeek 密钥只列出两个模型 ID——`deepseek-flash` 和 `deepseek-v4-pro`，所以 `deepseek-flash` 就是账号里能拿到的最新 flash。

**但别直接全量切。** 先拿 50 条真实样本双跑，比入选结果变了多少条、变的是否都对，按 `docs/selection.md` 的校准方式确认，再改 `.env`。

## 夜里跑批

DeepSeek 有高峰定价：工作日 09:00–12:00、14:00–18:00 输入输出**双双翻倍**。所有批量任务（预筛后处理、正文整理、事件识别、周报月报）排在 18:00 之后或 09:00 之前，同样的活少花一半钱。

## 本地模型

- `qwen3.5:9b`：粗筛、去重、语言判断、格式转换。调用必须带 `"think": false`，否则 token 全花在思考上、输出为空。
- `bge-m3`：1024 维向量，语义聚类和去重用，替代云端 embedding。
- 本机是 24G 内存的 M6，别指望它写代码或做判断——它只配做「不紧急、不重要、但量很大」的活。
- 一个月后回看调用量：本地 9b 少于 200 次，就 `ollama rm qwen3.5:9b`。
