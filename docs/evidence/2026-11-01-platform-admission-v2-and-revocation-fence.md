# 平台运行准入 v2 与撤销 fence 实测（dev，有界）

本记录是 2026-10-31（UTC）/ 2026-11-01（+08）在本机 dev 运行时的实测：平台
schedule 的运行准入改走 v2 后第一次拿到真实 `PLATFORM_GRANT`，并用这条 Grant
补完 P7 遗留的撤销 fence 实测（reconciliation 里记为 L4-G23 的缺口）。它不生成
RuntimeEvidence，不改变 4 个平台 schedule 的 paused 状态，也不构成 Pilot/GA 或
生产证据。

## 绑定身份

- 引擎镜像：`ghcr.io/mlhjyx/global-backend@sha256:5f661ac07ce790a2a271d95e7149aec30e0317de5448c75f4c8cf93ffd766e16`（`7cea82b9`，#706）
- 迁移：`20261031140000_platform_writer_business_grants`（平台写入者 10 张业务表授权 + 迁移内 DO 自检）
- 权威方：`mlhjyx/gain-saas` `80ffdef`（#23）
- 命名空间：`platform-automation`；schedule `acq-sweep` 保持 paused，本次为手动启动

## 准入（v2）

手动输入取自 `DescribeSchedule('acq-sweep')` 的真实 action：

- workflowId `acq-sweep-manual-20261031T161409Z`，run `01a192bd-6a8d-7943-ae58-564a99e41080`
- `execution_budget_authority` 出现 `PLATFORM_GRANT` 行：jti `2401bb26-ab21-43b5-beba-277e52486667`，
  issuer `https://127.0.0.1:18446/execution-budget`，subject `schedule/acq-sweep`，
  `max_runs = 1`、`cap_per_run_microusd = 1`；工作流随后自然 COMPLETED。

## 撤销 fence

用上述真实 jti 走 gain-saas `RevocationIssuer` → `RevocationClient` →
`POST /api/v1/platform-authority/revocations`（content-type application/jose）：

- revocation_jti `ed59f901-2b9f-4cd8-b2ef-5e8d43019c00`，target_jti `2401bb26…`，reason `OPERATOR_HOLD`
- `execution_budget_authority_revocation`：authority 行 revoked_at `2026-10-31 16:14:52.14+00`
- `platform_revocation_receipt`：generation `1→2`、`in_flight_attempts = 0`、committed `2026-10-31 16:14:52.139902+00`
- `platform_egress_schedule_fence`：`acq-sweep` seq `1`、generation `2`
- ACK：后端 `fence-ack-jwks`（kid `fence-ack-20260922`）验签通过（iss `https://127.0.0.1:3443/`、aud `growthos:platform-authority-fence-ack`）

## 途中发现并修复的两处缺口

1. **平台 worker 的 Grant 信任根仍指 GrowthOS**：`backend-platform-worker-runtime.env`（本机密钥文件）的
   `EXECUTION_BUDGET_GRANT_JWKS_URI`/`_ISSUER` 指向已退役的 `https://127.0.0.1:18444/…`。平台 worker 的
   compose `env_file` 不继承 `backend-runtime.env`，P8 的 base 值没有兜住。准入表现为
   `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`。修复为 gain-saas 的 18446 值并重建容器；现场与回退见
   `_archive/p8-platform-worker-grant-trust-20261101/`（工作区归档，不在本仓）。
2. **gain-saas #23（`80ffdef`）**：平台 Grant 的 `cap_per_run_microusd`/`campaign_cap_microusd`/`max_runs`
   原以 JSON 数字签发，引擎校验器只接受规范十进制字符串（`EXECUTION_BUDGET_GRANT_INVALID`）；
   `RevocationIssuer` 的 `target_jti` 原为随机 UUID，后端 fence 按 `(issuer, jti)` 精确匹配已 committed
   的 `PLATFORM_GRANT`，永远命中不到。两处均已修复并有单测。

## fence 之后的 dev 环境恢复（如实记录）

撤销按设计把 `acq-sweep` 的出网围栏置为 `state = DISABLED`（generation 2）：这正是 `OPERATOR_HOLD` 的语义，但代价是
`platform_budget_authority` 报告 `PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED`、platform worker 不就绪、整体
`/health/ready` 为 503。**产品没有设计好的「重开」路径**（`install_platform_egress_policy_v2` 要求 state 为
`ACTIVE`；2026-10-01 归档也写明围栏只能前进，重开需要新代码/迁移）。

为把 dev 恢复到实测前的可用状态，在库属主（`global`）下执行了一次手工 UPDATE：
`platform_egress_schedule_fence` 中 `acq-sweep` 的 `state` 置回 `ACTIVE`、`generation` 2→3（打断一切观察过
generation 2 的在途尝试），`fence_sequence` 保持 1，策略三列未动。之后 `platform_budget_authority` 为 ok、四行
`ISSUABLE`/`INTENTIONALLY_DISABLED_NO_EGRESS`、整体 readiness 回到 ready。

这是**库属主带外操作**，不是产品能力：生产环境要重开被撤销的 schedule，需要先设计受审计的重开路径（谁有权、
如何与撤销请求配对、如何留痕），不应复制这段 SQL。

## 边界（这份记录不证明什么）

- 4 个 schedule 仍全部 paused；恢复运行是产品负责人的单独决定。
- **政策停用 → 撤销的自动触发尚未接线**：`RevocationIssuer` 目前除单测与本次手工脚本外没有调用方。
  本记录只证明「撤销一旦签发就能真正送达并 fence」，不证明自动撤销已上线。
- `in_flight_attempts = 0` 的一次提交不构成并发 egress 下 fence 行为的证明；那部分由
  `platform-revocation-http*` 组用例与后续工作覆盖。
- 手工运行使用的查询与输入均为该 schedule 的真实 action 与真实策略副本；没有 unpause、没有改策略。

## 复现要点

1. `r4-pki token writer` 取 writer 身份，从 `DescribeSchedule` 读 action 输入，手动
   `StartWorkflowExecution`（writer 需要 `platform-automation:write`）。
2. 准入成功后从 `execution_budget_authority` 取该 run 的 issuer/jti。
3. 以同一 issuer 与 jti 用 `RevocationIssuer.issue({ targetJti, targetIssuer, workflowRunId, fenceSequence })`
   签发，`RevocationClient.deliver` 投递，`FenceAckVerifier.verify` 验 ACK。
