# 政策停用 → 平台撤销的自动触发（设计稿）

> 生命周期：`CLOSED`
> 生命周期依据：CLOSED 2026-11-01 —— 按本文施工完毕：gain-saas #25 实现上线（dev 线上开启 `R4_REVOCATION_TRIGGER_ENABLED` + `R4_REVOCATION_AUTO_CONFIRM`），绑定显式撤销 → 自动请求 → 真实 live Grant 投递 → fence 提交 → ACK → 受审计重开（#711）全链实测通过，证据见 [2026-11-01 平台撤销自动触发 live 闭环](../../evidence/2026-11-01-platform-revocation-autotrigger-live.md)。原 APPROVED 依据：产品负责人 2026-11-01 按建议批准 §8 D1–D8（会话内「按建议批准」）；实现先合并（PR #25）；试运行证据见 [dryrun](../../evidence/2026-11-01-platform-revocation-autotrigger-dryrun.md)。

## 0. 一页结论

- **缺的不是链路，是发起方**：签发 → 投递 → fence 提交 → ACK 验签已经用真实 committed `PLATFORM_GRANT` 实测通过；`RevocationIssuer` / `RevocationClient` 至今只有单测和一次手工脚本调用。
- **建议在 gain-saas 建「逻辑撤销请求 + 追加式投递尝试」的持久模型**，沿用 2026-09-13 已批准的恢复规格语义（原字节重放、同 sequence、缺 ACK 不判未提交、不自动 sequence+1）。三个事件源产生请求：政策停用（部署期、受评审的策略状态变更）、部署绑定显式撤销、操作员安全响应。绑定**自然过期**只告警并停发新 Grant，不自动撤销。
- **撤销的效果是 schedule 级且当前不可重开**（围栏只能前进）。因此在「受审计重开路径」落地前，建议自动事件只把请求置为「待确认」，由操作员确认后才投递；安全响应本身由操作员发起，立即投递。重开路径就绪后，自动事件可一键切为全自动。
- **target 选择用 gain-saas 自己的 `r4_platform_grant`**：取该 schedule 最近 300 秒内仍未过期的 Grant 作为 locator（平台 authority 的出网有效期就等于 Grant 的 `expires_at`，准入不延长）。没有 live Grant 时不存在可出网的 authority，请求记为 `NO_LIVE_TARGET` 已解决，不挂起、不阻塞 capability——这一点是刻意偏离旧恢复规格 U5 的「target-free 保持 pending」，需要产品负责人确认（§8 D3）。
- **失败语义**：同一命令原字节重放直到拿到 ACK 或确定性拒绝；缺 ACK 一律记 `UNKNOWN`，绝不当作未提交；ACK 验签通过才记 `ACKED`；确定性拒绝才允许换 target / 等人工处置；不把泛 409 当已提交（后端 filter 已有同样约定）。
- **边界**：不 unpause 任何 schedule、不改变已实测的 wire 契约、不实现重开路径、不 pause Temporal schedule、不动部署绑定与运行时镜像。

## 1. 事实基线（2026-11-01 核实）

本文写作时的事实来源：`mlhjyx/global-backend@7a7ece0f`、`mlhjyx/gain-saas@129618d`、xin 上的 `global_dev` 与 `gain_saas` 库只读查询、gain-saas `.env` 键存在性（未读出值）。

