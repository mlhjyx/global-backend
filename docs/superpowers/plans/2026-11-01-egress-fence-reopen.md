# 平台出网围栏的受审计重开路径

> 生命周期：`APPROVED`
> 生命周期依据：父会话 2026-11-01 下达的施工任务（产品负责人确定的「把重开做成受审计能力」方向；不含 unpause schedule、发布镜像与恢复平台运行的授权）。实现按 DEC-AIDEV-004 自审自合；§2 的 owner-only 取舍沿用既有 `install_platform_egress_policy_v2` 的运维边界，不新增信任根。

事实基线：`origin/main@7a7ece0f`（#708 已合）。相关代码与迁移：`packages/db/prisma/migrations/20260907100000_platform_egress_fence/`、`20260908120000_platform_signed_revocation_receipt/`、`20260908130000_platform_egress_budget_policy_v2/`、`20260907110000_platform_egress_fence_privilege_hardening/`、`20260907120000_platform_egress_fence_readiness/`；现场经过见 [2026-11-01 平台准入 v2 与撤销 fence 实测](../../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md)。

## 0. 缺口

`platform_egress_schedule_fence` 是四个平台 schedule 的出网围栏。签名撤销（`apply_platform_revocation_fence_v1`）按设计把对应 schedule 的 `state` 置为 `DISABLED` 并推进 `generation`；此后：

- `install_platform_egress_policy_v2` 要求 `state = 'ACTIVE'`，不能用来重开；
- `authorize_platform_egress_v2` / `claim_platform_egress_send_v2` 同样要求 `ACTIVE`（`fence.state <> 'ACTIVE'` → `PLATFORM_EGRESS_NOT_AUTHORIZED` / `PLATFORM_EGRESS_SEND_CAS_REJECTED`）；
- 没有任何产品函数把状态改回 `ACTIVE`。2026-10-31（UTC）撤销 fence 实测后，只能由库属主手工 `UPDATE`（generation 2→3）恢复 dev，并如实记录为带外操作。

这条带外操作有三个问题：没有绑定到被撤销的那次撤销请求、没有 generation CAS、没有不可变留痕。本设计把它替换成一条受约束的产品能力。

## 1. 目标与非目标

**目标**

1. 新增一个 SECURITY DEFINER 函数 `reopen_platform_egress_fence_v1`，把「重开」从裸 `UPDATE` 变成一条有输入校验、与撤销回执精确配对、generation CAS、不可变审计的转换。
2. 审计行必须能回答：重开了哪个 schedule、配对的哪一条撤销回执（issuer/jti/`fence_sequence`）、重开前后 generation、谁批准（operator 声明 + 数据库 principal）、何时、当时的策略三列快照、在途/被阻断尝试数。
3. 保持撤销语义不变：不修改 `apply_platform_revocation_fence_v1`、不回滚撤销、不删除/改写 `platform_revocation_receipt`、不改变 ACK。
4. 迁移只能前进；重开失败时数据库与围栏状态零变化。

**非目标**

- 不 unpause 任何平台 schedule（Temporal schedule 的 paused 是独立状态；重开 ≠ 恢复运行）。
- 不自动重开；不因撤销原因（`POLICY_DISABLED` / `SECURITY_RESPONSE` / `OPERATOR_HOLD`）到期而自动解除。
- 不为「由旧的无签名 kill switch `fence_platform_schedule_v1` 关闭的围栏」伪造撤销回执；没有可配对的回执就拒绝。
- 不新增 HTTP 端点、machine profile、JOSE 命令类型或数据库凭据；gain-saas 运营台的按钮/端点接线是后续独立变更（本函数已为其预留 `operator` 与 `reopen_jti` 两个审计输入）。
- 不安装/刷新 egress 策略。重开只恢复围栏状态；策略列缺失或漂移仍由 `install_platform_egress_policy_v2` 与 readiness 各自把关。

## 2. 谁能重开：库属主运维身份，而不是平台写入者

