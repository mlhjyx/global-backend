# 平台运行准入改走 v2：权威方 gain-saas 持久签发

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-31 在会话内批准施工（「批准施工」），金额上限按 policy matrix 原值；同日重开 PRD4-D2 并把 R4 平台权威迁到 gain-saas（P7/P8 已完成）。本文取代 2026-10-10《平台 schedule 准入与平台写入者授权》中随 D2 冻结而关闭的「方案 A」。

## 0. 现状（2026-10-31 核实，事实基线 `origin/main@527c70ef`）

- **引擎侧 v2 链路已齐、只缺调用方**：
  - SQL：`ingest_and_admit_platform_execution_budget_run_v2`（`20260905193000`），把「签名 Grant 的 claims 写入」与「按精确 run/workflow/policy 绑定开账」放在同一个平台写入者事务里；
  - 验签：`ExecutionBudgetGrantVerifier.verifyPlatform`（`apps/api/src/execution-budget/execution-budget-grant.verifier.ts:512`）；
  - 组合：`PlatformExecutionBudgetAuthorityIngestionService.ingestAndAdmit(compactJws, expected)`（`platform-authority-ingestion.service.ts:50-68`），只在模块里注册，**没有调用方**。
- **四个平台工作流现在 unpause 第一步就失败**：`admitPlatformSchedule` → `budgets.admitPlatformRun` → `admit_platform_execution_budget_run_v1`（`tools/budget-store.ts:830-850`），而 `20260905193000` 已收回平台写入者对 v1 的 EXECUTE。
- **三块缺口**：
  1. 权威方没有持久的平台 Grant 签发（GrowthOS 时代的签名器只有密码学适配层；现在权威是 gain-saas，它只有工作区 Grant 的签发器）；
  2. 引擎没有「取平台 Grant」的客户端，活动仍走 v1；
  3. 平台写入者对四个「带回执」写入分支要用的 10 张表没有授权（清单见 2026-10-10 计划的 §1.2），四个写事务用 Prisma 默认 5 秒超时。
- **撤销 fence 实测依赖一条真实 committed `PLATFORM_GRANT`**（`execution_budget_authority` 行，issuer/jti/schedule/run 精确匹配）。本设计完成后即可补测 P7 遗留的撤销投递链。

## 1. 设计（方案 A'）

### 1.1 gain-saas：durable platform Grant issuer

- 新端点 `POST /api/internal/v1/platform-schedule-grants`，走既有 mTLS 监听 `172.20.0.1:18448`，客户端证书 CN 只接受 `global-backend-platform-worker`。
- 请求体 = 引擎计算的平台 quote（policy asset 推导）+ 期望绑定：`{scheduleId, workflowId, workflowRunId, scheduleRequestSha256, technicalPolicyRevision, currency:'USD', unit:'microusd', capPerRunMicrousd, campaignCapMicrousd}`。
- 权威方校验（不重复实现引擎的策略引擎，只做权威应有的检查）：
  - `scheduleId` ∈ 四个已知 schedule；
  - `scheduleRequestSha256` 等于其部署绑定 `scheduleActions[].actionSha256`；
  - `workflowId`/`workflowRunId` 格式；`technicalPolicyRevision` 等长 64 hex；
  - `capPerRunMicrousd` ≤ 该 schedule 的配置上限（新 env `R4_PLATFORM_GRANT_MAX_CAP_MICROUSD`，逐 schedule 配置）且 > 0；`campaignCapMicrousd` 同样有上限；
  - 部署绑定的 `policyDigest` 必须等于签发 payload 里的策略摘要。
- 持久化：新表 `r4_platform_grant(jti uuid PK, schedule_id, workflow_id, workflow_run_id UNIQUE, schedule_request_sha256, cap_per_run_microusd, campaign_cap_microusd, max_runs, issued_at, expires_at, token_sha256, created_at)`；**先落库再返回 JWS**；同一 `(schedule, workflow_run_id)` 的重复请求幂等返回已签发的那张（重试安全）。
- JWS：`execution-budget-grant/v1`、`authority_kind=PLATFORM_GRANT`、`subject_type=schedule`、`max_runs=1`、`campaign_cap = cap_per_run`、TTL ≤ 300 秒，用 `ENGINE_BUDGET_GRANT` 钥签发（`/.well-known/execution-budget-jwks.json` 的唯一 kid，引擎既有信任根不变）。

### 1.2 引擎：活动改走 v2