| # | 事实 | 来源 |
| --- | --- | --- |
| 1 | 撤销链实测通过：revocation_jti `ed59f901…`、target_jti `2401bb26…`、receipt generation 1→2、fence seq 1、ACK kid `fence-ack-20260922` 验签通过 | [证据](../../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md) |
| 2 | `RevocationIssuer` 与 `RevocationClient` 在 gain-saas 内没有生产调用方（全仓仅单测与手工脚本）；`r4_revocation_outbox` 只有读取方（`r4-lease.service.ts` 的积压统计），没有写入方 | `gain-saas/apps/server/src/r4/` 全量 grep |
| 3 | gain-saas 的租约心跳已开（`.env` `R4_LEASE_HEARTBEAT_ENABLED=true`），四个 `r4_consumer_lease` 均 ACTIVE；capability 把「租约新鲜 ≤30 秒 + 无积压」当作可签发前提，积压最老 >30 秒即拒绝签发 | `capability-issuer.service.ts`、`r4-lease.service.ts` |
| 4 | 撤销命令的 target 必须命中后端已 committed 的 `PLATFORM_GRANT` 行：`(issuer, jti)` 精确匹配，且 schedule/run 必须一致；不要求 target 未过期、未消费 | `packages/db/prisma/migrations/20260908120000_platform_signed_revocation_receipt/migration.sql` `apply_platform_revocation_fence_v1` |
| 5 | 撤销的效果是 **schedule 级**：`platform_egress_schedule_fence.state='DISABLED'`、generation+1、`fence_sequence` 必须大于当前值；AUTHORIZED 尝试转 BLOCKED，SENDING 只计数（`in_flight_attempts` 进 ACK） | 同上 |
| 6 | receipt 不可变（触发器拒绝 UPDATE/DELETE/TRUNCATE），`(schedule_id, fence_sequence)` 唯一，`(issuer, revocation_jti)` 唯一；重放同一命令返回原 ACK，不重新 fence | 同上、`platform-revocation-receiver.ts` |
| 7 | HTTP 语义：200 返回原始 ACK；400/401/403/409（EXPIRED / REUSED / SEQUENCE_CONFLICT）/429/503；**泛 409 一律按不可用处理**，不得当作已提交 | `platform-revocation-http.contract.ts`、`platform-revocation-http.filter.ts` |
| 8 | 平台 authority 的出网有效期 = Grant 的 `expires_at`（≤300 秒）；v2 准入不写 `admission_lease_expires_at`，`authorize_platform_egress_v1` 直接判 `authority.expires_at` | `20260905193000_platform_execution_run_binding/migration.sql`、`20260908120000` 的 `authorize_platform_egress_v1` |
| 9 | 围栏没有产品化的重开路径：`install_platform_egress_policy_v2` 要求 state=ACTIVE；2026-10-31 dev 恢复是库属主带外 UPDATE（generation 2→3，fence_sequence 保持 1） | [证据](../../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md)「fence 之后的 dev 环境恢复」、`_archive/platform-egress-policy-install-xin-20261001/README.md` |
| 10 | target-lookup 通道已冻结：gain-saas 只托管 GrowthOS 的公钥（`deploy/r4/legacy-jwks/`），target-reader 私钥未迁移，当前没有可签发 target-reader token 的主体 | `gain-saas/apps/server/src/r4/legacy-jwks.controller.ts`、`machine-token.service.ts` 的 profile 列表 |
| 11 | 当前围栏读数（`global_dev` 只读）：`acq-sweep` ACTIVE generation 3、fence_sequence 1；`intent-sweep` ACTIVE gen 1 seq 0；`sanctions-refresh` ACTIVE gen 1 seq 0；`patents-cache-refresh` ACTIVE gen 0 seq 0。唯一一张真实 `PLATFORM_GRANT`（`2401bb26…`）已于 2026-10-31 16:19 UTC 过期 | xin 只读查询 |
| 12 | 4 个平台 schedule 仍全部 paused；恢复运行是产品负责人的单独决定 | `/global/CLAUDE.md`、[证据](../../evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md) |
| 13 | gain-saas 已有：`r4_platform_grant`（每张 Grant 的 jti/run/签发与过期时间）、`r4_consumer_lease`、`AuditService`（`audit_log`）、运营台（`apps/web/src/views/ops`）与 ops 守卫链；`gain_saas` 库是独立 Postgres（127.0.0.1:5433），与 `global_dev` 不共享连接 | `apps/server/prisma/schema.prisma`、`deploy/systemd/` |
| 14 | 2026-09-13 已批准的恢复规格要求：逻辑请求 + 追加式 attempt、原字节重放、同 sequence 首提交唯一、ACK 绑定登记 attempt、缺 ACK 不宣布未提交、不允许自动 sequence+1、积压按逻辑请求计数 | [2026-09-13 已批准差额规格](2026-09-13-platform-revocation-recovery-approved-spec.md) §6–§7、§10 |

## 2. 目标 / 非目标

**目标**

