# 出网围栏受审计重开：dev live 演示

本记录在 xin 的 dev managed runtime 上完成一次真实的「撤销 → 围栏 DISABLED → readiness 503 → 受审计重开 → readiness 恢复」闭环。4 个平台 schedule 仍全部 paused；本记录不 unpause、不启动 Temporal workflow、不构成 RuntimeEvidence 或 Pilot/GA 证据。

## 绑定身份

- 源码：`origin/main@d391a5f5`（含 #711 的迁移与 #714）。
- 运行镜像：`ghcr.io/mlhjyx/global-backend@sha256:c635911168537bd105e50c75d46e73d9807b79d867da937f02ea03ac72b9d7ed`；
  `/api/v1/health/build` 回读 `attested=true`、`build_sha=d391a5f5`、`built_at=2026-10-31T20:57:36Z`、
  `migration_revision=20261101010000_platform_egress_fence_reopen`。
- 发布：`Publish immutable runtime image` run 41241232596（workflow_dispatch，`d391a5f5`）成功；
  `gh attestation verify` 退出码 0。
- 切换：由另一个 root 进程执行的 `gctl switch-backend` 完成（归档目录
  `_archive/backend-runtime-switch-d391a5f5-xin-20261031`，root 0700，本会话无法读取其内部记录）。
  本记录绑定的是回读事实：三个 runtime 容器运行 `c63591116853`、数据库最新迁移为
  `20261101010000_platform_egress_fence_reopen`、gain-saas 部署绑定
  `backendSha=d391a5f5`、`observedAt=2026-10-31T21:09:27.899Z`、
  `validUntil=2026-11-07T21:09:27.899Z`。
- 数据库：`global_dev`（127.0.0.1:5432）。

## 步骤与结果

### 1. 真实 PLATFORM_GRANT 准入

在运行中的 `global-platform-worker` 容器内用镜像自带的编译产物执行一次真实准入
（`PlatformGrantAdmission`：quote → gain-saas mTLS `172.20.0.1:18448` 签发 → 验签 →
`ingest_and_admit_platform_execution_budget_run_v2`）；没有启动 Temporal workflow。

- `workflow_id = acq-sweep-manual-20261031T211119Z`
- `workflow_run_id = 45b0d4a2-fae2-4a94-947d-489de2ad4d4f`
- `execution_budget_authority.id = d4ce7c68-4e81-479f-8dcb-fbb186cbfc44`
- `jti = a2e42fa4-4910-4673-a401-d70515c09f40`
- `issuer = https://127.0.0.1:18446/execution-budget`
- `expires_at = 2026-10-31T21:16:20Z`、`replay = false`

### 2. 真实撤销与 ACK

用 gain-saas 的执行预算钥签发撤销命令并投递到
`POST /api/v1/platform-authority/revocations`（content-type `application/jose`）：

- `revocation_jti = 7dcc7c65-6558-4cb8-9000-c708f11d1fbe`
- `target_jti = a2e42fa4-4910-4673-a401-d70515c09f40`、`fence_sequence = 2`、`reason = OPERATOR_HOLD`
- 后端 200，ACK 用 `fence-ack-jwks` 验签通过：`backend_generation = 4`、
  `fence_sequence = 2`、`in_flight_attempts = 0`、
  `committed_at = 2026-10-31T21:11:26Z`。
- `platform_revocation_receipt.id = 17cdbcdb-2383-4bb5-a6f5-d58827a91510`，
  `generation = 4`。

### 3. 撤销后的围栏与 readiness

- `platform_egress_schedule_fence`：`acq-sweep | DISABLED | generation 4 | fence_sequence 2`。
- `/api/v1/health/ready`：HTTP 503，`status = not_ready`；
  `capabilities.platform_budget_authority = {status: failed, code: PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED}`；
  `components.platform_worker = {status: failed, code: PLATFORM_WORKER_NOT_READY}`；
  `platform_automation` 行：acq-sweep `BLOCKED`，其余 `ISSUABLE` / `INTENTIONALLY_DISABLED_NO_EGRESS`。
