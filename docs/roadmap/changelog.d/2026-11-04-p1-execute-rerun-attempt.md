---
date: 2026-11-04
title: Rerun EXECUTED query plans with a fresh attemptId and carry taskRef on DiscoveryRunCompleted
---

- 起因：一次失败的执行会永久砖化计划——plan 收尾后变 EXECUTED，再 execute 恒 409 INVALID_STATE；#791 已让请求作用域接受 attemptId，但状态门仍挡着重跑（断点 B3/B13，产品负责人亲历「4 秒 PARTIAL 后无任何重试路径」）。经 P1 设计评审裁定：不新增独立 rerun 端点，放宽既有 execute 的状态门（改写 `docs/modules/discovery-qualification/technical.md` §6）。
- 改动：
  - `DiscoveryService.executePlan` 状态门改为 READY | EXECUTED；EXECUTED 且未带 attemptId → 409 `RERUN_REQUIRES_ATTEMPT`（DRAFT 等其余状态维持 INVALID_STATE）。凭新 attemptId 时 scope/事务结构不变：新请求哈希 → 新 Grant → 新预算账户 → 新 run/outbox。
  - `DiscoveryRunCompleted` payload additive 追加 `taskRef`：SaaS 在「引擎已建 run、BFF 丢响应」窗口据此回填 engineRunId（schemaVersion 2 不变，消费端容忍缺省）。
  - 控制器/操作描述/DTO 文档与引擎工作流过期注释同步；契约快照重导出（仅描述与 409 码变化，无 schema/枚举变更）。
- 测试：新增 `discovery.execute-rerun.spec.ts`（READY 旧行为不变；EXECUTED+attemptId 建 run 且 outbox v2；EXECUTED 缺 attemptId → 409 且不建 run/outbox；DRAFT+attemptId → INVALID_STATE）；`discovery.activities.spec` 增加 taskRef payload 用例（300/300）；request-scope 黄金向量不动；全量 `@global/api` 单测。
- 未做：独立 rerun 端点、引擎侧 attempt/rerunOf 落库（attempt 权威在 SaaS TaskRun，见 P1-G1）、`Idempotency-Key` 头与同 plan 并发 run 的 advisory lock（后续改造）；attemptId 缺省时引擎行为逐字节不变。
