---
date: 2026-11-09
title: Website candidate search goes through ToolBroker instead of direct SearXNG egress
---

- 起因：v3.0 第 6 章 WEB-10 / 审计「未登记出网路径」——`company/website-candidates.ts` 直接 import `searxSearch` 并发调用自托管 SearXNG，绕过了 ToolBroker 的 source_policy、预算、限流、幂等与 Trace 账本。
- 改动：
  - `website-candidates.ts`：删除直连 `searxSearch` 依赖；搜索执行器改为注入 `SEARXNG_SEARCH`（签名带 `{workspaceId, correlationId}` 上下文），缺失时 **fail-closed 503 `WEBSITE_CANDIDATE_SEARCH_UNAVAILABLE`**（且不触达数据库）。
  - 新增 `brokerBackedSearxSearch(broker)`：经 `ToolBroker.invoke('searxng.search', …)` 执行，映射 durable 投影（url/title）回 `SearxResponse`；策略拒绝/预算不足按既有「搜索失败返回空列表」语义容错，拒绝事件由 Broker traceRecorder 落 warn。
  - `company.module.ts`：`SEARXNG_SEARCH` 改为 `buildToolBroker({sourcePolicyReader, prisma, budgetStore})` 工厂（`TOOL_BUDGET_STORE` 由全局 ModelGatewayModule 提供），不再有未登记出网路径。
- 测试：无执行器 → 503 且不读库；Broker 适配器（工具 id/入参/上下文透传、投影映射、空 url 过滤）；Broker 拒绝 → 空列表容错；既有排序/查询用例保持全绿。
- 未做：端到端真搜验证（需 dev 栈真跑，发车后由发车验收覆盖）；未部署。
