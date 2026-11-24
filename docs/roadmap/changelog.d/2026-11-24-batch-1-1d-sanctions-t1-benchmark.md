---
date: 2026-11-24
pr:
title: Batch 1.1-D — 补齐 4 个 T1 证据提取器、TED 角色门默认开启、judgment_record.run_id 回写、worker 制裁定期刷新、清理分叉工作流文件与 discovery 基准守门
---

- 起因：Batch 1.1 收尾审计发现五处剩余断层：① `evidence-bundle.ts` 在 `SOURCE_TIERS` 中声明了 7 个 T1 源却只实现了 3 个提取器，导致 `companies_house`/`ch_registry`、`inpi_rne`、`google_patents`、`samgov` 证据被静默丢弃并触发跨源佐证门误降级；② `TED_BUYER_ROLE_GATE` 默认关闭，供给侧中标方仍混入买家队列；③ `persistJudgmentRecordInTransaction` 未透传 `args.runId`，导致线上 `judgment_record.run_id` 全为 `NULL`、`source_yield_ledger` 与 `precision@k` 无法关联判定；④ 独立 `worker.ts` 仅在启动时构建一次制裁索引，长期运行不周期刷新；⑤ 废弃分叉入口 `workflows.ts` 与无调用方的 `ensure-schedules.ts` 仍在仓内误导维护与回放测试；同时缺少一键离线回归基准脚本 `pnpm benchmark:discovery`。
- 改动：
  - `apps/api/src/discovery/evidence-bundle.ts` & `evidence-bundle.spec.ts`：补齐 `companies_house`（兼容 `ch_registry`）、`inpi_rne`、`google_patents`、`samgov`（兼容 `sam_market_signal` 与 `intent.events`）4 个 T1 证据提取器，所有键名避开 sanitizer 黑名单并通过 `sanitizeCanonicalCompanyAttributes` 严格往返测试。
  - `apps/api/src/lead/scoring.ts` & `ted-role-diagnostic.spec.ts`：`TED_BUYER_ROLE_GATE` 改为默认开启（仅显式 `TED_BUYER_ROLE_GATE=off` 回退），默认拦截供给侧 `self_role=winner` 记录。
  - `apps/api/src/discovery/fit-judge.ts`、`discovery.run2.pipeline.activities.ts`、`discovery.activities.ts` & `fit-judge-v2.spec.ts`：`persistJudgmentRecordInTransaction` 新增可选 `runId` 参数并在两条 discovery 活动链中传入真实 `args.runId`，修复 `judgment_record.run_id` 恒空问题。
  - `apps/api/src/sanctions/sanctions-screening.service.ts` & `apps/api/src/temporal/worker.ts`：新增幂等 `startPeriodicRefresh()`，在独立 `worker.ts` 启动成功加载索引后开启周期刷新并在关闭时 `onModuleDestroy()` 清理定时器。
  - 删除分叉 `apps/api/src/temporal/workflows.ts` 与僵尸 `apps/api/src/temporal/ensure-schedules.ts`（含旧单测 `ensure-schedules.spec.ts`）；将 4 个 `.replay.spec.ts`、2 个 site-builder 接线完整性单测及 `governance-workflow-constants.mjs`/`.spec.mjs` 统一切至真实生产入口 `customer-workflows.ts`、`platform-workflows.ts` 与 `sweep-scheduler.service.ts`。
  - 新增 `scripts/benchmark-discovery.mts` 并在根 `package.json` 注册 `pnpm benchmark:discovery`（离线确定性校验预算报价上限、7 源 T1-T3 佐证、TED 默认门控、多字符集解码/表格切分与网页提示隔离）。
- 测试：`pnpm benchmark:discovery`、全部关联单测（含 4 套 Temporal replay 测试与 `governance-workflow-constants.spec.mjs`）、G9/G15/G16/G17、`execution-authority-policy`、`governance-verify`、`nest build`、`eslint`、`docs:verify` 与 `gitleaks` 全部通过。
- 未做：不修改已签名锁定在 `platform-authority-policy-matrix-v2/v3.json` 中的 `PLATFORM_SANCTIONS_SOURCE_MAX = 2`（三源全量刷新由属主运营命令 `refresh-sanctions-lists.mts --source=all` 在 Batch 1.1 Host Ops 阶段执行，待 Phase 3 演进 v4 签名矩阵时再升级调度上限）；未部署。
