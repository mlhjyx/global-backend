---
date: 2026-11-27
pr:
title: "修复 bypass 模式下目标市场候选生成校验不可用及 crawl4ai.render L2 限流超时"
---

- 起因：1）生产环境开启 `LEGACY_EXECUTION_BUDGET_MODE=bypass` 后，执行 `POST /market-candidate-generations/:generationId/execute` 时 `ExecutionBudgetAuthorityService.consumeVerifiedWorkspaceGrantInTransaction` 跳过数据库落盘，触发 `market_candidate_generation_attempt` 缺账户行而报 `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`；2）现网流式寻源 L2（4 路并发）频繁调用 `crawl4ai.render` 时，其全局并发配额 `concurrency: 3` 折算单租户 40% 配额仅 1 个槽位，导致多次 `RATE_LIMIT_ACQUIRE_TIMEOUT` 并把原本跑完的寻源标记为 `PARTIAL`。
- 改动：1）在不放宽数据库触发器、不改动 `enforce` 模式也不恢复外部 RS256 授权的前提下，仅对 `market.candidates.generate`（及 `market-candidates-generation/v1` 持久投影）在 `bypass` 模式下走本地 80 美分技术上限落盘与 `PostgresBudgetStore` 路由，其余工作区任务保持零数据库写入；2）将 `crawl4ai.render` 全局限流配额从 `{ rps: 1, concurrency: 3 }` 提升至 `{ rps: 4, concurrency: 10 }`（单租户并发 4 对齐 L2 并发，保留 2000ms 单域间隔）。
- 测试：补齐 `legacy-execution-budget-mode.spec.ts` 对应单测，并运行 `source-tools` / `tool-registry` / `router-model-gateway` / `market-candidate-generation` 单测、`@global/api` 构建、ESLint 与仓库治理快门校验。
- 未做：不涉及数据库迁移与前端文案改动，合入后与 `#1150` 合并为单次镜像发布并现网验真。
