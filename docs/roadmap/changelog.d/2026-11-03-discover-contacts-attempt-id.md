---
date: 2026-11-03
title: Add a client attemptId to on-demand contact discovery
---

- 起因：`POST /canonical-companies/:id/discover-contacts` 的预算请求作用域此前只绑定 `companyId`，同一公司第二次点击「发现联系人」会命中已消费的一次性 Grant，返回 `EXECUTION_BUDGET_GRANT_REUSED`；理解重试（#730）已用客户端 `attemptId` 隔离每次尝试，联系人发现缺少同样机制。
- 改动：
  - `DiscoverContactsDto` 增加可选 `attemptId`（UUID，1–8 版），由客户端每次点击生成。
  - `workspaceExecutionBudgetRequestScope` 仅在请求携带 `attemptId` 时才把它并入规范化材料；缺省时 requestSha256 与旧版完全一致，存量 Grant 不受影响。
  - `discoverContactsExecutionBudgetRequestScope` 作为 HTTP 适配器与 Grant 签发共用的规范边界；`DiscoveryService.discoverContacts` 用它消费 workspace Grant。
  - 技术报价控制器接受可选 `body: { attemptId }` 并校验 UUID；OpenAPI 合同（`workspace-technical-quote` oneOf 与 `DiscoverContactsDto`）同步。
- 测试：`execution-budget-request-scope.spec.ts` 新增「带 attemptId 的新哈希」用例与「缺省保持旧哈希」断言；`workspace-technical-budget-quote.controller.spec.ts` 新增带 attemptId 的报价与非法 UUID 拒绝用例。已用现有 pnpm store 运行这两个 spec：2 个文件 / 24 个用例全过；全量单测交由 PR CI。
- 未做：SaaS BFF 默认仍关闭该字段（`ENGINE_DISCOVER_ATTEMPT_ID_ENABLED=false`，会在旧引擎下从 quote 与转发体剥离），待本镜像发布后再开启；不改变 `lawfulBasis` 校验、发现结果语义或一次性 Grant 的其它约束；不发布镜像。
