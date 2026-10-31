# 出网围栏受审计重开：dev 数据克隆演示（有界）

本记录在 xin 的 dev 数据上演示迁移 `20261101010000_platform_egress_fence_reopen` 的重开能力：
把 `global_dev` 的**一次性克隆库**置于 2026-10-31 撤销 fence 实测后的真实 `DISABLED` 状态，
调用 `reopen_platform_egress_fence_v1` 配对真实撤销回执，并用运行镜像里的 readiness 计算代码
验证该 schedule 从 `BLOCKED` 回到 `ISSUABLE`。

它**不是** `/health/ready` 端点证据，也不证明镜像已发布或迁移已上 dev 运行库。4 个平台 schedule
仍全部 paused；本记录不 unpause、不改变任何运行状态。

## 绑定身份

- 工作分支：`claude/amazing-wozniak-4cbf1b`，基线 `origin/main@7a7ece0f`；迁移文件 SHA-256
  `6ee98b806e98de3f875eb5812e5a79dd7e2cf6e54f5f000ae1b2b5028fe5927e`（squash 合并后以 main 提交为准）。
- 运行镜像：`ghcr.io/mlhjyx/global-backend@sha256:5f661ac07ce790a2a271d95e7149aec30e0317de5448c75f4c8cf93ffd766e16`
  （源提交 `7cea82b9`）。readiness 计算代码来自该镜像的 `/app/apps/api/dist`，本 PR 未改这段代码。
- 克隆源：`global_dev`（121 MB，2026-10-31T17:0xZ `pg_dump` 只读导出）→ 一次性库
  `global_reopen_demo`，用后已 `DROP`。`global_dev` 自身零写入：演示前后 `acq-sweep` 都保持
  `ACTIVE`、generation 3、fence_sequence 1，且 `platform_egress_fence_reopen_receipt` 在
  `global_dev` 中不存在（迁移未应用）。
- 真实撤销回执（`global_dev` 与克隆库同 ID）：
  `platform_revocation_receipt.id = 4e43e818-a254-4df2-8617-cfc7d4d1eff9`，
  `revocation_jti = ed59f901-2b9f-4cd8-b2ef-5e8d43019c00`，
  `issuer = https://127.0.0.1:18446/execution-budget`，`schedule_id = acq-sweep`，
  `fence_sequence = 1`，`generation = 2`，`reason = OPERATOR_HOLD`，
  `committed_at = 2026-10-31 16:14:52.139902+00`（见
  [平台准入 v2 与撤销 fence 实测](2026-11-01-platform-admission-v2-and-revocation-fence.md)）。

## 步骤与结果

1. 克隆库应用本迁移：成功（迁移内 DO 自检通过；`reopen_platform_egress_fence_v1` 为 SECURITY DEFINER，
   `search_path = pg_catalog, public, pg_temp`；审计表 FORCE RLS）。
2. 重建事故状态：把克隆库 `acq-sweep` 从人工恢复后的 `ACTIVE`/generation 3 置回
   `DISABLED`/generation 2/fence_sequence 1——即真实回执产生时的状态。**这只发生在克隆库**。
3. 重开前 readiness（运行镜像的真实 `inspectPlatformBudgetAuthorityReadiness`，数据库探针为真实代码）：
   - 整体 `status = not_ready`；
   - `acq-sweep`：`BLOCKED`，`PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED`；
   - `intent-sweep` / `sanctions-refresh`：`ISSUABLE`；`patents-cache-refresh`：
     `INTENTIONALLY_DISABLED_NO_EGRESS`。
4. 以库属主调用：

```sql
SELECT * FROM reopen_platform_egress_fence_v1(
  p_schedule_id         => 'acq-sweep',
  p_expected_generation => 2,
  p_fence_sequence      => 1,
  p_revocation_issuer   => 'https://127.0.0.1:18446/execution-budget',
  p_revocation_jti      => 'ed59f901-2b9f-4cd8-b2ef-5e8d43019c00'::uuid,
  p_reopen_jti          => '20261101-0000-4000-8000-000000000001'::uuid,
  p_operator            => 'operator:dev-clone-demo-20261101',
  p_reason_code         => 'HOLD_RELEASED'
);
```