**决定：只有数据库属主（owner）能执行 `reopen_platform_egress_fence_v1`。** 函数内部断言 `session_user` 等于函数属主，且 `current_setting('role', true)` 为 `none`（沿用 `install_platform_egress_policy_v2` 的 principal 检查）。函数对 `PUBLIC`、`app_user`、`runtime_api`、`runtime_worker`、`runtime_outbox_relay`、`execution_budget_platform_writer`、`runtime_platform_worker` 全部 `REVOKE ALL`，且**不向任何角色 GRANT EXECUTE**。

理由：

- **围栏不能由被围栏的自动化自己打开。** `execution_budget_platform_writer` 是平台 worker 的数据库身份，也是当前唯一能调用 `fence_platform_schedule_v1` 与 `apply_platform_revocation_fence_v1` 的角色。如果把重开也授予它，一个被攻陷的 worker 就能撤销自己的撤销，围栏失去意义；保持「writer 只能加限制、不能减限制」的不对称性。
- **不新增信任根与凭据。** 现有运维边界就是库属主：2026-10-01 的 egress 策略安装、2026-10-31 的带外恢复都由它执行，gain-saas 运营域也已经持有引擎库的 owner 连接池（`OPS_OWNER_DATABASE_URL`，`PgFenceStore` 用它调用 `install_platform_egress_policy_v2`）。本函数复用同一条边界，不引入新的机器身份或密钥。
- **人身份由控制面认证，数据库只记录声明。** 数据库无法验证「谁是人」；`operator` 参数记录控制面（gain-saas `role=operator` 会话）传入的批准人引用/工单号，`db_principal` 记录实际数据库登录名，`committed_at` 记录事务内事实时间。审计的可信度来自 owner 边界 + 不可变表 + 与撤销回执的结构性绑定，而不是把字符串当身份证明。后续若需要签名命令，可在不改 SQL 函数的前提下加一层 JOSE 接收端。

被否决的替代：

| 方案                                    | 否决理由                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 授予 `execution_budget_platform_writer` | 被围栏方自行解除围栏，破坏撤销的不可逆性假设                                                          |
| 新 NOLOGIN 运维角色 + 新数据库凭据      | 新增凭据要进密钥清单、备份与轮换；而 gain-saas 已持 owner 连接，权限面没有实际收窄                    |
| 新 signed reopen 命令（JOSE，类似撤销） | 需要新 typ/aud/密钥用途、接收端、验签与限流；对「恶意 owner」没有额外防护，当前阶段收益不足，留作后续 |
| 继续裸 `UPDATE`                         | 无绑定、无 CAS、无留痕，正是本设计要消除的带外操作                                                    |

## 3. 与撤销请求配对：靠 `(schedule_id, fence_sequence, generation)` 三元组

撤销回执 `platform_revocation_receipt` 已经保证：

- `(issuer, revocation_jti)` 唯一；
- `(schedule_id, fence_sequence)` 唯一；
- 每次 `apply_platform_revocation_fence_v1` 在锁住 fence 行后把 `generation` 加一并把 `fence_sequence` 推到命令里的新序号。

因此一条撤销回执精确对应「某 schedule 的某一次 fence 事件」。重开函数的配对条件是**全部成立**：

1. fence 行存在、`state = 'DISABLED'`；
2. `fence.generation = p_expected_generation`（调用方 CAS 输入）；
3. 存在回执 `R = (p_revocation_issuer, p_revocation_jti)`，且 `R.schedule_id = p_schedule_id`；
4. `R.fence_sequence = p_fence_sequence = fence.fence_sequence`（回执就是当前围栏序号对应的那一次撤销）；
5. `R.generation = fence.generation`（该回执之后没有任何其他机制推进过 generation）。

第 5 条是关键：`fence_platform_schedule_v1`（旧的无签名 kill switch）只加 generation、不动 `fence_sequence`。如果它在撤销之后又关过一次，`fence.generation > R.generation`，本函数拒绝 `PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE`，不会把「无签名的第二次关闭」当成可重开的撤销事件。

