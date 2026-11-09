---
date: 2026-11-09
title: Enrich-contacts HTTP endpoint with contact.enrich budget purpose (P1-10a)
---

- 起因：P1-10（拆 a/b）——富集瀑布（P1-08）与 A 档尾池（P1-09）已就位，需要一个受 ExecutionBudget Grant 管控的 HTTP 入口，把「公司 → 缺邮箱联系人 → 付费 finder 瀑布 → 验证 → 落库」串起来。
- 改动：
  - **执行预算 purpose `contact.enrich`**（subject=company）：TS 面（purpose 联合、binding/verifier 白名单、request scope 新 operation `POST /canonical-companies/:id/enrich-contacts` 与 canonical 请求哈希、quote 的 purpose 枚举/参数变体）+ DB 面两个迁移（enum 加值 `20261109190000`；authority CHECK 与 `consume_workspace_execution_authority` 逐字复制自 `20261108163100` 并追加 contact.enrich 分支，`20261109190100`）。
  - **报价 envelope**：新 operation 进 `WORKSPACE_EXECUTION_QUOTE_OPERATIONS`（12 项）；envelope 只给执行形状（finderCallsPerCompany=10、verificationCallsPerAddress=6、contactsPerRequest=10、providerConcurrency=2、softDeadlineMs=10min）、cap 为表示最小值——付费 finder/验证 API 尚未经 ToolBroker 计价（与第三方验证器同现状），Grant 的 capMicrousd 由端点侧 CapBudget 忠实执行，把供应商单价纳入报价策略表需 gain-saas lane 协调（后续卡）。
  - **端点** `POST /api/v1/canonical-companies/:id/enrich-contacts`（scopes acquisition:write + contact-discovery:read + compliance:manage；Grant 一次性消费；lawfulBasis 必填——缺失在消耗 Grant 前以 `CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED` 拒绝）：body `{lawfulBasis, lawfulBasisRef?, lawfulBasisNote?, contactIds?≤10, maxProviders?≤3, maxProbe?≤6, attemptId?}`。
  - **共享核心** `enrichment/waterfall/enrich-company-contacts.ts`（HTTP 与 run activity 共用）：只取「完全缺 email 点」的具名联系人；每公司 finder 调用 ≤10（跨联系人共享）、软截止 10 分钟、A 档（任一 lead.totalScore ≥80）才追加 Apollo/PDL 尾池；预算 = Grant 授权 cap 与单联系人 $0.15 取最紧；逐联系人调用 P1-08 编排器；PII 访问审计（purpose=contact_discovery）与请求同留痕。
  - `discovery/execution-envelope.ts` 新增 P1-10 执行形状常量（MAX_ENRICH_*、ENRICH_COMPANY_CONCURRENCY、ENRICH_SOFT_DEADLINE_MS、MAX_RUN_ENRICH_COMPANIES，run 接线在 P1-10b 使用）。
- 测试：公司级核心 8 场景（无域/无联系人跳过、B 档不路由尾池、A 档路由尾池、每公司调用上限、软截止、预算为 0 的 skipped_budget）；request scope 两个新哈希钉；envelope 目录 12 项 + enrich 形状断言；quote OpenAPI 变体数 11；execution-budget 全套 531 通过；authz-openapi/operation-descriptions 通过；OpenAPI 重导出（137 paths）；漂移门（一次性库全链重放 + 两个新迁移）零未登记差异。
- 未做：run 内 activity 与 workflow 接线（P1-10b）；供应商真实调用与报价计价（用户/gain-saas lane 决策）。
