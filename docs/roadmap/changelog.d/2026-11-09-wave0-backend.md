---
date: 2026-11-09
title: Wave 0 backend hardening — campaign job reaping, budget readback, quickJudge gate, sanctions freshness, Prisma drift gate
---

- 起因：2026-11-08 六套全局审查确认的五条高优缺陷（ch08 §2.2/§2.3）：campaign 规划 job 可永久 RUNNING 且阻塞后续规划；$15/30 天花费窗口只统计 discovery 模型成本；quickJudge 批量路径绕过逐家出网闸门；制裁名单陈旧 28 天而筛查照跑；Prisma datamodel 与真库分叉 20 表且 CI 无漂移门。
- 改动：
  - campaign：launcher 显式 `workflowExecutionTimeout=60m / workflowRunTimeout=50m / workflowTaskTimeout=30s`；失败回写重试提到 8 次，重试耗尽改由 outbox 集成事件 `CampaignPlanJobFailed` 兜底（SaaS 拉取后置 FAILED）。
  - 成本护栏 C1：新增服务身份只读端点 `GET /api/v1/execution-budget/window-usage`（`tool_budget_operation.charged_microusd` 实扣为窗口口径，含在途预留与 byPurpose 聚合；`BUDGET_READBACK_SERVICE_TOKEN` + 仅回环）。
  - quickJudge：批量协议 `authorizeExternalAction` 不再恒 true，wire 前用 `companyMayUseExternalProcessingMany` 单事务逐家重校验；被拒整批降级逐家、被禁联公司 skipped。
  - 制裁陈旧门：qualify/decide 前检查 `sanctions_source.last_refreshed_at`（7/14 天三档，`SANCTIONS_LIST_MAX_AGE_DAYS`/`SANCTIONS_LIST_BLOCK_AGE_DAYS` 可配）；blocked 整批 `sanctions_hold`、stale 不产 `recommended` 且 accept 拒绝；`sanctions_screening_result` 增 `list_stale/list_age_days/list_snapshot`；新增 `SanctionsListStale` 集成事件与 `docs/backend/sanctions-operator-refresh.md` §5。
  - worker：显式并发上限 `WORKER_MAX_CONCURRENT_{ACTIVITY,WORKFLOW,LOCAL}`（默认 12/8/4，非法值启动即失败）。
  - 数据门：CI 新增 `prisma migrate diff --from-migrations --to-schema-datamodel` 漂移门（`packages/db/scripts/prisma-drift-gate.mjs`），基线允许清单 ratchet（当前 20 张 SQL-only 表 + 2 列登记，owner/到期日），见 `docs/backend/prisma-schema-drift.md`。
- 测试：新增/扩展 `campaign-plan.launcher.spec.ts`、`campaign-planning.workflow.spec.ts`、`campaign-planning.activities.spec.ts`、`execution-budget-window-usage.service.spec.ts`、`budget-readback-service-token.guard.spec.ts`、`discovery.run2.activities.spec.ts`（TOCTOU 负向）、`sanctions-freshness.spec.ts`、`sanctions-screening.spec.ts`、`qualify.activities.spec.ts`（三档）、`lead-qualified-snapshot.spec.ts`（decide stale）、`worker-concurrency.spec.ts`；`gctl check` 全绿。
- 未做：SaaS 侧窗口判定切 max(ledger, engine)+fail-closed 缓存、`CampaignPlanJobReaperService`（75 分钟）、`CampaignPlanJobFailed`/`SanctionsListStale` 的 SaaS 消费端均在 gain-saas，另行排期；worker 并发值的压测校准与部署待发车；20 张 SQL-only 表补齐 datamodel（P5c-BE-30）后基线逐条删除。
