# B2 落地设计 · 账本状态机四分 + 确定性错误 nonRetryable（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 `/home/xin/.claude/plans/handoff-acq-remediation-2026-11-08.md` WP B2（产品负责人 2026-11-08 批准 Phase 1 顺序 B1→B5）与协调计划 §0.7-H 架构审计 F4/F5；本 WP 是「卡死/重复付费」根因修复的账本侧。

## 1. 背景与活体证据

- **F5（确定性账本错误被当可重试）**：同一 `operation_key` 二次 reserve 必然撞同一行（REPLAY），但 `BudgetOperationReplayError` 是普通 Error，活动边界不标 nonRetryable → Temporal 按 maximumAttempts 反复重试，每次要么立刻撞同一行、要么把整段 15–30 分钟活动从头重跑。
- **F4（账本四态混淆）**：`settle` 双败（物理已成功、记账失败）后 model 路径不调 `markResultUnknown`，行留 `RESERVED`；一次 DB failover/连接重置即可永久锁死该 operation key。
- **活体证据（主会话提供，2026-11-07 16:35–18:20 UTC）**：worker 日志 `BudgetOperationReplayError: budget operation already exists without a durable result: <key>`；run 55c04316 的 deep 公司工作流 `5ce7dcf7/20148041/b6fc93aa` 以 `COMPANY_PIPELINE_FAILED` 终态；run 7662d391 空转约 95 分钟后被取消。

## 2. 四态语义与安全动作（实现并文档化，落 `docs/backend/execution-budget-ledger-states.md`）

| 状态 | 含义 | 谁写入 | 安全动作 | 清收/兜底 |
| --- | --- | --- | --- | --- |
| `RESERVED` | 已预留、物理结果未知 | reserve | 不得用同一 op key 重试（必撞 REPLAY）；确认未出网才可 release | B4 独立清收器按阈值释放/保守结清；B3 看门狗收尾 run |
| `RESULT_UNKNOWN` | 物理已成功但结果未存证（ACK 丢失等） | markResultUnknown（settle 双败/工件 ACK 未知） | 用绑定 artifact 精确结清；无 artifact 按预留额保守结清 | B4 清收器 |
| `SETTLED`（含 no-result 投影） | 结清；可能无 durable result | settle / settleArtifactManifest | 重放读回该行作为 remnant 吸收，不再出网 | — |
| `RELEASED` | 确认未出网 | release | 同 key 可再 reserve（attempt+1） | — |

## 3. 改动

1. **分类器**（新 `apps/api/src/temporal/deterministic-ledger-failure.ts`，纯函数）：
   - nonRetryable：`BudgetOperationReplayError`（remnant/live 均是确定性）、`BudgetExceededError`、`BudgetAccountUnavailableError`、`BudgetUnsettledOperationsError`、`ToolDurableResultProjectionError`、`ModelDurableResultProjectionError`、`ExecutionControlError` 的确定性码（白名单后缀：`_INVALID`、`_REQUIRED`、`_MISMATCH`、`_MIXED_*`、`_EXHAUSTED`、`_REUSED`、`_REVOKED`，加显式码表）。
   - 保持可重试：`BudgetStoreUnavailableError`、`EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`、一切 `*_UNAVAILABLE`（平台瞬时故障）、provider 429/5xx（既有 `upstream-unavailable-retry` 不动）。
   - 转换用 `ApplicationFailure.nonRetryable` / `fromError({nonRetryable:true})`，保留 type/code，`isExecutionControlError()` 语义不变（有测试钉住）。
2. **活动边界拦截器**（新 `deterministic-ledger-failure.interceptor.ts`，`ActivityInboundInterceptor`），注册到三个 Worker.create（`worker.ts` / `platform-worker.ts` / `dev-fast-lane-worker.ts`）：命中分类器的错误转 nonRetryable 后抛出，其余原样。
3. **settle 双败 → markResultUnknown**：
   - `router-model-gateway.ts` 成功路径：第二次 settle 失败 → `markResultUnknown(reservation)`（best-effort）→ 抛 `BudgetOperationReplayError`（行至少到 RESULT_UNKNOWN，不再是裸 RESERVED）。
   - `router-model-gateway.ts` 失败路径的 settle：失败 → `markResultUnknown`（best-effort）→ 仍抛原 provider 错误（语义不变）。
   - `tool-broker.ts` settle 双败：`markResultUnknown`（best-effort）→ 抛 `BudgetOperationReplayError`。
   - `markResultUnknown` 自身失败不掩盖主错误（仅 trace）。
4. **文档**：`docs/backend/execution-budget-ledger-states.md`（上表 + 可观测字段与对账入口）。

## 4. 测试（TDD）

- 分类器矩阵：每个错误类 → nonRetryable 与否；provider 429/5xx 不变；转换后仍满足/不满足 `isExecutionControlError` 的既有判定。
- 拦截器：命中转换（nonRetryable=true、type 保留）、未命中原样、嵌套 cause 命中。
- 网关：settle 两次失败 → `markResultUnknown` 恰 1 次 + 抛 replay error；失败路径 settle 失败 → `markResultUnknown` + 原 provider 错误；`markResultUnknown` 失败不掩盖。
- broker：settle 双败 → `markResultUnknown` + replay error。
- 四态矩阵：store 既有测试（reserve 撞 REPLAY、RELEASED 可再 reserve、RESULT_UNKNOWN 读回）与本 PR 的分类矩阵对齐；文档表逐态有用例指针。
- 验收（对主会话）：修复镜像上线后，新 run 触发 replay 场景时 activity attempt=1、run 终态 FAILED(stage=deep, errorType=BudgetOperationReplayError)、无空转；证据=run id + discovery_run 行 + 无 replay 错误日志。

## 5. 风险与回退

- 拦截器作用于所有域活动：分类白名单宁窄勿宽，`*_UNAVAILABLE` 一律不转；全量零容器单测 + 定向活动 spec 核对。回退=revert（纯代码，无迁移、无 schema 变更）。
- 两个 projection 错误本来就是 settled-no-result 的 definite failure（调用方通常吸收）；拦截器只影响「未被吸收、冒泡出活动」的情形——此时重试只会撞 remnant，转换后 fail-fast 是正确的。
