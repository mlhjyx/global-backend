---
date: 2026-11-08
title: Stop artifact failures from leaking bare RESERVED budget operations
---

- 起因：run aae4a06a（400 家规模）以 `BudgetOperationReplayError / BUDGET_OPERATION_REPLAY_UNAVAILABLE` 终止。现场取证：`tool_budget_operation` 留三行 `RESERVED attempt=1`、无 artifact 行；worker 日志同秒三次 `[tool-broker] ERROR crawl4ai.render artifact settlement failed: GenericOperationArtifactError`，且**没有** `[artifact] … persist failed` 行——异常发生在 adapter 的 payload 契约校验（`crawl4ai-render/v1` 对空/非 HTML 渲染体 `invalid()`，run 当时多站反爬失败返回空 HTML），**先于** GenericOperationArtifactService.persist；broker 的 artifact catch 只抛 `BudgetOperationReplayError(origin='live')`，预留留成裸 RESERVED → 同 attempt-correlation 重放永远读到「已存在但无持久结果」→ Temporal 重试撞同一行 → 控制类错误把 run 打成 FAILED。（并发共享空对象 promote 竞态是同时期暴露的次要触发面，一并硬化。）
- 改动：
  - `ToolBroker` artifact catch：无论失败发生在管线哪一层（adapter payload 校验 / service 校验 / store 竞态），都先尽力 `markResultUnknownAfterSettleFailure(reservation)`（已有 SERVICE 快照标记时由其幂等吸收），日志补错误码/消息与标记结果。**artifact 管线失败不再产生裸 RESERVED。**
  - `GenericOperationArtifactService.persist`：`*_ACK_UNKNOWN` 仍由阶段内带快照标记；其余 `ArtifactStorageError`/`GenericOperationArtifactError` 兜底标 RESULT_UNKNOWN 后再抛原错误（broker 层为最终保证，service 层保留以尽量带上快照）。
  - `recoverPromote`：IfNoneMatch 输竞态且赢家对象尚不可见 → `PROMOTE_ACK_UNKNOWN`（自竞态），不再误报契约类 `INVALID`；顺带删除已无意义的 `preconditionFailed` 参数。
- 效果与边界（如实声明）：
  - 收益：预留不再以裸 RESERVED 长期占 cap、也不会在收集器释放后因 D13 再预留而**二次物理调用**；账本状态真实（RESULT_UNKNOWN 可被 B4 收集器按阈值结清）。
  - 不变：同键重放的结局与之前一致（`reserve_tool_budget` 对任何已存在行都返回 REPLAY → broker 报 remnant/unavailable）——本 PR 不是让失败调用「自动成功」，而是消除「失败升级为 run 级故障 + 预留泄漏」的放大器。首次失败仍是 `origin='live'`（可重试，符合 #642 设计）。
  - 未覆盖（已知）：artifact 结算事务内抛出的 `ExecutionControlError`（`DURABLE_EXECUTION_RECEIPT_FACTS_INVALID/REQUIRED`、`DOMAIN_ACK_RECEIPT_REQUIRED`）发生在 service.persist 之外层，行为不变（仍会由 broker 外层路径上抛，行最终由收集器按阈值处理）；无快照的 RESULT_UNKNOWN 不可经 recoverUnknown 恢复、按预留上限结算（B4 语义，刻意保守）。
- 测试：service spec 更新旧契约断言（pre-ack/校验拒绝同样必须标 RESULT_UNKNOWN）+ 兜底自身失败仍抛原错误；store spec 新增 `precondition_uncommitted` 注入（412 且赢家不可见 → ACK_UNKNOWN）；broker spec 断言 artifact 失败必 markResultUnknown（含兜底自身失败的边界）。受保护文件 tool-broker.ts 已重钉 sha256 并在 PR 记录审查。
- 未做：adapter payload 契约（如空 HTML render）本身应当更早失败/降级的问题（属 discovery 侧语义，另议）；共享对象 promote 的彻底串行化。
