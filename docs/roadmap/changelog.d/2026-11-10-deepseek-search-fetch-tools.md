---
date: 2026-11-10
title: Add DeepSeek search and fetch tools to the governed tool broker
---

- 起因：获客通路 A（模型驱动联网搜索）已定「模型工具环 + ToolBroker」，需要付费搜索执行后端；DeepSeek 提供独立 Search/Fetch JSON API（5 元/1000 次成功请求，按成功计费）。
- 改动：
  - 新增 `deepseek.search` / `deepseek.fetch` 两个 Tool（`apps/api/src/tools/deepseek-tools.ts`，经 `registerBuiltinTools` 注册）：sourcePolicy=none、sourceClass=public_intelligence、rateLimit 5 rps、estimatedCents 按整数美分上限取整（1 美分/次计费请求）；缺 key 返回 degraded 空结果而非抛错。
  - `deepseek.search` 只输出 url+title 并丢弃个人主页 URL（与 searxng.search 同口径，personalData:false）；`deepseek.fetch` 返回 ≤32k 字符正文并先查目标站 robots.txt（personalData:true，与 social.fetch 同类）。
  - 新增适配器 `apps/api/src/adapters/deepseek-tools.ts`（固定主机、拒绝重定向、30s 超时、响应体硬上限、429/5xx/网络错误有界重试、每次物理发信前过授权与 beforePhysicalWire）。
  - 新增 `deepseek-search/v1`、`deepseek-fetch/v1` typed projection；模型联网搜索执行器绑定 `brokerBackedDeepSeekWebSearch`（broker.invoke('deepseek.search', …)）。
  - 抽共享文本整形 `apps/api/src/tools/durable-text.ts`（searxng/social/deepseek 共用），`builtin-tools.ts` 降到 800 行以下并按 G9 规则删除其基线条目。
  - 治理清单：EXPECTED_TOOL_IDS 20→22、tool callsites 44→45、`durable-result-strategies.json` tools +2；`catalog-result-projections.ts` 基线按评审上调（G9 记录于 PR）。
- 测试：适配器/工具/执行器单测（fetch mock，无真实出网），覆盖成功、限速、402、无 key 降级、投影与 replay；`gctl check --fast`。
- 未做：不部署、不发车；`discovery.web_search_candidates` 任务的 allowedTools 尚未加入 deepseek.search（由模型工具环接线 PR 决定）；deepseek.fetch 暂无调用方。