1. 把「政策停用 / 部署绑定显式撤销 / 安全响应」变成一条可审计、可重试、不可丢的撤销请求，直到拿到真实 ACK 或确定性结论。
2. 失败与重试语义不制造「假完成」，也不把未知当未提交（沿用已批准规格）。
3. 自动动作与「不可重开」的现实解耦：重开路径就绪前，自动事件不直接造成不可逆状态。
4. 全部动作默认关闭、可审计、有告警面；不改动已通过实测的 wire 契约。

**非目标**

- 不 unpause 任何 schedule；不 pause/unpause Temporal schedule（撤销只围栏出网）。
- 不实现「受审计重开路径」（独立任务；本文只定义它对撤销的输入要求，见 §6）。
- 不新增或修改后端撤销/ACK 的 wire 契约；不恢复 target-lookup 通道。
- 不做自动入侵检测；安全响应一律由操作员发起。
- 不清理或改写历史 receipt / outbox / 围栏数据。

## 3. 事件源与语义（请拍板 D1 / D2）

| 事件 | 事实来源 | 是否自动触发 | reason_code | 备注 |
| --- | --- | --- | --- | --- |
| 政策停用（受评审的策略状态变更） | gain-saas 部署配置镜像引擎 policy asset 的 `desired_mode`，持久化到新表 `r4_platform_policy_state` | **是**（产生撤销请求） | `POLICY_DISABLED` | 与后端 policy asset 同窗口发布；readiness 应显示 `INTENTIONALLY_DISABLED_NO_EGRESS` 而不是 `BLOCKED` |
| 部署绑定**显式撤销** | 绑定文件新增可选字段 `revokedAt` + `reasonCode`（三选一） | **是** | 文件携带 | 与「文件不可读 / 自然过期」严格区分；轮询发现，读错误只告警 |
| 部署绑定**自然过期** | `validUntil` | **否**，只告警 | — | 新 Grant 已停发、capability 已 503；自动撤销会把一次运维疏忽变成不可逆事故 |
| 安全事件（密钥疑似泄露、可疑部署、紧急停机） | 运营台操作员命令 | **手动发起、立即投递** | `SECURITY_RESPONSE` / `OPERATOR_HOLD` | 这是唯一需要「立刻生效、不值得等重开路径」的类别 |
| 其它信号（POLICY_DRIFT、readiness 变红、Grant 拒绝风暴） | 只读观测 | **否**，只告警 | — | 观测口径不稳定，不适合触发不可逆动作 |

**3.1 政策停用的载体（D2）**

推荐「部署期受评审的策略状态」而不是运营台运行时开关：

- 引擎的 `desiredMode` 来自后端 policy asset（`platform-authority-policy-asset.ts` 的 `desired_mode`），capability 行里的 `mode` 必须与它逐字一致（`platform-capability-rows.ts` 校验），否则 readiness 直接 not ready。因此「政策停用」必须是两侧同窗口发布的状态变更，不能只在 gain-saas 里翻一个开关。
- gain-saas 新增配置 `R4_PLATFORM_POLICY_MODES`（JSON：三个有 egress 的 schedule，`ENABLED | DISABLED`；`patents-cache-refresh` 恒为无 egress，不参与）与持久表 `r4_platform_policy_state`；capability 行的 `mode` 改为从该状态派生（现在来自 `temporal-schedule-probe.service.ts` 的静态 `CONTRACT`）。
- 启动时比较「持久状态 vs 配置」：无持久行 → 建立基线，不触发；`ENABLED→DISABLED` → 创建 `POLICY_DISABLED` 请求；`DISABLED→ENABLED` → 只记录，**不得**在围栏重开之前生效（见 §6）。
- `PlatformGrantIssuer` 增加门：策略状态 DISABLED 或有未决撤销请求时拒绝签发（`PLATFORM_GRANT_POLICY_DISABLED`），作为纵深防御；引擎侧本来也会因 readiness 不再准入。

备选（不推荐，供比较）：运营台运行时开关。实现小，但 readiness 只能显示 `BLOCKED`（看起来像故障），且与「政策 = 受评审制品」的治理模型冲突；仅建议用于安全响应。

**3.2 部署绑定显式撤销**