`fence_sequence` **不因重开而改变**：它属于控制面撤销命令的单调序号，重开不是一次撤销，不能消耗或推进它。每次撤销序号至多对应一条重开审计行（唯一约束 `(schedule_id, fence_sequence)`）；要再次关闭必须由控制面签发更高 `fence_sequence` 的新撤销。

重开原因与撤销原因必须对应（防止「以 HOLD_RELEASED 重开 SECURITY_RESPONSE」这类错配）：

| 撤销 `reason`       | 允许的重开 `reason_code` |
| ------------------- | ------------------------ |
| `POLICY_DISABLED`   | `POLICY_REENABLED`       |
| `SECURITY_RESPONSE` | `SECURITY_CLEARED`       |
| `OPERATOR_HOLD`     | `HOLD_RELEASED`          |

## 4. generation 如何前进

一次成功重开在锁住 fence 行后：

- `generation = generation + 1`（检查不是 `9223372036854775807`）；
- `state = 'ACTIVE'`；
- `fence_sequence` 不变；
- `updated_at = clock_timestamp()`；
- 把该 schedule 上 `generation < 新 generation` 且仍为 `AUTHORIZED` 的尝试置为 `BLOCKED`（`outcome_meta.reason = 'REOPEN_GENERATION_ADVANCED'`）。正常路径下撤销已经把 `AUTHORIZED` 全部阻断，这里是防御性的二次收口；计数写入审计行。
- 统计并记录 `state = 'SENDING'` 的在途尝试数。重开**不**撤回已经进入物理发送的调用，也不等待它们；这与撤销回执的 `in_flight_attempts` 口径一致。

generation 前进使所有观察过旧 generation 的授权/发送 CAS 失效（`claim_platform_egress_send_v2` 要求 `attempt.generation = fence.generation`），新授权拿到新 generation。重开后 `install_platform_egress_policy_v2` 可以用新 generation 作为 expected 值安装/刷新策略。

并发正确性：重开与新撤销都锁同一行 fence。撤销先到 → 重开看到更高 `fence_sequence`/generation，拒绝；重开先到 → 撤销照常把围栏重新置为 `DISABLED`，重开被更新的撤销覆盖。两种顺序都保持「撤销最后生效」。

## 5. 留痕

新表 `platform_egress_fence_reopen_receipt`（一张表只记成功提交的重开；失败不写行）：

| 列                                                                               | 含义                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `id UUID`                                                                        | 重开回执主键（函数返回值）                                                       |
| `reopen_jti UUID`                                                                | 调用方命令身份；唯一；同 JTI 重放返回原事实                                      |
| `operator VARCHAR(200)`                                                          | 控制面声明的批准人/工单引用（去首尾空白、无控制字符）                            |
| `db_principal VARCHAR(200)`                                                      | 实际 `session_user`（owner 边界的事实记录）                                      |
| `schedule_id VARCHAR(191)`                                                       | 四个 schedule 之一                                                               |
| `fence_sequence BIGINT`                                                          | 配对的撤销序号；与 `schedule_id` 唯一                                            |
| `revocation_receipt_id UUID`                                                     | 外键到 `platform_revocation_receipt(id)`                                         |
| `revocation_issuer VARCHAR(2048)` / `revocation_jti UUID`                        | 配对的撤销身份                                                                   |
| `prior_generation BIGINT` / `generation BIGINT`                                  | 重开前后；约束 `generation = prior_generation + 1`                               |
| `reason_code VARCHAR(80)`                                                        | `POLICY_REENABLED` / `SECURITY_CLEARED` / `HOLD_RELEASED`                        |
| `policy_artifact_sha256` / `execution_envelope_sha256` / `required_cap_microusd` | 重开时 fence 上的策略快照；三列同时为空或同时非空（重开不要求策略已安装，见 §7） |
| `committed_at TIMESTAMPTZ(6)`                                                    | 事务内事实时间，不是提交时间；外层提交后才对外可见                               |
| `in_flight_attempts BIGINT` / `blocked_attempts BIGINT`                          | 重开时的 `SENDING` 数与被本次 generation 推进阻断的 `AUTHORIZED` 数              |

