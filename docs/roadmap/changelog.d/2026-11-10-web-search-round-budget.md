---
date: 2026-11-10
title: 模型联网搜索工具环轮数上调（4→6 轮 / 8→10 次搜索）并提示尽早作答
---

- 起因：真实 run（2026-11-10，9d0e3065）中 deepseek-flash 在 4 轮往返后仍在检索，工具环报 `MODEL_WEB_SEARCH_ROUND_BUDGET_EXCEEDED`，`model_web_search` 查询以空结果收尾（回执合法、provider 在场、record_count=0）。4 轮对 3 轮检索 + 最终作答的节奏过紧。
- 改动：`MODEL_WEB_SEARCH_MAX_ROUNDS` 4→6、`MODEL_WEB_SEARCH_MAX_TOOL_CALLS` 8→10（报价信封与工具环默认值共用同一常量，自动跟随）；系统提示补一句「检索 2–3 轮、证据足够就立即给出最终 JSON，不要无限检索」。
- 报价：`discovery.web_search_candidates` 每查询模型上界 5→7 次、SearXNG/DeepSeek 搜索工具上界 8→10 次，discovery.run 技术报价上界随之更新（spec 同步按真值）。
- 测试：预算信封 spec 与 quote 控制器 spec 更新；工具环单测沿用显式上限不受影响。
- 未做：DeepSeek 执行器真实付费往返（仍在 searxng 执行器上验证链路）。
