---
date: 2026-11-26
pr:
title: "feat(execution-budget,governance): 受控解除 4 文件 SHA-256 锁并引入旧执行预算 bypass 开关"
---

- 起因：旧执行预算体系的 4 文件硬字节 SHA-256 锁（`tool-broker.ts`、`router-model-gateway.ts`、`tool-broker.factory.ts`、`model-gateway.module.ts`）与跨服务 RS256 Grant 写库机制频发 `409 EXECUTION_BUDGET_GRANT_REUSED` 并阻碍多租户充值钱包（W1/W2）落地；按已获批架构瘦身方案，需先通过受控治理 PR 解除 4 文件硬字节锁并在引擎侧开放向后兼容的旁路开关。
- 改动：
  1. 将 `docs/governance/durable-result-strategies.json` 的 `physicalExecutionWiring` 从 `PARTIAL_HOLD` + 4 文件 SHA-256 硬字节锁降级为 `REVIEW_ONLY` 路径清单，并同步更新 `scripts/execution-authority-policy.mjs`、治理自测与 `execution-authority-cutover.spec.ts`。
  2. 新增 `apps/api/src/execution-budget/legacy-execution-budget-mode.ts` 引入 `LEGACY_EXECUTION_BUDGET_MODE=enforce|bypass`（默认 `enforce`，异常值 fail-closed 回退 `enforce`），提供纯技术无状态单任务硬上限常量（查询/公司/联系人/token/超时/单任务调用次数）与零写库 `StatelessTechnicalBudgetStore`（拒绝 `platform` 作用域）。
  3. 将双模式开关接入 `ExecutionBudgetAuthorityService`、`ToolBroker`、`RouterModelGateway`、`tool-broker.factory.ts`、`model-gateway.module.ts`、`discovery.module.ts`、`worker.ts`、`dev-fast-lane-worker.ts`、`discovery.activities.ts` 与 `checkExecutionBudgetJwksReadiness`：`bypass` 模式跳过 RS256 验签与 `ExecutionBudgetAuthority`/`ToolBudgetAccount`/`ToolBudgetOperation` 写库并消除 `409 GRANT_REUSED`，同时保留合规闸门、限流与 `ai_trace`/`usage_ledger` 成本台账；`enforce` 模式保持零退化。
- 测试：新增 `apps/api/src/execution-budget/legacy-execution-budget-mode.spec.ts` 覆盖 `enforce`/`bypass` 双模式、无状态硬上限、零写库、`ai_trace` 记账、平台作用域防旁路与 readiness 探针；运行 `pnpm --filter @global/api build`、全量 Vitest 单测、`pnpm governance:verify`、`pnpm docs:verify` 与 `gitleaks` 均通过。
- 未做：暂未切换现网环境变量为 `bypass`（待 `gain-saas` M9 充值钱包稳定上线后灰度开启），亦未删除旧 `execution-budget/` 目录与历史账本表（留待后续 W3 清理阶段）。
