---
date: 2026-11-08
title: Stop artifact failures from leaking bare RESERVED budget operations
---

- 起因：run aae4a06a（400 家规模快扫 + 信号阶段）以 `BudgetOperationReplayError / BUDGET_OPERATION_REPLAY_UNAVAILABLE` 终止。现场取证：`tool_budget_operation` 留下三行 `RESERVED attempt=1`、无 artifact 行；worker 日志同刻 `crawl4ai.render artifact settlement failed: GenericOperationArtifactError`；`generic_operation_artifact` 显示空结果对象（sha256=e3b0c442…，字节寻址共享）当日已有 http-get 1613 条 + crawl4ai-fetch 306 条 manifest，失败行创建时刻与一波空 artifact 并发持久化逐秒重合。根因：**wire 已跑过之后**的 artifact 持久化失败只在 `*_ACK_UNKNOWN` 两种错误码下把预留标记 RESULT_UNKNOWN（`markUnknownOnAmbiguousWrite` 谓词过窄）；`GENERIC_OPERATION_ARTIFACT_INVALID`/`STORAGE_UNAVAILABLE`/服务自身 `invalid()` 路径直接把预留留成裸 RESERVED——同 attempt-correlation 的重放永远读到「已存在但无持久结果」，按 #642 设计 'live' 保持可重试 → Temporal 每轮重试撞同一行 → 控制类错误把整个 run 打成 FAILED。小规模 run 不会出现「同一空对象被多工具并发 promote」，故只在 400 家量级暴露。
- 改动：
  - `GenericOperationArtifactService.persist`：整体包一层兜底——阶段内已按快照处理 `*_ACK_UNKNOWN`；其余 `ArtifactStorageError` 与 `GenericOperationArtifactError`（含各类 `invalid()` 校验失败）一律尽力复读同一预留并标 RESULT_UNKNOWN（spend 已发生、结果不可读；B4 收集器可回收），错误照旧上抛。**不再泄漏裸 RESERVED。**
  - `ToolBroker`：artifact 结算失败日志补 `error.message`（错误码）——此前只打 error.name，根因定位不可能。
  - 存储层：`recoverPromote` 在「IfNoneMatch 输了竞态但赢家对象尚不可见」时报告 `PROMOTE_ACK_UNKNOWN`（自竞态）而非 `INVALID`（契约不符）——并发空对象风暴不再被升级为契约类错误。
- 测试：service spec 新增 INVALID/STORAGE_UNAVAILABLE → markResultUnknown（无快照）+ post-promote invalid() 同样兜底；store spec 新增 precondition 竞态不可见 → PROMOTE_ACK_UNKNOWN（MemoryS3Client 新增 `precondition_uncommitted` 注入模式）。
- 未做：空对象并发 promote 的彻底消除（共享对象保留策略的串行化）——本 PR 保证其失败不再升级为 run 级故障；已留 RESERVED 残行由 B4 收集器/对账接管。