返回：`reopen_receipt_id = 120b4a0b-a536-4921-a0c8-6817dc5f624a`、`generation = 3`、
`committed_at = 2026-10-31 17:09:34.612746+00`、`in_flight_attempts = 0`、`blocked_attempts = 0`、
`replay = false`。

5. 回读围栏：`acq-sweep | ACTIVE | generation 3 | fence_sequence 1`，策略三列未变
   （`policy_artifact_sha256 = f9e95917…2db01b`、`required_cap_microusd = 1`）。
6. 审计行（`platform_egress_fence_reopen_receipt`）：`operator = operator:dev-clone-demo-20261101`、
   `db_principal = global`、`schedule_id = acq-sweep`、`fence_sequence = 1`、
   `revocation_receipt_id = 4e43e818-a254-4df2-8617-cfc7d4d1eff9`、
   `revocation_jti = ed59f901-…`、`prior_generation = 2`、`generation = 3`、
   `reason_code = HOLD_RELEASED`、`in_flight_attempts = 0`、`blocked_attempts = 0`。
7. 重开后 readiness：整体 `status = ready`；`acq-sweep` 变为 `ISSUABLE`
   （`PLATFORM_AUTOMATION_ACQ_SWEEP_ISSUABLE`），其余三行与重开前一致。
8. 重放与拒绝：同一 `reopen_jti` 与全部输入重发 → `replay = true`、generation 仍 3、审计行仍 1；
   换一个新 `reopen_jti` 再重开 → `PLATFORM_EGRESS_REOPEN_NOT_DISABLED`（围栏已 `ACTIVE`）。

## 边界（这份记录不证明什么）

- **不是 live `/health/ready`**：readiness 由运行镜像的编译产物在一次性克隆库上计算；外部探针
  `temporal_proof`、`issuer`、`revocation_delivery` 与 quote 认证被替身为 `ok`，数据库探针
  （平台写入者 attestation、`inspect_platform_egress_policy_v2`）与 quote/policy 计算是真实代码。
  live `/health/ready` 恢复需要先发布并切换含本迁移的镜像（`migration_revision` 必须等于库中
  最新迁移），那是产品负责人的单独决定。
- **DISABLED 状态是重建的**：live `acq-sweep` 已在 2026-10-31 由库属主手工恢复到 generation 3；
  克隆库按真实回执的 `generation = 2` 置回。演示没有签发新的真实 Grant/撤销（那会再次 fence
  live schedule），因此不证明新撤销命令与重开的组合，只证明重开与既有真实回执的配对。
- 不证明迁移已在 `global_dev` 应用；不证明镜像已发布；不构成 RuntimeEvidence、Pilot/GA 或生产证据。
- 4 个 schedule 仍 paused；重开 ≠ 恢复运行；重开不撤回已进入 `SENDING` 的物理调用（本次为 0）。

## 复现要点

1. `docker exec global-postgres pg_dump -U global -d global_dev | docker exec -i global-postgres psql -U global -d <一次性库>`；
2. 在一次性库应用 `packages/db/prisma/migrations/20261101010000_platform_egress_fence_reopen/migration.sql`；
3. 把 `acq-sweep` 置为 `DISABLED`/generation 2/fence_sequence 1；
4. 在 `global-platform-worker` 容器内用 `inspectPlatformBudgetAuthorityReadiness` + 真实 writer
   Prisma 客户端（数据库名换成一次性库）计算 readiness；外部探针替身返回 ok；
5. 以库属主执行上面的重开 SQL；重复第 4 步；
6. `DROP DATABASE <一次性库>`。
