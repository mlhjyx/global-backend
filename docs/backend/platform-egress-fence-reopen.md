# 平台出网围栏的受审计重开（运维）

> 生命周期：`GUIDE`
> 生命周期依据：[出网围栏重开设计](../superpowers/plans/2026-11-01-egress-fence-reopen.md)（APPROVED）的 as-built 运维说明；迁移 `20261101010000_platform_egress_fence_reopen`

本页只讲一件事：一个被**签名撤销**置为 `DISABLED` 的平台出网围栏，如何用受约束、可审计的产品函数改回 `ACTIVE`。它不是「恢复 schedule 运行」：四个 Temporal schedule 仍是 paused；unpause 是产品负责人的单独决定。

## 1. 边界

- **只有库属主（owner）能执行** `reopen_platform_egress_fence_v1`。函数还要求 `session_user` 等于函数属主、且没有 `SET ROLE`。`PUBLIC`、`app_user`、四个运行角色、`execution_budget_platform_writer`、`runtime_platform_worker` 全部没有 `EXECUTE`，也没有审计表的任何表级权限。
- 平台写入者（被围栏的自动化）**不能**重开自己的围栏；不要为了「方便」给它 `GRANT EXECUTE`。
- 重开必须与一条**已提交的撤销回执**精确配对；没有可配对回执的围栏（例如只被旧的无签名 kill switch `fence_platform_schedule_v1` 关过）拒绝重开。
- 重开**不**安装或刷新 egress 策略。策略列缺失或漂移时，`authorize/claim` 与 readiness 仍会拒绝，不会产生出网。
- **禁止**用裸 `UPDATE platform_egress_schedule_fence` 代替本函数。那是带外操作：没有回执配对、没有 generation CAS、没有审计行；发生即按事故记录。

## 2. 前置

1. 数据库已应用迁移 `20261101010000_platform_egress_fence_reopen`，且运行镜像的 `migration_revision` 与库中最新的已完成迁移一致（否则 API 会报 `MIGRATION_REVISION_MISMATCH`）。迁移与换镜像必须在同一窗口，见 [Compose 项目名迁移](compose-project-migration.md) 与工作区 RUNBOOK「换后端运行时镜像」。
2. 已知要重开的围栏对应的撤销回执：`issuer`、`revocation_jti`、`fence_sequence`，以及当前 `generation`。只读核对（owner 连接）：

```sql
SELECT f.schedule_id, f.state, f.generation, f.fence_sequence,
       f.policy_artifact_sha256 IS NOT NULL AS policy_installed
  FROM platform_egress_schedule_fence f
 WHERE f.schedule_id = '<schedule>';

SELECT r.issuer, r.revocation_jti, r.schedule_id, r.fence_sequence, r.generation, r.reason
  FROM platform_revocation_receipt r
 WHERE r.issuer = '<issuer>' AND r.revocation_jti = '<revocation_jti>';
```

配对条件必须全部成立：围栏 `DISABLED`；回执的 `schedule_id`、`fence_sequence` 与围栏一致；回执 `generation` 等于围栏 `generation`（该撤销之后没有任何其他 fence 事件）。

## 3. 执行

以库属主连接执行：

```sql
SELECT * FROM reopen_platform_egress_fence_v1(
  p_schedule_id        => '<acq-sweep|intent-sweep|sanctions-refresh|patents-cache-refresh>',
  p_expected_generation => <当前 generation>,
  p_fence_sequence      => <回执的 fence_sequence>,
  p_revocation_issuer   => '<回执的 issuer>',
  p_revocation_jti      => '<回执的 revocation_jti>'::uuid,
  p_reopen_jti          => '<本次重开命令的 UUID，重试必须复用>',
  p_operator            => '<已认证控制面会话的批准人引用/工单号，1–200 字符>',
  p_reason_code         => '<POLICY_REENABLED|SECURITY_CLEARED|HOLD_RELEASED>'
);
```

- `p_reason_code` 必须与撤销原因对应：`POLICY_DISABLED → POLICY_REENABLED`、`SECURITY_RESPONSE → SECURITY_CLEARED`、`OPERATOR_HOLD → HOLD_RELEASED`。
- `p_operator` 是控制面**声明**的批准人，不是数据库可验证的身份。gain-saas 运营台接线时必须传自身已认证 operator 会话的身份与工单，不得让终端用户直接提供。
- `p_reopen_jti` 是命令身份：同一 JTI 重试（全部输入逐字相同）返回原事实 `replay = true`，不会再次推进 generation。不同事实复用同一 JTI 会被拒绝。
- 成功返回 `reopen_receipt_id`、新 `generation`（旧值 +1）、`committed_at`、`in_flight_attempts`、`blocked_attempts`、`replay`。`fence_sequence` 不变。