表的性质：

- `ENABLE` + `FORCE ROW LEVEL SECURITY`；对所有运行角色 `REVOKE ALL`（包括平台写入者）；只有 SECURITY DEFINER 函数与 owner 能写。
- `BEFORE UPDATE OR DELETE` 与 `BEFORE TRUNCATE` 触发器直接抛 `PLATFORM_EGRESS_REOPEN_RECEIPT_IMMUTABLE`；撤销/回滚只能靠恢复备份，不能删历史。
- 表注释写明「直接 DML 是政策违规」，与 `platform_revocation_receipt` 的不可变语义一致。

重放语义：同 `reopen_jti` 且全部输入逐字相同 → 返回已存事实 `replay = true`，不再次推进 generation；任何字段不同 → `PLATFORM_EGRESS_REOPEN_REUSED`。重放查询在 advisory lock 下先于 fence 锁执行，因此重复提交即使发生在围栏后来又被撤销之后，也只读回历史事实。

## 6. 函数契约与 fail-closed 条件

```
reopen_platform_egress_fence_v1(
  p_schedule_id TEXT,
  p_expected_generation BIGINT,
  p_fence_sequence BIGINT,
  p_revocation_issuer TEXT,
  p_revocation_jti UUID,
  p_reopen_jti UUID,
  p_operator TEXT,
  p_reason_code TEXT
) RETURNS TABLE(reopen_receipt_id UUID, generation BIGINT, committed_at TIMESTAMPTZ,
                in_flight_attempts BIGINT, blocked_attempts BIGINT, replay BOOLEAN)
```

| 条件                                                                                            | 错误码                                       |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 非 owner、或 `SET ROLE` 后调用                                                                  | `PLATFORM_EGRESS_REOPEN_PRINCIPAL_INVALID`   |
| 任一输入为空/格式非法/schedule 不在四个之内/reason 不在三个之内                                 | `PLATFORM_EGRESS_REOPEN_INVALID`             |
| 同 `reopen_jti` 但任一事实不同                                                                  | `PLATFORM_EGRESS_REOPEN_REUSED`              |
| schedule 无围栏行                                                                               | `PLATFORM_EGRESS_REOPEN_SCHEDULE_UNKNOWN`    |
| 围栏不是 `DISABLED`（含已重开）                                                                 | `PLATFORM_EGRESS_REOPEN_NOT_DISABLED`        |
| `expected_generation` 与当前不符，或 generation 已到 bigint 上限                                | `PLATFORM_EGRESS_REOPEN_GENERATION_CONFLICT` |
| 回执不存在/schedule 不符/`fence_sequence` 不符/`generation` 不符（含被旧 kill switch 二次关闭） | `PLATFORM_EGRESS_REOPEN_UNPAIRED_FENCE`      |
| 重开原因与撤销原因不匹配                                                                        | `PLATFORM_EGRESS_REOPEN_REASON_MISMATCH`     |

所有错误都 `ERRCODE = 'P0001'`，与既有平台函数一致；函数内不吞错、不返回布尔假。

## 7. 策略列缺失时是否允许重开

允许。撤销可以在策略安装之前发生（此时 fence 的三列策略摘要为 NULL）。如果重开要求策略非空，而 `install_platform_egress_policy_v2` 又要求 `ACTIVE`，就会形成死锁，只能再次带外 `UPDATE`。允许重开后：

- `authorize_platform_egress_v2` / `claim_platform_egress_send_v2` 在策略列为空或与引擎计算值不符时仍然拒绝（`PLATFORM_EGRESS_POLICY_UNAVAILABLE` / `PLATFORM_EGRESS_POLICY_DRIFT`），**不会产生任何出网**；
- readiness 仍报告 `POLICY_UNAVAILABLE` / `POLICY_DRIFT`，直到 owner 用新 generation 调用 `install_platform_egress_policy_v2` 安装策略。