- platform worker 日志 21:11:30 停止 polling（`STOPPING → DRAINING → DRAINED → STOPPED`）。

### 4. 受审计重开

以库属主调用：

```sql
SELECT * FROM reopen_platform_egress_fence_v1(
  p_schedule_id         => 'acq-sweep',
  p_expected_generation => 4,
  p_fence_sequence      => 2,
  p_revocation_issuer   => 'https://127.0.0.1:18446/execution-budget',
  p_revocation_jti      => '7dcc7c65-6558-4cb8-9000-c708f11d1fbe'::uuid,
  p_reopen_jti          => '410058b3-bbf8-436e-9eca-1bb31f9b9d12'::uuid,
  p_operator            => 'operator:product-owner-approved-live-demo-20261101',
  p_reason_code         => 'HOLD_RELEASED'
);
```

返回：`reopen_receipt_id = f2876221-5989-40db-9705-072dc955979f`、`generation = 5`、
`committed_at = 2026-10-31T21:11:51.661558Z`、`in_flight_attempts = 0`、
`blocked_attempts = 0`、`replay = false`。

### 5. 重开后回读

- 围栏：`acq-sweep | ACTIVE | generation 5 | fence_sequence 2`；策略三列未变
  （`policy_artifact_sha256 = f9e95917…2db01b`、`required_cap_microusd = 1`）。
- 审计行 `platform_egress_fence_reopen_receipt`：`operator = operator:product-owner-approved-live-demo-20261101`、
  `db_principal = global`、`revocation_receipt_id = 17cdbcdb-2383-4bb5-a6f5-d58827a91510`、
  `revocation_jti = 7dcc7c65-…`、`prior_generation = 4`、`generation = 5`、
  `reason_code = HOLD_RELEASED`、`in_flight_attempts = 0`、`blocked_attempts = 0`。
- `/api/v1/health/ready`：HTTP 200，`status = ready`；
  `capabilities.platform_budget_authority = {status: ok}`；
  `components.platform_worker = {status: ok}`；`platform_automation` 行恢复为
  acq-sweep `ISSUABLE`（其余不变）。platform worker 于 21:12:16 重新创建 workflow bundle 并恢复 polling。

## 边界（这份记录不证明什么）

- 没有启动任何 Temporal workflow；Grant 是经真实准入代码（quote → gain-saas 签发 → 验签 →
  ingest/admit）写入的真实 `PLATFORM_GRANT`，但不是一次完整 workflow run。
- 撤销由手工运维脚本用真实执行预算钥签发；「政策停用 → 自动撤销触发」的运行时代码尚未部署到线上
  gain-saas（试运行记录见 [2026-11-01 平台撤销自动触发试运行](2026-11-01-platform-revocation-autotrigger-dryrun.md)）。
- 切换由另一个 root 进程完成；本记录绑定镜像、构建证明、迁移、部署绑定与运行容器回读，
  不复制 root-only 归档 README 的内容。
- 不证明其它 schedule、并发 egress、`in_flight_attempts > 0` 或生产环境；不构成 RuntimeEvidence、
  Pilot/GA。4 个 schedule 仍 paused；重开 ≠ 恢复运行。
- 已提交的 authority 行（已过期）、receipt 与重开审计行按 forward-only 保留，不删除。
- 本次使用的临时签发脚本已删除，不进入任何仓库。

## 复现要点

1. 发布并切换含 `20261101010000` 的镜像（`migration_revision` 等值检查）。
2. 在 platform worker 容器内用 `PlatformGrantAdmission` 对 `acq-sweep` 做一次真实准入，
   记录 issuer/jti/run。
3. 用真实执行预算钥签发 `fence_sequence = 当前 + 1` 的 `OPERATOR_HOLD` 撤销，投递到
   `/api/v1/platform-authority/revocations` 并验 ACK。
4. 观察到围栏 `DISABLED`、`/health/ready` 503 与 `PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED`。
5. 以库属主调用上面的重开 SQL（reason `HOLD_RELEASED`），回读围栏、审计行与 readiness。
