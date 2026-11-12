---
date: 2026-11-12
title: Add a fail-closed payload gate for integration events
---

- 起因：2026-11-12 审计 P1-5（issue #1011）：13 个集成事件中只有 `SiteBuildCostSummaryUpdated` 在 relay 有运行期校验，其余事件即使 payload 不符合 `packages/contracts/events/payloads/` 的 schema 也会进入交付账本；`CandidateBatchCompleted` 的 schema 甚至没有消费者。
- 改动：
  - `relay/event-registry.ts` 增加 `LeadQualified`（v1/v2 最小结构）、`CandidateBatchCompleted`、`DeletionCompleted`、`SiteBuildCostSummaryUpdated` 四个 validator；其余 9 个集成事件显式登记为 `envelope-only`（仍要求 payload 是对象）。
  - `validateIntegrationEvent()` 在 relay 路由时统一执行；已注册但未分类的事件 fail closed（park），不再静默交付。
  - 新增 `event-registry.spec.ts` 锁定"每个集成事件必须有 validator 或 envelope-only 分类"及负向用例。
- 测试：contracts/db/api 构建通过；`event-registry.spec.ts` + `outbox-routing.spec.ts` + `outbox-dev-fast-lane.spec.ts` 共 64 tests passed；完整 CI 在 PR 上跑。
- 未做：没有为 envelope-only 的 9 个事件补完整 ajv schema（需要先定义 payload 契约）；SaaS 消费端仍只校验信封，跨仓合同 pin 的更新按发版列车执行。
