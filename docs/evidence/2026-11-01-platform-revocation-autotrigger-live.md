# 平台撤销自动触发：dev live 闭环（绑定撤销 → ACK → 受审计重开）

本记录在 xin 的 dev 环境完成「部署绑定显式撤销 → gain-saas 自动产生撤销请求 → 用真实 live Grant 投递 → 后端 fence 提交 → ACK → 受审计重开 → readiness 恢复」的完整闭环。这是 P9（gain-saas #25）在**线上服务实例**上的首次成功 fence/ACK，也是 [D4](../superpowers/plans/2026-11-01-platform-revocation-autotrigger.md) 所述「重开路径上线后自动来源直接投递」开关的首次启用。4 个 Temporal schedule 仍全部 paused；本记录不 unpause、不构成 RuntimeEvidence 或 Pilot/GA 证据。

## 绑定身份

- 后端源码基线：`origin/main@da6095f2`（运行镜像 `d391a5f5` / `sha256:c635911168537bd105e50c75d46e73d9807b79d867da937f02ea03ac72b9d7ed`，`migration_revision=20261101010000_platform_egress_fence_reopen`，attested）。
- gain-saas：`main@a8d9340`（PR #25），线上 `gain-saas-web` 重建 dist 后重启；`r4_revocation_sequence` 事前 next 值：acq-sweep/intent-sweep/sanctions-refresh 均 3（02:36 试运行消耗），后端 acq-sweep `fence_sequence=1`，首请求分配 3（>1，合法，无需人工 seed）。
- 数据库：`global_dev`（127.0.0.1:5432）与 `gain_saas`（127.0.0.1:5433）。

## 开关（运维窗口，2026-10-31T22:03Z）

`gain-saas/.env` 增加（重启后日志确认「撤销投递循环已启动（每 5000 ms，自动确认=true）」「部署绑定撤销监视已启动（每 15000 ms）」）：

```text
R4_REVOCATION_TRIGGER_ENABLED=true
R4_REVOCATION_AUTO_CONFIRM=true
```

`AUTO_CONFIRM=true` 的依据是设计 D4：受审计重开路径（#711）已在同一镜像的迁移 `20261101010000` 中上线。开关启用后自动来源（政策停用/绑定撤销）的请求直接投递；操作员发起的请求不受此开关影响。

## 步骤与结果

1. **真实 live Grant**：以 writer 身份从 `DescribeSchedule('acq-sweep')` 取真实 action 输入，手动启动
   `acquisitionSweepWorkflow`（workflowId `acq-sweep-manual-20261031T220317Z`，run `01a193fd-103f-7172-a410-04b721c728ed`）。
   准入 v2 成功：`execution_budget_authority` 行 jti `ccc49a1c-254e-4163-9455-f64bf3af10c8`（issuer
   `https://127.0.0.1:18446/execution-budget`），`r4_platform_grant.expires_at = 2026-11-01T06:08:18+08`。
2. **绑定显式撤销**：在 `gain-saas/deploy/r4/deployment-binding.json` 写入 `revokedAt = 1793484214045`
   （未写 `revokeReasonCode`，按实现默认 `SECURITY_RESPONSE`；撤销者/备注字段亦未写，默认 `binding`/「部署绑定显式撤销」）。
   绑定文件每次被重新读取，watcher 15s 轮询发现撤销。
3. **自动请求与投递**：watcher 为三个有 egress 的 schedule 各产生一条 `BINDING_REVOKED` 请求（dedupe
   `binding-revoked:<schedule>:<revokedAt ISO>`，重复轮询幂等）。投递循环 5s：
   - `acq-sweep`：请求 `d13f2255-66ad-4daf-8f08-d25df48f114f`，attempt 1，`revocation_jti ca11e502-46ff-486f-acdc-d4d611d07662`，
     target `ccc49a1c…`（live Grant），HTTP 200，**ACKED**；
   - `intent-sweep` / `sanctions-refresh`：无 live Grant → `NO_LIVE_TARGET`（终态，不挂起、不计积压）。
4. **后端 fence 与回执**：`platform_egress_schedule_fence` acq-sweep `DISABLED`、generation 6、fence_sequence 3；
   `platform_revocation_receipt` `ca11e502…`、target `ccc49a1c…`、reason `SECURITY_RESPONSE`、generation 6、
   `in_flight_attempts 0`、committed `2026-10-31T22:03:39.668252Z`。期间 `/health/ready` 为 503
   （`PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED`，预期副作用，客户写入按 #627/D3 不受影响）。
5. **恢复绑定信任**：删除 `revokedAt`（文件回到实测前内容，`validUntil` 2026-11-07T21:09Z 不变）；watcher 不再产生请求。
6. **受审计重开**：库属主执行 `reopen_platform_egress_fence_v1(schedule='acq-sweep', expected_generation=6,
   fence_sequence=3, revocation_issuer='https://127.0.0.1:18446/execution-budget', revocation_jti='ca11e502…',
   reopen_jti='b96bfc75-3452-4be1-9d21-eb682c8fb493', operator='ops-window-2026-11-01 auto-trigger live test',
   reason_code='SECURITY_CLEARED')`：返回 reopen receipt `64e60e41-1129-48d6-a681-6e50957956ee`，prior 6 → 7，
   `in_flight_attempts 0`、`blocked_attempts 0`、`replay false`，committed `2026-10-31T22:04:36.168906Z`。
7. **恢复验收**：约 45 秒后 `/health/ready` 200（platform worker ok），四行 `ISSUABLE` /
   `INTENTIONALLY_DISABLED_NO_EGRESS`；capability 探针 4×`temporal_proof=ok`；手动工作流自然 COMPLETED（未被终止）。

## 围栏 generation 历史（dev，供审计对账）

acq-sweep：`ed59f901…` seq1 gen2（10-31 16:14，手工撤销实测）→ 属主带外恢复 gen3 →
`7dcc7c65…` seq2 gen4（10-31 21:11，[#715 live 演示](2026-11-01-egress-fence-reopen-live-dev.md)）→ 重开 gen5 →
`ca11e502…` seq3 gen6（本记录步骤 4）→ 重开 gen7（本记录步骤 6）。

## 边界（本记录不证明什么）

- 4 个 Temporal schedule 仍 paused；本记录未恢复任何 schedule 运行，也未改动策略/绑定有效期。
- 自动触发目前只在 dev 线上启用（`AUTO_CONFIRM=true`）；生产启用需要同样的 D1–D8 决策与运维记录。
- `NO_LIVE_TARGET` 的语义（无 live Grant ⇒ 无可出网 authority）本次由 intent/sanctions 两行旁证，但「有 live Grant
  但尚未 admitted」的 `SCOPE_MISMATCH` 换目标路径本次未触发（单候选即命中）。
- 撤销期间若存在 `SENDING` 尝试，ACK 的 `in_flight_attempts` 会非零；本次为 0。