因此「重开」只解除围栏这一道门，不绕过策略、预算、授权与 readiness 中的任何其他门。

## 8. 迁移、权限与自检

迁移 `20261101010000_platform_egress_fence_reopen`（forward-only）：

1. 建表、约束、索引、注释、RLS、不可变触发器；`REVOKE ALL` 给所有运行角色。
2. 建函数 `reopen_platform_egress_fence_v1`：`SECURITY DEFINER`、`SET search_path = pg_catalog, public, pg_temp`、表引用全部 schema 限定、owner principal 断言、advisory lock（同 `reopen_jti`）、fence 行锁、回执配对、generation CAS、attempt 收口、审计插入。
3. `REVOKE ALL ON FUNCTION ... FROM PUBLIC, app_user, runtime_api, runtime_worker, runtime_outbox_relay, execution_budget_platform_writer, runtime_platform_worker`；**不 GRANT**。
4. 迁移内 `DO` 自检（fail closed）：
   - 函数 `prosecdef = true`、`proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']`；
   - 函数属主是 superuser 或 `BYPASSRLS`（FORCE RLS 表上没有 policy，属主必须能绕过 RLS，否则函数运行时静默看不到行）；
   - 上述七个角色对函数无 EXECUTE、对审计表无任何表级权限；
   - 审计表 `relrowsecurity AND relforcerowsecurity`，两个不可变触发器存在；
   - `platform_egress_schedule_fence` 仍是四行。

权限清单 `docs/governance/app-user-table-privileges.json` 同步新增 `"platform_egress_fence_reopen_receipt": []`（真库一致性用例会逐表比对）。

## 9. 验证

- **零容器**：`scripts/platform-egress-fence-migration.spec.mjs` 追加迁移文本契约（函数名、owner-only、七个角色 REVOKE 且无 GRANT、审计表/触发器、配对与 generation 断言、reason 映射、DO 自检存在）。该 spec 由 `scripts/governance-contracts.spec.mjs` 导入，随 `pnpm governance:verify` 与 `gctl check` 运行。
- **真库（一次性容器）**：`packages/db/test/platform-egress-fence-reopen.disposable.spec.mjs`，自建 `pgvector/pgvector:pg16`（`--network=none`、tmpfs、不发布端口、显式 opt-in 环境变量），从空库跑到本迁移，覆盖：
  1. 成功重开：真实 `PLATFORM_GRANT` 行 → `apply_platform_revocation_fence_v1` → fence `DISABLED` → 重开 → `ACTIVE`、generation +1、`fence_sequence` 不变、审计行字段逐项正确、`SENDING` 保留、遗留 `AUTHORIZED` 被阻断；
  2. 同 JTI 重放与篡改拒绝；并发同 JTI 只产生一条非重放事实；
  3. 无回执（旧 kill switch）、回执 schedule/序号/generation 不符、二次关闭后重开、已 ACTIVE、expected generation 不符、reason 错配、非法输入全部拒绝且零副作用；
  4. 同 schedule 两个不同 JTI 并发重开只有一个成功；
  5. writer/app_user/其他 superuser（`session_user` 不是 owner）、`SET ROLE` 路径全部不能执行；函数 ACL/`search_path`/审计表 RLS 与不可变触发器；
  6. `ROLLBACK` 后 fence 与审计表零变化；
  7. 重开后 `inspect_platform_egress_policy_v2` 返回 `ACTIVE` + 新 generation，策略快照与安装值一致。
- **dev 演示**：见 §10。4 个 schedule 保持 paused；演示不 unpause、不发布镜像。

## 10. dev 演示与发布门槛