- 绑定文件 `gain-saas/deploy/r4/deployment-binding.json` 每次签发/取事实都会重新读取（`platform-grant.service.ts` `assertBindingValid`、`platform-facts.service.ts` `readBinding`），所以新增的 `revokedAt` 字段**即时生效**，无需重启。
- 语义：`revokedAt` 存在 ⇒ 该绑定下的部署不再受信。gain-saas 为每个仍 ENABLED 且当时有 live Grant 的 schedule 产生撤销请求；`reasonCode` 由撤销者写在文件里。
- 读不到文件 / JSON 损坏 ≠ 撤销：只告警并按现有行为停发新 Grant（fail closed），不创建撤销请求。

**3.3 部署绑定自然过期**

现状已经是 fail closed：新 Grant 停发（`assertBindingValid`）、capability 503（`readBinding`）。撤销能额外覆盖的只有「过期前最后 ≤300 秒内签发、仍在出网窗口内的 run」。建议改为告警（doctor 已有 <48h 提醒），把「是否撤销最后 5 分钟的在途运行」留给操作员决定。

## 4. target 选择（请拍板 D3）

**4.1 约束**

- wire 契约要求 target =（issuer, jti, schedule, workflow_run_id）且必须命中一条已 committed 的 `PLATFORM_GRANT`；效果却是 schedule 级围栏。因此选 target 是「按 run 选 locator」，生效是「按 schedule 关闭」——选题只有一个：用哪条 run 的 Grant 当锚点。
- target-lookup 通道冻结（§1.10），不能作为「先确认存在」的手段；gain-saas 自己的 `r4_platform_grant` 是唯一可用的候选来源。

**4.2 推荐算法**

1. 在 `r4_platform_grant` 中取该 schedule `expires_at > now` 的 Grant（平台 egress 授权有效期 ≤300 秒，§1.8），按 `createdAt` 倒序。
2. 逐条签发撤销命令并投递；后端返回 `403 PLATFORM_REVOCATION_SCOPE_MISMATCH` 表示该 Grant 从未 admitted（没有 authority 行），属确定性未命中，试下一条。
3. 任一条命中即完成 fence；所有尝试的候选、响应码、命令 jti 摘要全部落审计表。
4. 候选集合为空（或全部未命中）⇒ 记 `NO_LIVE_TARGET`（终态），不挂起、不计入积压。**依据**：平台的 egress 授权在 Grant 过期后不可用（§1.8），没有 live Grant 就证明不存在可出网的 authority；此后新运行的准入由策略门（3.1）与 Grant 拒绝挡住，不存在需要围栏的在途出网。

**4.3 为什么不用「挂起等 target」或「新增 target-free 契约」**

- 2026-09-13 规格 §10 U5 把「target-free 保持 pending、readiness 关闭」列为需用户接受的条件。对 GrowthOS 时代的旧请求这是必要的保守；对新请求，它会让「对一个空闲 schedule 的政策停用」永久污染 capability（四个 schedule 共用一个 capability 文档，一行积压全红），代价不可接受。
- 新增 target-free 的 fence 命令是更大的协议变更（需要新的签名命令、SQL、ACK 契约与安全评审），建议单独立项，不与本设计捆绑。

**4.4 同一请求内的 target 重选**

沿用已批准规格 §6.2：仅当本请求没有任何 attempt 处于可能提交的窗口（全部确定未提交或已过期）时，才允许换 target；保留原 target 与所有失败观察。建议对「新请求」把「须用户明确确认」放宽为自动重选（效果与授权都不变：无论命中哪条，都是同一个 schedule 的同一个 disable），但这一点请产品负责人明确确认（D3 附带问题）。

## 5. 失败与重试语义（请拍板 D5）

**5.1 模型**

沿用 2026-09-13 已批准规格：**逻辑请求**（`r4_revocation_request`：schedule、reason、创建人/来源、目标状态、创建时间、终态与 ACK 事实）+ **追加式尝试**（`r4_revocation_attempt`：每次签发的 JWS 摘要、target、sequence、iat/exp、响应码、结果、时间）。旧 `r4_revocation_outbox` 现状为空且无写入方，保留不动；积压统计改为读新请求表。

状态机：

