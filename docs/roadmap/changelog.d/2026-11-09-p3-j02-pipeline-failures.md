---
date: 2026-11-09
title: P3 J02 pipeline failure attribution — typed codes replace the aggregate, quickScan heartbeat/cancel
---

- 起因：公司级深挖管线的 351 条 failed 全部写同一个 `COMPANY_PIPELINE_FAILED`（2026-11-08 只读审计：`last_error_code` 100% 聚合码），抓取失败、模型 429、预算截断、Temporal 超时无法区分；快扫活动 `quickJudgeBatch` 无心跳、无取消检查（实测 27.8 分钟超出 15 分钟 startToClose），批量/逐家失败也只写 `QUICK_JUDGE_FAILED`（设计 §4.3.5.1 / §4.3.9 W1/W2/W4，P3 J02）。
- 改动：
  - 新增 workflow 安全的纯函数分类器 `apps/api/src/temporal/pipeline-failure-taxonomy.ts`：沿 `ActivityFailure → ApplicationFailure/TimeoutFailure → cause` 链按 name/type/code/reasonCode/message-token 解析（不做自由文本 regex），映射 ProviderHttpError（429/402/401·403/5xx）、ProviderOutputError（NOT_JSON/TRUNCATED/SCHEMA_INVALID/ENUM_DRIFT/MODEL_REFUSAL）、ProviderIdentityError、ProviderTransportError、预算/控制面（`isExecutionControlError` 同款 control token：预算 → BUDGET_*、域 ACK/回执/围栏 → CONTROL_PLANE_REJECTED、租约 → LEASE_LOST）、SkillUnavailableError、Prisma P2034/P2028、Temporal 超时、EgressBlockedError；未知一律 `UNKNOWN_UPSTREAM`。
  - 新增活动边界包装 `apps/api/src/temporal/pipeline-failure-activity.ts`：worker 的 `DiagnosticFailureConverter` 会把普通 Error 的类名/消息全部脱敏（只剩 `applicationFailureInfo.type` 能过 Temporal 边界），故 `profileCompanyOnce`/`fitCompanyOnce`/`signalsCompanyOnce`/`contactsCompanyOnce` 统一把异常换成 `ApplicationFailure(type=<failure code>)`（保持 retryable，不改变现有重试次数；nonRetryable 矩阵留给 J22）。
  - 失败码表升 `failure-codes/v2`，新增 `PROVIDER_IDENTITY_MISMATCH`、`PROVIDER_TRANSPORT_FAILED`、`CONTROL_PLANE_REJECTED`（同步 `failure-codes.spec.ts` 快照与重试语义）。
  - workflow catch 用分类结果写 `mark('failed', { errorCode, failureStage })`；`updateCompanyJobStage` 扩展 `failureStage` 并写进 `run_event.payload`（不新增 DB 列/迁移），`last_error_code` 保持写具体码；`DEEP_STOPPED` 取消路径不变。
  - W4：`quickJudgeBatch` 活动开始与每批后 `heartbeat()`（池 500 家 × 8 家/批），批间检查 `cancellationSignal.aborted` 并抛 `CancelledFailure`；批量协议与逐家判定失败按分类码写 `last_error_code`/事件/轨迹，规则兜底的 `company_done` 事件附 `failureCode/failureStage`；`discovery.workflow.ts` 为快扫单独配置 `quickScanActs`（heartbeatTimeout 10 分钟，修 27.8 分钟 > 15 分钟 startToClose 的既有缺陷）。
- 测试：新增 `pipeline-failure-taxonomy.spec.ts`（映射表 100% 可达 + ActivityFailure/TimeoutFailure/普通 Error/控制面/未知/循环 cause 共 12 例）、`pipeline-failure-activity.spec.ts`（包装、取消透传、ApplicationFailure 保留）、`pipeline-failure-wiring.source.spec.ts`（聚合码字面量不得回归）；扩展 `discovery.run2.pipeline.workflow.spec.ts`（具体码 + stage、控制面不落 provider）、`discovery.run2.activities.spec.ts`（心跳次数、批间取消、逐家/批量失败码）；`discovery-workflow-knobs.replay.spec.ts` 5 例 replay 通过（heartbeatTimeout 不影响历史重放）；零容器全量单测与 `gctl check --fast` 全绿。
- 未做：按码收紧的 Temporal `nonRetryableErrorTypes` 重试矩阵与 failover 策略（J22）；`ProviderSettlementError`（MODEL_SETTLEMENT_*）暂按 `UNKNOWN_UPSTREAM` 显性上报、无专属码；`fit-judge.ts` 内部吞掉的模型错误（返回 null → 规则兜底）仍无法带出原始 cause，只能按批量失败码归因。