在运行中的 managed runtime 上演示「重开 → readiness 恢复」需要数据库最新迁移与运行镜像的 `migration_revision` 精确一致（`runtime-readiness.service.ts` 的 `MIGRATION_REVISION_MISMATCH` 检查是等值比较）。因此：

1. 合并后由产品负责人决定是否发布新镜像（`workflow_dispatch` 的 main-only 发布工作流）并 `gctl switch-backend`；这是**独立授权**，不在本设计的施工范围内。
2. 部署该镜像后，在 dev 上：手动启动一次 `acq-sweep`（保持 schedule paused）→ gain-saas 签发真实 `PLATFORM_GRANT` → 投递真实撤销 → 观察 `/health/ready` 503 / `platform_budget_authority` BLOCKED → 以 owner 调用 `reopen_platform_egress_fence_v1`（配对刚生成的撤销回执）→ 观察 `/health/ready` 恢复 ready、四行 readiness 回到 `ISSUABLE`/`INTENTIONALLY_DISABLED_NO_EGRESS`，并回读审计行。
3. 在该部署发生前，可在 dev 数据的**一次性克隆库**上完成同一 SQL 序列（真实回执 + 真实策略列），并用本仓的 readiness 计算代码（`inspectPlatformBudgetAuthorityReadiness`）对克隆库验证行状态从 `BLOCKED` 变回 `ISSUABLE`；这只能算 development-runtime observed，不冒充 `/health/ready` 端点证据。

## 11. 风险与回退

| 风险                                               | 处置                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| owner 仍可直接 `UPDATE` 绕过本函数                 | 无法在数据库内阻止属主；审计表 + 运行手册把直接 DML 定义为政策违规，发生即按事故记录并补录原因。本设计消除的是「产品没有路径」这一根因，不宣称能防恶意 owner |
| 重开后策略未安装/已漂移                            | 出网仍被 v2 函数与 readiness 拒绝；owner 用新 generation 安装策略                                                                                            |
| 重开时不撤回已 `SENDING` 的物理调用                | 与撤销口径一致；审计行记录 `in_flight_attempts`，不宣称撤销了已发出的调用                                                                                    |
| 旧 `fence_platform_schedule_v1` 关闭的围栏无法重开 | 有意 fail closed；需要新的签名撤销回执（先有一次可准入的 run）或按事故处理                                                                                   |
| 回退                                               | 迁移 forward-only：不删表、不改撤销语义；停用该函数只需停止调用并把围栏保持在 `DISABLED`。数据库回退只能恢复迁移前备份，且会丢失其后审计行                   |

## 12. 施工注记

- 迁移时间戳 `20261101010000`（本地 2026-11-01 01:00，晚于 `20261031140000_platform_writer_business_grants`）。
- 函数只按名称 `reopen_platform_egress_fence_v1` 暴露；不创建 `reopen_platform_egress_fence`（无版本）别名，避免无版本入口。
- 审计表的 `operator` 是声明值，不是身份证明；控制面接线时必须传自身已认证会话的身份，不得接受终端用户直接提供的任意字符串。
- 本次不新增 TypeScript 调用方；gain-saas 运营台/CLI 的接线与对应审计（其侧 `r4EgressInstallAudit` 模式）是后续变更。

## 13. 施工与验证记录（2026-11-01）

- 迁移、零容器契约测试与一次性 PostgreSQL 真库测试已按 §8/§9 落地；`gctl check` 全绿。
- dev 数据克隆演示已完成：在 `global_dev` 的一次性克隆库上应用本迁移、重建 2026-10-31 的真实
  `DISABLED` 状态、用真实撤销回执调用重开，运行镜像的 readiness 计算从 `not_ready`/`BLOCKED`
  回到 `ready`/`ISSUABLE`。记录与边界见
  [出网围栏受审计重开：dev 数据克隆演示](../../evidence/2026-11-01-egress-fence-reopen-dev-clone.md)。
- live `/health/ready` 演示仍待产品负责人决定发布/切换含本迁移的镜像；本 PR 不发布、不 unpause、
  不改 `global_dev`。