```text
PENDING ──投递成功且 ACK 验签通过──▶ ACKED
   │
   ├──无 live 候选──────────────▶ NO_LIVE_TARGET（终态）
   ├──确定性配置/密钥错误────────▶ BLOCKED（人工处置）
   └──其他（超时/503/未知）──────▶ PENDING（原字节重试）
```

**5.2 规则**

| 情形 | 处理 | 不得做的事 |
| --- | --- | --- |
| 200 + ACK | `FenceAckVerifier` 验签（issuer/aud/typ/revocation_jti/command_sha256/schedule/fence_sequence 绑定本次命令），落 receipt/generation/committed_at/in_flight_attempts，记 `ACKED` | 未验签就记成功 |
| 网络错误 / 超时 / 503 / 泛 409 | 记 `UNKNOWN`（持久化尝试与摘要），退避后**重放同一字节** | 当作未提交；换 target 或新顺序重签 |
| 命令已过期 | 同字节重放仍可区分：已提交 → 后端返回原 ACK（replay），从未提交 → `409 PLATFORM_REVOCATION_EXPIRED`。只有后者才允许追加 successor（同 sequence、同 target，新 revocation_jti） | 把过期当失败；把 replay ACK 当新 fence |
| `409 SEQUENCE_CONFLICT` | 按已批准规格停在 `STORED_STATE_CONFLICT`，人工核查（可能是本请求更早尝试已提交，也可能是库被带外改动） | 自动 sequence+1；把他人的更高 fence 当本请求成功 |
| `409 REUSED` | 客户端缺陷（同 jti 不同内容），`BLOCKED` + 告警 | 重试 |
| `403 SCOPE_MISMATCH` | 该 target 未 admitted，确定性未命中，换下一条 live 候选（同请求、同 sequence） | 记成「已撤销」 |
| `400/401/415` | 配置或密钥问题，`BLOCKED` + 告警 | 无限重试 |
| `429` | 退避，同字节重试 | — |

- 退避：5 秒起步、指数到 60 秒；命令 TTL ≤300 秒；过期后仍以同字节重放直到确定性答复（replay 语义保证幂等）。
- **积压 ⇒ capability**：`PENDING` / `UNKNOWN` 的逻辑请求计入 `undeliveredCount`；最老一条超过 30 秒即拒绝签发 capability（现有事实门，`capability-issuer.service.ts`）。`NO_LIVE_TARGET` 与 `ACKED` 不计入。
- 时钟：沿用「部署间最大时钟差 ≤60 秒」的既有前提；不拿 HTTP 响应里的时间当 now。
- 序列分配：gain-saas 在请求创建事务里分配 `fence_sequence = max(本库已签发 attempt 的 sequence，含 UNKNOWN) + 1`（每 schedule 一行计数器；未决尝试也占用号段，避免新请求与未知结果撞号）。生产首个请求从 1 开始；dev 的 `acq-sweep` 当前已是 1，首个请求会冲突，按上面的规则人工处置一次（并在审计里写清）——这是 dev 现状，不影响生产设计。

## 6. 撤销后 schedule 重开的联动（请拍板 D4）

**6.1 重开路径需要从撤销拿到什么**

受审计重开（独立任务，属 global-backend）至少需要以下输入，本设计负责把它们完整落库：

- 被超越的 `platform_revocation_receipt.id`（以及 generation、committed_at、reason）；
- 操作员身份与理由；
- 重开后的期望 policy revision / 指纹（与 `install_platform_egress_policy_v2` 的入参同源）；
- CAS 的 `expected_generation`（当前 generation + 1，只前进；`fence_sequence` 不动、不清零）。

重开必须是 owner-only 的新 SQL 函数 + 新审计行，不删除任何 receipt / request / attempt 历史，不重置 `fence_sequence`。

**6.2 顺序与门控（推荐）**

1. **先做重开路径**（独立任务/PR），再做本设计的自动投递；或两者同批但重开先合入。
2. 重开路径可用之前：
   - `POLICY_DISABLED` 与绑定撤销产生的请求停在 `PENDING_CONFIRMATION`，由操作员一键确认后才投递；
   - `SECURITY_RESPONSE` / `OPERATOR_HOLD` 由操作员发起，立即投递（此时「先停住」优先于「可重开」）。
