---
date: 2026-11-10
title: 模型驱动联网搜索的工具环与任务登记（获客通路 A 第一步）
---

- 起因：获客需要一个受治理的「模型自己规划检索、按证据产出候选」通路（用户 2026-11-09/10 决策：路线 A=模型工具环+栈内搜索，不采用模型厂商原生 grounding）。本批只做工具环与任务契约本体，执行器（SearXNG/DeepSeek）与 provider 接线在后续 PR。
- 改动：
  - `apps/api/src/discovery/model-web-search/model-web-search.ts`：工具环——模型经 `web_search` 调用执行器（依赖注入），轮数与调用数上限、工具输入二次校验、最终答案严格 JSON（域名字法、https 证据必填、去重、countryCode 白名单），fail-closed 错误码（NOT_JSON/ANSWER_INVALID/EVIDENCE_MISSING/UNKNOWN_TOOL/ROUND_BUDGET/TOOL_BUDGET/MAX_TOKENS/TOOL_INPUT_INVALID）。
  - 新 AI Task `discovery.web_search_candidates`（flash 档、allowedTools=searxng.search）与六处登记面：`ai-tasks/task-registry.ts`、`durable-results/model-result-projections.ts`（MODEL_RESULT_TASK_IDS、schema `discovery-web-search-candidates/v1`、投影定义与注册）、`durable-results/durable-result-strategy.ts`（typedProjectionSchemaValues）、`durable-results/model-result-projection-bounds.spec.ts`（EXPECTED_BOUNDS）、`docs/governance/durable-result-strategies.json`（modelTasks 条目）、`scripts/execution-authority-policy.mjs` 与 spec（任务 14→15，含计数断言）。
  - G9 基线微调（经本 PR 评审）：`apps/api/src/ai-tasks/task-registry.ts` 931→974、`apps/api/src/durable-results/model-result-projections.ts` 1744→1784，均因新增任务/投影，理由见基线 reason 字段。
  - 门户介绍（`apps/api/src/docs/portal-intro.ts`）：分域表补齐 JudgmentReview/Metrics/Outreach/Channels/Seller Documents/Packs-Skills-Agents/Campaign；主链路补 enrich-contacts、contact-eligibility、判定复核（claim/resolve、judgments 查询与统计）与四个 metrics 端点；重导出 `packages/contracts/openapi/openapi.json`（137 路径不变，仅 info.description 变化）。
- 测试：`model-web-search.spec.ts` 4 例（工具环、围栏 JSON、非法域/缺证据/越权工具/预算/截断）；`model-result-projection-bounds.spec.ts` 81 项；`node --test scripts/execution-authority-policy.spec.mjs` 17/17；`node scripts/check-file-budgets.mjs` OK（warn 4）。
- 未做：执行器接线（SearXNG 免费执行器、DeepSeek `deepseek.search/fetch` 工具）与 `model_web_search` discovery provider 注册、run 预算帽、20–30 条 golden ICP 评估集——均在后续 PR。
