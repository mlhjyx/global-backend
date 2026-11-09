---
date: 2026-11-10
title: model_web_search discovery provider 接线（获客通路 A 闭环）
---

- 起因：工具环（#975）与执行器工具（#976）已在 main，但没有任何 discovery provider 调用 `discovery.web_search_candidates`，run 永远不会走到模型联网搜索。本批把 provider 接进注册面与执行面，闭合「生成查询→检索→候选→入库」这一边（用户 2026-11-10 闭环要求）。
- 改动：
  - 新 provider `apps/api/src/discovery/providers/model-web-search.provider.ts`（key `model_web_search`，public_intelligence）：两段式——探索环 `runModelWebSearch`（模型规划检索词，经 ToolBroker 走 SearXNG 或 DeepSeek，搜索回执为 auxiliary）+ 结构确认 `discovery.web_search_candidates`（generateStructured 持久投影，**该回执即公司血缘**，producerId=任务 id）。最终候选必须能在实际检索结果里按主机名找到出处，否则丢弃（防模型臆造域名）；blockedDomains 生效；env `MODEL_WEB_SEARCH_PROVIDER=on` 为第一开关（默认 off 时返回有效空血缘），`MODEL_WEB_SEARCH_EXECUTOR=searxng|deepseek` 选执行器。
  - 血缘契约扩一个 provider key：`company-discovery-lineage.ts`（union + `PROVIDER_RECEIPT_CONTRACT`）、`discovery-query-governed-lineage.ts`（`PROVIDER_CONTRACT`）、`durable-results/domain-ack-consumer-bindings.ts`（governed 回执绑定；另补 `deepseek.search` 的 product consumer 绑定与 `discovery.activities.ts` 的 producer 白名单）。
  - 注册与路由面：`provider.registry.ts`（构造 push + data_provider seed ENABLED，第二道 kill switch）、`provider-source-classes.json`、`plan-query-sources.ts`（planner 指南 + cheap-first 优先级 60）、`execution-envelope.ts` `MAX_COMPANY_DISCOVERY_ADAPTERS` 8→9。
  - 报价信封（`workspace-technical-budget-envelope.ts`）：补 `discovery.web_search_candidates` 模型上界（每查询 ≤ `MODEL_WEB_SEARCH_MAX_ROUNDS`+1 次）与两种搜索执行器工具上界；新常量 `MODEL_WEB_SEARCH_MAX_ROUNDS/MAX_TOOL_CALLS`（工具环默认值改用同一常量）。
  - 治理：`docs/governance/provider-registry.json` 新增 `model_web_search`（IMPLEMENTED，ENABLED），`docs/backend/provider-registry.md` 重新生成。
- 测试：新增 `model-web-search.provider.spec.ts`（默认关零调用、缺 gateway 诚实降级、证据落地只保留检索结果中的公司、blockedDomains、已结算失败→零记录有效血缘、执行控制错误穿透、探索失败→有效空血缘）；`provider.registry.spec.ts` 精确清单同步；`workspace-technical-budget-quote.controller.spec.ts` 报价上界随适配器 9 更新。
- 未做：DeepSeek 执行器真实联网的端到端费用验证（需真实 key 往返，费用授权后单独发车验证）；golden ICP 评估集（下一步）；发现 run 的 20–30 条真实样本验收（发车后做）。