3. 重开路径可用之后：把自动事件切为直接投递（配置开关），确认环节只保留审计。
4. gain-saas 的 `r4_platform_policy_state` 只有在重开生效后才允许回到 `ENABLED`；回切与重开写进同一运维步骤（RUNBOOK 层，不在本仓）。

如果产品负责人选择「现在就全自动」，则意味着一次误触发需要一次库属主带外操作（就像 2026-10-31 的 dev 恢复），不建议。

## 7. 审计与告警（请拍板 D7）

**7.1 审计（durable，不依赖日志）**

- gain-saas：`r4_revocation_request` + `r4_revocation_attempt`（每次状态迁移与每次投递尝试），另写 `audit_log`（realm `ops` / `service`，action 形如 `r4.revocation.requested/confirmed/attempt/acked/blocked`，detail 含原因码、候选集合、命令 jti 摘要、响应码、ACK 事实）。审计失败不阻断业务，但必须能在运营台看到不一致。
- backend：`platform_revocation_receipt`（不可变）与 `execution_budget_authority_revocation` 已足够；不新增审计面。
- 措辞纪律：**requested ≠ delivered ≠ acked ≠ fenced**。文案与运营台都必须按四个状态分别显示；不得把「已投递未 ACK」写成「已撤销」。

**7.2 告警面（M2 通道未接之前的兜底）**

- 运营台：撤销请求列表（PENDING / UNKNOWN / BLOCKED / NO_LIVE_TARGET / ACKED），红标 + 最老待投递时长。
- 日志：每次状态迁移与每次失败一条结构化 error。
- 引擎 readiness：围栏一旦 DISABLED，`platform_budget_authority` 报 `PLATFORM_AUTOMATION_<SCHEDULE>_BLOCKED`，`/health/ready` 503（现状）；
- 可选：`gctl doctor` 增加「gain-saas 撤销积压 > 0 超过 N 分钟」一项（工作区工具，另议）。

## 8. 待产品负责人拍板

| 编号 | 问题 | 我的建议 |
| --- | --- | --- |
| **D1** | 哪些事件必须触发撤销？ | 政策停用：是；部署绑定显式撤销：是；安全响应/操作员 hold：是（手动发起）；绑定自然过期：否，只告警；其它观测信号：否 |
| **D2** | 「政策停用」的载体？ | 部署期受评审的策略状态（gain-saas 配置镜像后端 policy asset 的 `desired_mode` + 持久状态表），两侧同窗口发布；运营台运行时开关只用于安全响应 |
| **D3** | target 选择与「无 live target」语义？ | 用最近 ≤300 秒未过期的 Grant 作 locator，逐条试；无 live 候选记 `NO_LIVE_TARGET` 终态（不挂起、不阻塞 capability）；同一请求内在全部尝试确定未提交后允许自动重选 target |
| **D4** | 重开路径可用之前，自动事件要不要人工确认？ | 要：`POLICY_DISABLED` 与绑定撤销停在待确认；安全响应立即投递；重开路径上线后再切全自动 |
| **D5** | 失败/重试语义是否按 §5 定？序列分配冲突怎么处置？ | 按 §5；冲突一律人工核查（沿用已批准规格），不自动 +1；dev 首次冲突由操作员带外核对一次 |
| **D6** | 谁有权发起/确认撤销？ | 运营台 ops 域的操作员；安全响应建议要求二次确认（输入 schedule 名 + 理由），是否要求双人另定 |
| **D7** | 告警通道？ | 运营台 + 结构化日志 + readiness 兜底；M2 告警通道接入另行安排 |
| **D8** | 范围与依赖顺序？ | 只覆盖三个有 egress 的 schedule（`patents-cache-refresh` 无 egress，不参与）；建议把「受审计重开路径」列为紧前依赖，先合入或同批先合 |

## 9. 批准后的实施切分

**PR A（gain-saas）**