- `admitPlatformSchedule` 活动改为：
  1. 用 `PlatformExecutionTechnicalQuoteService` 计算 quote（policy asset + technical contract + provider snapshot；这一服务 readiness 已在用）；
  2. 新客户端经 mTLS 调 gain-saas 端点（复用 `MACHINE_BOOTSTRAP_*` 证书，端点为新 env `PLATFORM_GRANT_ENDPOINT`）；
  3. `ingestion.ingestAndAdmit({compactJws, expected})`，`expected` 由 quote + `workflowInfo().runId` 组成；
  4. 返回既有 `PlatformExecutionBudgetBinding`（工作流其余部分语义不变）。
- 删除 `BudgetStore.admitPlatformRun`（v1）与其替身，避免留下可被误用的死路径。
- 失败语义：取不到 Grant → 不可用（readiness 的 `platform_budget_authority` 已消费该信号）；Grant 校验失败 → 不可重试的授权失败。
- 平台写入者表授权：迁移按 2026-10-10 计划 §1.2 的 10 张表精确 GRANT（`monitored_source` SU、`source_fetch` SU、`source_entity` SIU、`source_entity_change` I、`sanctions_source` SU、`sanctions_entity` SIU、`patent_lookup_request` SU、`patent_cache_refresh_audit` SU、`patent_inventor_cache` SIUD、`patent_inventor_tombstone` S）；沿用 #621 写法：先全收再精确授予、迁移内自检；新增 `docs/governance/platform-writer-table-privileges.json` 清单 + 真库权限测试。
- 四个「带回执」写事务显式设 `statement_timeout`/交互事务超时（30 秒），与现有平台事务的 2 秒短超时区分用途。

### 1.3 顺序与边界

1. gain-saas PR：issuer + 迁移 + 单测（此时无调用方，零副作用）；
2. 引擎 PR：客户端 + 活动接线 + 表授权迁移 + 真库测试；
3. 同一窗口发版两端；
4. 手动启动一次 `acq-sweep` 验证准入（**不 unpause 任何 schedule**）；
5. 用真实 Grant 补撤销 fence 实测；
6. 4 个 schedule 仍保持 paused —— unpause 是产品负责人的单独决定，本设计只把「恢复前跑不起来」修到「可以跑」。

## 2. 备选

- **B**（2026-10-10 方案）：平台工作流迁进 customer worker，用运营配置表准入，废掉平台写入者；RL2 规模，仍可另议。
- **C**：维持现状；代价是撤销 fence 永远无法用真实 Grant 实测，平台自动化继续不可用。

## 3. 验证

- 单测：issuer（幂等、超限拒绝、绑定校验、重放）、引擎活动（quote→grant→v2 成功与失败语义）、迁移真库测试（10 表授权与拒绝）。
- 端到端（dev，有界）：手动启动一次 `acq-sweep` → `execution_budget_authority` 出现 run 绑定的 `PLATFORM_GRANT` 行 → 用该 issuer/jti 发撤销 → fence 提交 + ACK 验签通过。
- 工作流后续步骤若被 ToolBroker 扣留（`crawl4ai-render/v1`、`sanctions-download/v1`）不影响准入与 fence 验收，如实记录。

## 4. 风险与回退

- 新增签发面：mTLS + CN 白名单 + 逐 schedule 金额上限 + 持久审计行；gain-saas 不可用时 readiness 503（与 capability 同源，现状一致）。
- 迁移只新增表与授权，回退 = 保留表/授权不回滚；引擎回退换旧镜像即可。

## 5. 待产品负责人拍板

1. 批准方案 A' 施工？（没有它，平台 schedule 无法恢复，撤销 fence 无法实测）
2. 逐 schedule 的金额上限用哪组值（建议先用 policy matrix 的 `required_cap_per_run_microusd` 原值，不额外放大）。

## 6. 施工注记（2026-10-31）

- **部署绑定的 `scheduleActions[].actionSha256` 不是 policy 行的 `schedule_request_sha256`**（前者是 Temporal schedule action 的摘要，两者实测不同）。施工时改为：权威侧持有自己的策略副本 `R4_PLATFORM_GRANT_EXPECTED`（逐 schedule 的 request/envelope 摘要，默认取 policy matrix v2 的 2026-10-31 值），§1.1 的对应校验以此为准；部署绑定仍用于证明有效期与 schedule 存在。
- 金额上限默认取 policy matrix `required_cap_per_run_microusd` 实测值：acq-sweep 1、patents 1、sanctions 1、intent-sweep 10,000,000 µUSD。
- 引擎侧删除 `BudgetStore.admitPlatformRun`（v1）及其替身与测试；准入活动只经 `PlatformGrantAdmission`（quote → Grant → ingest/admit）。
- 平台写入者权限清单以「迁移文本 ↔ `docs/governance/platform-writer-table-privileges.json`」逐字一致的零容器测试守住，执行期由迁移内 DO 自检 fail closed。