## 4. 验证

1. 围栏与审计行：

```sql
SELECT schedule_id, state, generation, fence_sequence, policy_artifact_sha256
  FROM platform_egress_schedule_fence WHERE schedule_id = '<schedule>';

SELECT id, reopen_jti, operator, db_principal, schedule_id, fence_sequence,
       revocation_receipt_id, revocation_jti, prior_generation, generation,
       reason_code, committed_at, in_flight_attempts, blocked_attempts
  FROM platform_egress_fence_reopen_receipt
 WHERE reopen_jti = '<本次 reopen_jti>'::uuid;
```

2. 策略列原本为空时，先用**新** generation 安装/刷新策略（owner）：

```sql
SELECT * FROM install_platform_egress_policy_v2(
  '<schedule>', <新 generation>,
  '<policy_artifact_sha256>', '<execution_envelope_sha256>', <required_cap_microusd>
);
```

3. readiness：managed runtime 上 `gctl health` 或 `curl -s http://127.0.0.1:3000/api/v1/health/ready`。`platform_budget_authority` 组件应从 `PLATFORM_AUTOMATION_<SCHEDULE>_BLOCKED` 回到 ok；该 schedule 行在 `platformAutomationReport` 中应为 `ISSUABLE`（或按设计 `INTENTIONALLY_DISABLED_NO_EGRESS`）。策略缺失/漂移时仍会是 `POLICY_UNAVAILABLE` / `POLICY_DRIFT`，先修策略，不要重复调用重开。

## 5. 错误码

| 错误                                         | 含义 / 处置                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID`   | 不是库属主，或调用前 `SET ROLE`。改用 owner 连接                                                                                                              |
| `PLATFORM_EGRESS_REOPEN_INVALID`             | 输入为空/格式非法/schedule 或 reason 不在允许集合                                                                                                             |
| `PLATFORM_EGRESS_REOPEN_REUSED`              | 同一 `reopen_jti` 但任一事实不同。换新 JTI 重新发起，或原样重试                                                                                               |
| `PLATFORM_EGRESS_REOPEN_SCHEDULE_UNKNOWN`    | 围栏表没有该 schedule                                                                                                                                         |
| `PLATFORM_EGRESS_REOPEN_NOT_DISABLED`        | 围栏已是 `ACTIVE`（可能已重开）。先只读核对，不要重复推进                                                                                                     |
| `PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT` | `expected_generation` 与当前不符，或已到 bigint 上限。重新读库后再决定                                                                                        |
| `PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE`      | 回执不存在/不是该 schedule 的这一次 fence 事件/该撤销之后又有 fence 推进了 generation。核对回执与 `fence_sequence`；旧 kill switch 关闭的围栏不在本函数能力内 |
| `PLATFORM_EGRESS_REOPEN_REASON_MISMATCH`     | 重开原因与撤销原因不对应                                                                                                                                      |

所有失败都不改变围栏与审计表。成功提交后审计行不可 `UPDATE`/`DELETE`/`TRUNCATE`（触发器抛 `PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE`）。

## 6. 回退

迁移 forward-only：没有 down。需要重新关闭时，走控制面签发**更高 `fence_sequence`** 的新撤销（`apply_platform_revocation_fence_v1`），不要改历史审计行。数据库级回退只能恢复迁移前备份，且会丢失其后的重开审计；恢复步骤见工作区 RUNBOOK「恢复数据库」。

## 7. 测试

```bash
# 零容器迁移契约（随 governance / gctl check 运行）
node --test scripts/platform-egress-fence-migration.spec.mjs

# 真库一次性容器（自有 pgvector:pg16，无网络、tmpfs、不发布端口）
PLATFORM_EGRESS_FENCE_REOPEN_DISPOSABLE_TEST=1 \
  node --test packages/db/test/platform-egress-fence-reopen.disposable.spec.mjs
```

## 8. dev 演示（需先部署含本迁移的镜像）

运行中的 managed runtime 只有在镜像 `migration_revision` 等于库中最新迁移时才会 ready。演示步骤：

1. 手动启动一次 `acq-sweep`（schedule 保持 paused），取得真实 `PLATFORM_GRANT`；
2. 用 gain-saas 的 `RevocationIssuer` / `RevocationClient` 投递真实撤销，确认围栏 `DISABLED`、`/health/ready` 503、`platform_budget_authority` 报 `PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED`；
3. 按 §3 调用 `reopen_platform_egress_fence_v1`（配对刚生成的回执）；
4. 按 §4 验证围栏、审计行与 readiness 恢复；如实记录 `in_flight_attempts`（重开不撤回已进入物理发送的调用）。

不在本页记录分支、镜像 digest、run id 等瞬时状态；现场值以当次只读回读为准。
