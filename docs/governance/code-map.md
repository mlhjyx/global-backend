# 代码地图：能力 → 入口 → 文件 → 测试

> 文档 ID：`DOC-CODE-MAP-001`
> 生命周期：`CURRENT`
> 当前事实来源：`apps/api/src/`、`packages/` 与各模块 `technical.md`
> 最后核验：2026-11-04（基于 `origin/main@8b142f53` 的目录与文件抽查）

本页是阅读起点与变更定位表，不是全量文件清单；只列产品能力的**主入口 + 协作文件 + 测试锚点**。新增能力只更新主要入口，不逐文件登记。

## 1. 获客主链

| 能力 | 入口 | 关键代码 | 测试锚点 |
| --- | --- | --- | --- |
| 执行寻源 run | `POST /query-plans/:planId/execute`（一次性 Grant）→ outbox → `discoveryWorkflow` | `discovery/discovery.controller.ts`、`discovery/discovery.service.ts`、`relay/outbox-relay.service.ts`、`temporal/discovery.workflow.ts` | `temporal/discovery.workflow.timeouts.spec.ts`、`temporal/discovery.run-failure.spec.ts` |
| 查询计划生成与确认 | `POST /icps/:icpId/query-plans`、`POST /query-plans/:planId/confirm` | `icp/icp.controller.ts`、`icp/icp.service.ts` | `icp/icp.service.spec.ts`、`icp/rule-engine.spec.ts` |
| 评分与队列（qualify） | `POST /icps/:icpId/qualify` → `QualifyRequested` → `qualifyWorkflow` | `lead/lead.controller.ts`、`lead/lead.service.ts`、`temporal/qualify.workflow.ts`、`temporal/qualify.activities.ts` | `lead/scoring.spec.ts`、`temporal/qualify.workflow.spec.ts` |
| 联系人发现（run 内 contacts 阶段） | `discoveryWorkflow` contacts 阶段 | `discovery/contact-persist.ts`、`discovery/company-contact-points.ts`、`discovery/contact-stage-email-guess.ts`、`temporal/discovery.activities.ts` | `temporal/discovery.contacts-stage.spec.ts` |
| 邮箱补全与验证 | `POST /canonical-companies/:id/guess-emails`、`POST /contact-points/:pointId/verify` | `discovery/email-guesser.ts`、`discovery/email-guess-persist.ts`、`discovery/email-format-learning.ts` | `discovery/` 下同名 spec（`email-guesser.spec.ts` 等） |
| 制裁筛查（第五门） | run / qualify 内筛查；`POST /leads/:leadId/sanctions-review` | `sanctions/sanctions-screening.service.ts`、`sanctions/sanctions-matcher.ts`、`sanctions/sanctions-refresh.service.ts` | `sanctions/sanctions-screening.spec.ts`、`sanctions/sanctions-matcher.spec.ts` |

## 2. 外围采集与信号

| 能力 | 入口 | 关键代码 | 测试锚点 |
| --- | --- | --- | --- |
| provider 采集 sweep | schedule `acq-sweep` → `acquisitionSweepWorkflow` | `temporal/acquisition.workflow.ts`、`temporal/acquisition.activities.ts`、`discovery/providers/` | `temporal/acquisition.workflow.spec.ts`、`temporal/acquisition.activities.spec.ts` |
| 网站变更 intent | schedule `intent-sweep` → `intentSweepWorkflow` | `temporal/intent.workflow.ts`、`temporal/intent.activities.ts` | `temporal/intent.workflow.spec.ts` |
| 外部意图 sweep（TED / openFDA / SAM.gov） | `externalIntentSweepWorkflow` | `temporal/external-intent.workflow.ts`、`temporal/external-intent.activities.ts` | `temporal/external-intent.workflow.spec.ts` |
| backlog 存量处理 | `backlogSweepWorkflow` | `temporal/backlog.workflow.ts`、`temporal/backlog.activities.ts` | `temporal/backlog.*.spec.ts` |
| 制裁名单刷新 | schedule `sanctions-refresh` → `sanctionsRefreshWorkflow` | `temporal/sanctions-refresh.workflow.ts`、`sanctions/sanctions-operator-refresh.ts` | `sanctions/sanctions-refresh.spec.ts` |

## 3. 平台与交付

| 能力 | 入口 | 关键代码 | 测试锚点 |
| --- | --- | --- | --- |
| 平台准入与预算 | schedule 触发 → `admitPlatformScheduleForWorkflow` | `temporal/platform-schedule-authority.workflow.ts`、`platform-authority/platform-execution-contract.ts`、`execution-budget/` | `temporal/platform-schedule-authority.spec.ts`、`temporal/platform-schedule-authority.replay.spec.ts` |
| outbox 事件交付 | `LeadQualified` 等事件 → sink | `relay/outbox-relay.service.ts`、`relay/event-registry.ts`、`events/` | `relay/outbox-routing.spec.ts`、`lead/lead-qualified-snapshot.spec.ts` |
| 租户隔离与 RLS | 所有数据库访问 | `packages/db/prisma/schema.prisma`、`packages/db/prisma/migrations/`、`prisma/prisma.service.ts` | `packages/db/test/*.rls.spec.mjs`（真库） |
| 模型网关与执行运行时 | 所有 LLM / embedding 调用 | `model-gateway/`、`model-runtime/model-execution-runtime.ts` | `model-gateway/model-router.spec.ts`、`model-gateway/model-transports.spec.ts` |
| 治理与文档校验 | `pnpm governance:verify`、`pnpm docs:verify` | `scripts/governance-verify.mjs`、`scripts/verify-docs.mjs`、`docs/governance/docs-verification-policy.json` | `scripts/governance-contracts.spec.mjs`、`scripts/governance-document-drift.spec.mjs` |

## 4. 维护规则

- 能力新增或入口迁移时更新对应行；测试锚点只列主要 spec，不追求全集。
- 本页与 [docs/modules/](../modules/) 的分工：模块文档写设计与验收，本页只写「从哪进、去哪找」。
- 路径变化必须同步本页；`pnpm docs:verify` 会校验链接可解析。
