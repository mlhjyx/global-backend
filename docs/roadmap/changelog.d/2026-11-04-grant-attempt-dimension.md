---
date: 2026-11-04
title: Bind an optional attempt id into workspace execution-budget request scopes
---

- 起因：一次失败的 ICP 生成/查询计划生成/执行在预算 Grant 层面会永久砖化——请求作用域只有 `operation + subject`，同一 ICP 的第二次生成、同一计划的第二次执行必然 `EXECUTION_BUDGET_GRANT_REUSED`（断点 B2/B3/B13/B14，「重试」无路可走的根）。
- 改动：`POST /companies/:companyId/icps`、`POST /icps/:icpId/query-plans`、`POST /query-plans/:planId/execute` 三处请求作用域与 quote 请求解析接受可选 `body.attemptId`（UUID），进入 `requestSha256`；**缺省时哈希与旧版逐字节一致**（旧 Grant、in-flight run 语义不变）；同一 attempt 重放仍被拒（幂等），新 attempt 放行并各自独立预算账户。控制器新增可选 DTO（Swagger `ApiBody`），非法 attemptId 由 ValidationPipe / quote 解析拒绝。
- 测试：`execution-budget-request-scope.spec` 表驱动新增三个带 attempt 的哈希向量（旧向量原样保留）；`workspace-technical-budget-quote.controller.spec` 新增 attempt 绑定、同 attempt 幂等、非法 attempt 拒绝用例；全量 `@global/api` 单测。
- 未做：`POST /query-plans/:planId/rerun` 端点与前端「重试」按钮（下一 PR）；gain-saas signer/路由透传（同批另一 PR，发布需同批）；TaskRun `attempt`/`rerunOf` 列（gain-saas 域）。
