# 工具预算账本的四个状态与安全动作

> 生命周期：`GUIDE`
> 生命周期依据：B2（2026-11-08，审计 F4/F5）落地时整理；`tool_budget_operation` 行状态机的现行为说明与运维处置手册。

## 状态一览

`tool_budget_operation.status` 有四个业务状态。下列「安全动作」是**重放安全**的判定：活动被 Temporal 重试或 workflow 重放时会带着同一个 `operation_key` 再进来，错误的安全动作会让 run 永久卡死或重复付费。

| 状态 | 含义 | 谁写入 | 安全动作 | 清收/兜底 |
| --- | --- | --- | --- | --- |
| `RESERVED` | 已预留、物理结果未知 | `reserve` | **不得**用同一 `operation_key` 再发起物理调用（reserve 命中会报 `BudgetOperationReplayError`）；确认未出网时可 `release` | 独立清收器按阈值释放/保守结清（B4）；卡死的 run 由 stale-run 看门狗收尾（B3） |
| `RESULT_UNKNOWN` | 物理已成功但结果未存证（ACK 丢失、settle 双败、工件 promote ACK 未知） | `markResultUnknown` | 用绑定的 expected artifact 精确结清（`loadResultUnknownArtifact` → `settleArtifactManifest`）；无 artifact 时按预留额保守结清 | 清收器（B4） |
| `SETTLED`（含无结果投影） | 已结清；`result_json` 可能为空（projection rejected 的定案失败） | `settle` / `settleArtifactManifest` | 重放读回该行作为 remnant 吸收，**不再出网**；调用方按 `replay`/`replayResult` 处理 | — |
| `RELEASED` | 确认未出网（控制拒绝/定案失败） | `release` | 同一 `operation_key` 可再 `reserve`（attempt+1，迁移 `20261015045032`） | — |

## 每次结算失败后的落点（B2 起）

- `settle` 第一次失败可能是提交后 ACK 丢失：以**字节一致的** operation/成本/投影重试一次是安全的（PostgreSQL 拒绝任何漂移）。
- 第二次仍失败（model 网关与 tool broker 同口径）：先尽力 `markResultUnknown`（物理结果未知 → 按预留额保守对待），再抛 `BudgetOperationReplayError`。
- `markResultUnknown` 自身失败：行留在 `RESERVED`，不掩盖主错误；由清收器兜底。
- 这些确定性错误在**活动边界**被统一标成 nonRetryable（`deterministic-ledger-failure.interceptor.ts`，挂在三个 worker 上），Temporal 不会再把重试预算烧在「同一行必撞」上；`*_UNAVAILABLE`（存储/平台瞬时故障）保持可重试。

## 可观测入口

- 行状态与时间：`tool_budget_operation(status, operation_key, reserved_microusd, updated_at)`。
- 失败归因：`ai_trace.meta.budgetDisposition`（`RELEASED_CONTROL_DENIAL` / `RELEASED_DEFINITE_FAILURE` / `SETTLED_NO_RESULT`）与 `budgetOperationId` 直连账本行；model 网关 settle 双败另见 ERROR trace（`BUDGET_SETTLE_FAILED`）。
- 清收结果：raw-retention sweep 的 `reconcileStaleToolBudgetOperations` 回执（`released`/`hasMore`），B4 起迁到独立 sweep。

## 相关测试

- `apps/api/src/temporal/deterministic-ledger-failure.spec.ts`（分类矩阵）
- `apps/api/src/temporal/deterministic-ledger-failure.interceptor.spec.ts`（活动边界转换）
- `apps/api/src/model-gateway/router-model-gateway.spec.ts` 与 `apps/api/src/tools/tool-broker.spec.ts`（settle 双败 → RESULT_UNKNOWN）
- `apps/api/src/tools/budget-store-rereserve.postgres.spec.ts`（RELEASED 再预留）、`artifact-budget-store.spec.ts`（RESULT_UNKNOWN 读回）