- 迁移：`r4_revocation_request`、`r4_revocation_attempt`、`r4_platform_policy_state`、每 schedule 的 sequence 计数器（可并入 request 表）；积压统计改读新表；旧 `r4_revocation_outbox` 保留不动。
- 服务：
  - `PlatformPolicyStateService`（配置镜像 + 转换检测 + Grant 签发门）；
  - `PlatformRevocationService`（创建请求、选 target、分配 sequence、签名）；
  - `PlatformRevocationDeliveryService`（后台循环，默认关闭，5 秒节拍；同字节重放、ACK 验签、状态机）；
  - 绑定撤销轮询（读 `revokedAt`，读错误只告警）；
  - 运营台接口：发起/确认/查询撤销（ops 守卫链）+ 页面入口。
- 测试：单测（状态机、同字节重放、确定性拒绝分类、序列分配、策略转换、Grant 门）+ 真库集成测试（迁移、唯一约束、并发）；不产生真实网络调用。
- 默认开关：`R4_REVOCATION_TRIGGER_ENABLED=false`、`R4_REVOCATION_AUTO_CONFIRM=false`（D4 决定）；部署需要 restart gain-saas web，属运维决定。

**PR B（global-backend）**

- wire 契约不改；原则上不需要代码变更。
- 若 D3 选择「精确读当前围栏状态」方案，则新增一个只读端点（机器身份鉴权、只返回 schedule/state/generation/fence_sequence/policy 指纹），并配套安全评审与测试——默认不推荐，先把序列分配放在 gain-saas 本地。
- 「受审计重开路径」按 D8 单独排期（独立 PR），输入见 §6.1。
- 验证与证据：live E2E（需要一次真实 admitted 的 Grant）与证据文档；若重开路径尚未可用，dev 会再次被围栏，需按既有方式带外恢复并在证据里如实记录。

## 10. 验证计划（批准后）

- 单测：状态机全分支；同字节重放；过期后的 replay/expired 区分；`SCOPE_MISMATCH` 换 target；`SEQUENCE_CONFLICT` 停住；泛 409 不改状态；ACK 验签失败不改状态。
- 真库集成（gain-saas 5433）：迁移幂等、唯一约束、并发创建请求只分配一个 sequence。
- 后端既有用例：`platform-revocation-*` 组保持绿（含 umask 陷阱，见工作区规则）。
- live E2E（dev，有界）：手动启动一次 `acq-sweep`（不 unpause）→ 取真实 admitted Grant → 运营台发起 `OPERATOR_HOLD` → 撤销投递、fence、ACK 验签 → 审计与运营台状态 →（重开路径可用时）受审计重开，否则带外恢复并记录。
- 负例：无 live Grant（`NO_LIVE_TARGET`）、target 未 admitted（换候选）、后端 503（原字节重试后 ACK）、ACK 验签失败（保持 PENDING 并告警）。

## 11. 风险与回退

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 误触发撤销 | schedule 级围栏，当前不可重开 | D4 的确认门；安全响应外不全自动；审计与告警 |
| 撤销请求挂起 | capability 全局 503（四行共用一份 capability） | 30 秒阈值前有退避与告警；`NO_LIVE_TARGET` 不挂起；运营台可见 |
| 策略状态两侧不同步 | capability 校验失败 → readiness not ready | 同窗口发布；启动时基线比较；读不到配置时不猜 |
| 绑定撤销误写 | 可能围栏在途 run | 与自然过期、读错误严格区分；撤销字段携带 reason 与操作者 |
| 序列冲突（dev 带外重开） | 首个请求停住 | 人工核对一次并留痕；生产由计数器保证 |
| 时钟偏差 / 密钥问题 | 验签或过期判断异常 | 沿用既有 ≤60 秒前提；ACK 验签失败保持 PENDING |
| 回退 | — | 关开关、停投递循环即可停止新动作；已提交的 fence **不回滚**（撤销历史不可变）；新表保留，不做删除型回滚 |

## 12. 开放问题（非产品决策，实现前要核实）

- `PLATFORM_REVOCATION_RATE_LIMIT` 在 gain-saas 部署环境的实际取值（未设置时后端直接 503），退避参数需与它匹配。
- gain-saas 运营台 ops 角色的权限粒度（是否已有管理员/普通操作员之分）决定 D6 的可选答案。
- `r4_revocation_request` 的序号与旧 GrowthOS 语义是否需要迁移对照（旧库已随 P8 停用，预计不需要）。
- 证据文档与 `docs/status/current.md` 的回写口径：批准并实施后再写，不预先宣称任何能力已上线。
