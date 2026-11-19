@AGENTS.md
@docs/model-routing.md

# 硬规矩（摘要，上面两份文档的要点）

- 方案、架构、前端、收尾由你自己做；后端实现、代码审查、界面点鼠标派给 Codex。
- 派 Codex 用这条命令，结尾必须有 `< /dev/null`：
  `~/.local/bin/codex exec -C ~/Desktop/autohot --sandbox workspace-write -m gpt-6.2-sol "任务" < /dev/null`
  只有终审/疑难才加 `--profile astra-max`。
- 同一目录一次只允许一个 Agent 写。你派的活，Codex 做完你要看 `git --no-pager diff --stat` 并跑 `npm run typecheck`，不能只听它说做完了。
- Codex 审查最多三轮，第四轮交人。
- 改流水线模型（`.env` 里 PREFILTER/SCORE/UNDERSTAND/GROUP/GROUP_REVIEW）前，必须先用 50 条真实样本双跑对比，说明变了多少条、变得对不对，再改。
- 批量任务安排在 18:00 之后或 09:00 之前（DeepSeek 工作日 9-12、14-18 价格翻倍）。
- 本机 ollama 只做粗筛/去重/向量，调用必须带 `"think": false`；不让它写代码或做判断。
