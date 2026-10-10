# 发现 run 准入租约：落地设计

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-09 会话内确认按设计实施（租约 3 小时，只给发现 run）；2026-10-10 决定扩展到 ICP 设计与 ICP 查询计划（30 分钟），见 §8

事实基线：`origin/main@b4417418`。只改 Backend（一个迁移、Prisma 模型、relay 启动参数一处、测试、文档），不改 GrowthOS、不改 Temporal 工作流。

## 0. 结论速览

- 准入后的时间检查全仓只有一处：`attest_authorized_tool_budget_v1`。每次预留（模型与工具都走 `reserve_tool_budget`）和每个活动开头的 `attestAuthorized` 都调用它。准入时另有两处检查（`consume_workspace_execution_authority`、`open_authorized_tool_budget_v1`），不改。
- 给 `execution_budget_authority` 加可空列 `admission_lease_expires_at`。准入时只对 `WORKSPACE_GRANT` + `discovery.run` + `discovery_run` 写入 `准入时刻 + 3 小时`，其余行为 NULL。
- `attest` 的过期判断改用 `COALESCE(admission_lease_expires_at, expires_at)`，仍走原有 `execution_budget_authority_time_state`（含 60 秒容差）。撤销、范围、账户、额度检查一字不动。
- 新 CHECK 约束兜底：租约只能出现在发现 run 行上，必须晚于 `expires_at`，且不超过 `consumed_at + 3 小时`。（2026-10-10 起两个 ICP 操作也有 30 分钟租约，见 §8）
- 租约结束仍报 `EXECUTION_BUDGET_GRANT_EXPIRED`，与 #614 的放行码一致，TS 无需改动。
- 存量行保持 NULL，行为与现在相同；迁移不回填。

## 1. 实测与承重假设

### 1.1 现场证据（xin，只读 SELECT）

| 事实 | 值 |
| --- | --- |
| run `733fbf03` | `discovery_run.created_at` 09:42:17.816；authority `issued_at` 09:42:17、`expires_at` 09:47:17、`consumed_at` 09:42:17.809 |
| 该 run 的预留 | 52 条 `SETTLED`，09:42:19.449 至 09:47:59.433；09:48:18 起 `expires_at < 截秒(now) − 60 s` 判 EXPIRED，09:48:34 失败，与证据吻合 |
| `discovery.run/discovery_run` 行 | 4 行，`expires_at − issued_at` 全为 5:00，对应 4 个仍停在 RUNNING 的 run（#614 处理） |
| 该类 cap | `cap_microusd` = 5,597,480,000（技术报价最坏上界，约 5,597 美元）；733fbf03 实花 430,000（0.43 美元） |
| 其他 workspace grant | `icp.design` 16、`icp.query_plan` 7、`understanding.run` 16，TTL 4:59–5:00；无 PLATFORM_GRANT 行 |

### 1.2 承重假设逐条核验

| # | 假设 | 结论与依据 |
| --- | --- | --- |
| A1 | grant 最长 300 秒 | 成立。`execution-budget-grant.verifier.ts:35`（`MAX_TTL_SECONDS`）与 `:601-604`；表 CHECK `expires_at − issued_at <= 5 minutes`（`20260821090000` L115）；consume 入参同样检查（L516） |
| A2 | 准入时 `expires_at` = grant 的 exp | 成立。consume 的 INSERT 原样写入 `p_expires_at`，`consumed_at = clock_timestamp()`（`20260821090000` L586-596） |
| A3 | 过期判定口径 | 成立。`execution_budget_authority_time_state`（`20260821090000` L375-404，全仓唯一定义）：`expires_at < 截秒(verification) − 60 s` 即 EXPIRED |
| A4 | 准入后只有 attest 查时间 | 成立。`attest_authorized_tool_budget_v1` 只定义一次（`20260822203000` L7-112，时间检查 L72-85），没有后续迁移重定义 |
| A5 | 每次预留都重新 attest | 成立。`reserve_tool_budget`（`20260824120000` L443）→ `reserve_tool_budget_microusd_with_receipt_v1`（`20260823000000` L698）→ `reserve_tool_budget_microusd_v1`，L141 `PERFORM attest`。账户已 exhausted 时 L134-139 先返回 DENIED，不走 attest |
| A6 | 结算、释放不查时间 | 成立。`20260824120000` L42-43 注释写明「Expiry is deliberately not rechecked」；settle/release/status/close 只调 `tool_budget_unbound_cap_microusd_v1`。`mark_tool_budget_result_unknown_v5`、artifact 结算 v2/v3 也不查时间 |
| A7 | 其余 authority 读者不查时间 | 成立。governed relation 追加与核验（`20260830121000` L42-58）、查询 lineage（`20260830130100` L101-110）只查撤销；domain ACK 锁（`20260830121500`）只锁行 |
| A8 | TS 自身不查过期 | 成立。binding 不含时间（`execution-budget-binding.ts`）；TS 只在验签时比较 exp（verifier）；错误码由数据库标记映射（`execution-budget-authority.repository.ts:138-172`） |

### 1.3 时间检查的全部调用点（取各函数最终定义）

| 函数 | 最终定义位置 | 阶段 |
| --- | --- | --- |
| `consume_workspace_execution_authority` | `20260821090000` L571 | 准入（workspace） |
| `open_authorized_tool_budget_v1` | `20260821090000` L803 | 准入（开账户）；运行时只在准入事务里调用 |
| `attest_authorized_tool_budget_v1` | `20260822203000` L72 | **准入后**（唯一一处） |
| `ingest_and_admit_platform_execution_budget_run_v2` | `20260905193000` L286 | 平台准入 |
| `inspect_platform_execution_authority_freshness_v1` | `20260821090000` L1086 | 平台就绪探针 |
| `ingest_platform_execution_authority`、`admit_platform_execution_budget_run_v1` | `20260821090000` L703；`20260822210000` L146/L183 | 旧平台入口，已对 writer 收回（`20260905193000` L412-419） |

`attest_authorized_tool_budget_v1` 的调用方：`reserve_tool_budget_microusd_v1`（`20260824120000` L141，两类 scope 的每次预留）；平台 ACK 丢失后的只读重放（`20260905193000` L385；旧入口 `20260822210000` L115）；TS `PostgresBudgetStore.attestAuthorized`（`budget-store.ts:848-869`）。

另有平台出网栅栏直接比较 `authority.expires_at`，只作用于 `PLATFORM_GRANT`：`20260908120000` L187-188、L241-242（v1），`20260908130000` L150、L192、L233（v2）。

### 1.4 TS 侧重新核验的路径（全部经同一个 SQL）

- 发现 run binding（本设计覆盖）：`discovery.activities.ts:365-389` 的 `ensureRunBudget`，用于 loadPlanQueries、qualifyFitForRun、enrichRun、profileWebsitesForRun、enrichSignalsRun、registerWatchesForRun、enqueuePatentLookupsForRun、finalizeRun（:405 至 :1812）；`executeQuery` 的直接核验（:505）；`taxonomy-resolver.ts:452`；`intent-projection.service.ts:314`；每次预留 `router-model-gateway.ts:497`、`tool-broker.ts:371` → `budget-store.ts:880`。
- 不覆盖（保持 5 分钟）：`understanding.activities.ts:114`（understanding.run）；`icp-budget-execution.ts:13`（icp.*，2026-10-10 起有 30 分钟租约，见 §8）；`discovery.service.ts:333/556`（discover-contacts、guess-emails，`discovery.run` + `company`）与 `:847`（contact.verify）；`platform-schedule-authority.activities.ts:181`（平台）。

### 1.5 表结构与平台 grant 的差异

- 列（xin `information_schema` 核对）：`id, scope_key, authority_kind, workspace_id, issuer, audience, jti, token_sha256, schema_version, purpose, subject_type, subject_id, request_sha256, schedule_id, currency, unit, cap_microusd, cap_per_run_microusd, campaign_cap_microusd, max_runs, runs_consumed, issued_at, not_before, expires_at, consumed_at, revoked_at, created_at`，加平台运行绑定 `schedule_request_sha256, workflow_id, workflow_run_id, technical_policy_revision`（`20260905193000` L8-46）。
- 没有 operation 列。发现 run 由 `purpose = 'discovery.run' AND subject_type = 'discovery_run'` 唯一识别：只有 `POST /query-plans/:planId/execute` 产生这一组合（`execution-budget-request-scope.ts:139-144`），联系人两个端点是 `discovery.run` + `company`（:146-152）。
- WORKSPACE_GRANT：`consumed_at` 必填、`runs_consumed` 只能 0 或 1（L145-146），一个 authority 只开一个账户。app_user 对该表只有 SELECT（L1364-1377；对撤销表有 SELECT 与 INSERT，L1378），所有写入都经 SECURITY DEFINER 函数。
- PLATFORM_GRANT：`scope_key = 'platform'`，只能由 `execution_budget_platform_writer` 成员写入；绑定一次 Schedule 运行（`max_runs = 1`）；同样 ≤5 分钟；准入后同样走 attest，另有出网栅栏直接比较 `expires_at`；撤销走签名回执。本设计不给平台行租约（CHECK 禁止），平台 Schedule 恢复后同样会在约 6 分钟时失败，需另行决定。

## 2. 触点

### 2.1 新迁移 `packages/db/prisma/migrations/20261009170000_discovery_run_admission_lease/migration.sql`

迁移名须排在 #616 的 `20261009160000_security_definer_search_path_pg_temp` 之后：名字更早的迁移若更晚部署，会在 xin 上悄悄撤销那次加固，#616 的护栏会拒绝。

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "execution_budget_authority"
  ADD COLUMN "admission_lease_expires_at" TIMESTAMPTZ(3),
  ADD CONSTRAINT "execution_budget_authority_admission_lease_check" CHECK (
    "admission_lease_expires_at" IS NULL OR (
      "authority_kind" = 'WORKSPACE_GRANT'
      AND "purpose" = 'discovery.run' AND "subject_type" = 'discovery_run'
      AND "consumed_at" IS NOT NULL
      AND "admission_lease_expires_at" > "expires_at"
      AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'));
-- CREATE OR REPLACE consume_workspace_execution_authority：原文逐字复制，只改三处：
--   DECLARE 加 admitted_at TIMESTAMPTZ；INSERT 前 admitted_at := clock_timestamp()；
--   consumed_at 改写 admitted_at，新列写
--   CASE WHEN p_purpose = 'discovery.run' AND p_subject_type = 'discovery_run'
--        THEN admitted_at + INTERVAL '3 hours' END
-- CREATE OR REPLACE attest_authorized_tool_budget_v1：原文逐字复制，只把 time_state 的
--   第三个参数改为 COALESCE(authority."admission_lease_expires_at", authority."expires_at")
COMMIT;
```

- `consumed_at` 与租约取同一个 `admitted_at`，两列都按 `TIMESTAMPTZ(3)` 同样舍入，租约恰好等于 `consumed_at + 3 小时`。若分别调用两次 `clock_timestamp()`，微秒差会让 CHECK 失败。
- `consumed_at IS NOT NULL` 写明，CHECK 才是两值逻辑：NULL 参与比较时 CHECK 会放行。
- `CREATE OR REPLACE` 保留属主与 ACL，但其余属性全部按新语句重设。必须原样重述 `LANGUAGE plpgsql`、`SECURITY DEFINER`、`SET search_path = pg_catalog, public`，attest 还要重述 `STABLE`。漏写会静默变成 INVOKER 或 VOLATILE。实施时 search_path 写成 `pg_catalog, public, pg_temp`（pg_temp 放最后），让临时 schema 最后才被搜索，见 §7 第 6 项。#616 的迁移已把所有 SECURITY DEFINER 函数改成这样；之后的 CREATE OR REPLACE 若重述旧的 `pg_catalog, public`，会撤销这次加固，#616 的静态与真库护栏也会失败。
- 加 `COMMENT ON COLUMN`，写明「准入后有效期，仅发现 run；NULL 表示沿用 expires_at」。
- 同表加列有先例：`20260905193000` 用同样方式加了 4 列。

### 2.2 其他文件

| 文件 | 改动 |
| --- | --- |
| `packages/db/prisma/schema.prisma`（`ExecutionBudgetAuthority`，L172-219） | 加 `admissionLeaseExpiresAt DateTime? @map("admission_lease_expires_at") @db.Timestamptz(3)`，否则本地 `migrate dev` 会生成删列迁移 |
| `docs/evidence/site-builder/copy-runtime-eligibility.json` | schema.prisma 是 Copy 绑定文件，运行 `node scripts/copy-fixed-source-impact-resign.mjs`。它已在 `drifted_paths` 里，只重签指纹 |
| `apps/api/src/execution-budget/discovery-run-admission-lease.migration.spec.ts`（新） | 静态迁移合同，见 §6 |
| `apps/api/src/execution-budget/workspace-authority-lifecycle.spec.ts` | 改为读取 attest 的**最新**定义（最后一个定义它的迁移），不再固定读 `20260822203000` |
| `apps/api/src/execution-budget/discovery-run-admission-lease.postgres.spec.ts`（新） | 真库合同，见 §6；照 #597 的 `*_DATABASE_TEST=1` 与库名须以 `_test` 结尾的门 |
| `.github/workflows/ci.yml`（L216-249 那一步） | 在已 `migrate deploy` 的步骤里加跑上面的 postgres spec（与 #597 同一位置，后合者变基） |
| `apps/api/src/relay/outbox-relay.service.ts`（发现工作流的 `workflow.start`，约 L705-723） | 只给发现工作流加 `workflowIdReusePolicy: REJECT_DUPLICATE`。现在用默认策略：同 ID 的第一次执行结束后，事件再投递会另起一次执行，在租约内复用同一 binding。拒绝重复后，Temporal 对已关闭的同 ID 也报 `WorkflowExecutionAlreadyStartedError`，`startWorkflowIdempotent` 已把它当作合并、照常标记已投递。`qualify-` 工作流按设计允许跑完再触发，不改 |
| `apps/api/src/relay/outbox-relay.service.spec.ts`（或相邻 relay spec） | 断言发现工作流的启动参数带 `REJECT_DUPLICATE`，qualify 不带；已关闭时的 `AlreadyStarted` 记为合并 |
| 文档 | 见 §2.4 |

### 2.3 决定与理由

- **只给发现 run 租约。**（2026-10-10 起扩展到两个 ICP 操作，见 §8）证据只指向发现 run（预计 1–1.5 小时）。其他 workspace 操作是同步 HTTP 或短工作流，3 小时对它们是 36 倍的无谓放宽。`discovery.run` 也被联系人端点使用，所以必须同时按 `subject_type = 'discovery_run'` 区分。
- **长度写在 SQL 里，3 小时。** 函数写确切值，CHECK 写上限。授权语义的权威在数据库（ADR-024：金额、Grant、消费是 PostgreSQL 权威事实）。若由 TS 参数传入，就等于让应用代码自定授权时长。若放进环境变量，就成了 `environment-parity-policy.json` 未登记的环境差异。代价是改长度要走迁移加换镜像，可以接受。3 小时约为预期时长的 2 倍。
- **结算与释放不改。** 它们本来就不查时间（A6）。租约内做的预留，租约结束后照样能结算或释放。
- **存量行为 NULL，沿用旧口径。** 迁移不写 UPDATE；`COALESCE` 让 NULL 行按 `expires_at` 判断。xin 上 43 行全部不变，4 个卡住的 run 不会复活。
- **RLS 与权限。** 新列在 FORCE RLS 表上，策略按行判断，不用改。app_user 仍无 INSERT/UPDATE，不能自行设置或延长租约，只有 consume（SECURITY DEFINER）在新插入时写入；consume 的重放分支直接返回已有行，不会重写租约。平台分支（`assert_execution_budget_platform_writer_principal`）不动。
- **受保护文件不涉及。** `durable-result-strategies.json` 的 `protectedFiles` 只有 tool-broker、router-model-gateway 等 4 个 TS 文件，`scripts/execution-authority-policy.mjs` 只校验它们，本设计都不碰，无需栅栏复核或重钉。要处理的指纹只有 Copy（schema.prisma）。
- **错误码不变。** 新增码要改 `DATABASE_ERROR_CODES`、HTTP 映射、控制错误分类和 #614 的放行集合。保持 `EXECUTION_BUDGET_GRANT_EXPIRED` 不需要这些改动。

### 2.4 需要更新的文档

- `docs/architecture/execution-budget-authority-artifact-replay-design.md` L89（300 秒最大 TTL）：补一句「300 秒只约束 Grant 的出示与准入；发现 run 准入后按 authority 的准入租约（3 小时）有效」。L152（reserve 再次验证有效期）：注明有效期为 `COALESCE(租约, expires_at)`。
- `docs/adr/registry.md` ADR-024（「一次性、短期」Grant）：建议加一段补充，记录 2026-10-09 产品负责人决定与撤销投递缺口。
- `docs/implementation-records/execution-budget-authority-contract.md` L318（≤300s Grant）：表述仍成立，不改。
- `docs/roadmap/changelog.md`：新增 2026-10-09 条目。本文落地后改为 `APPROVED`，合并后改为 `CLOSED`。
- `local-config/RUNBOOK.md`（工作区文件，不在本仓）：补「租约内停止发现 run」一节（见 §3）。

## 3. 合规与安全

- **不变：** bearer JWS 的 5 分钟出示窗与 60 秒容差（verifier、consume、open 三处）；jti 只能用一次（consume 重放后 TS 报 `GRANT_REUSED`）；一个 authority 只开一个账户；cap（超额 DENIED 并标 exhausted，attest 报 `EXHAUSTED`）；撤销（attest 每次都查 `revoked_at` 与撤销表）；工作区范围、`session_user`、RLS；账户 `ref_count = 1` 且未关闭。
- **变化：** 准入后可继续预留的时长从约 6 分钟变为 3 小时加 60 秒。能用这段时长的只有持有 binding（authorityId + accountKey）、以 app_user 在该工作区事务里调用的后端代码。binding 存在 outbox payload 和 Temporal 历史里，不是对外凭证。窃取 JWS 的人得不到任何额外能力。
- **陈旧 run：** 工作流被 terminate 或 cancel 后，正在执行的活动尝试不会立即停止（不心跳的活动要到 15 或 30 分钟的 startToClose 才超时），它在租约内的预留仍会通过。重复执行同样会在租约内复用 binding：relay 未指定 `workflowIdReusePolicy`，按默认策略允许已关闭的同 ID 再启动；运维 reset 失败的工作流也是一种情况。同一 operation key 的预留会 REPLAY，不会再花一次（`20260824120000` L157），但新的 key 会正常花钱。本设计在 relay 侧给发现工作流加 `REJECT_DUPLICATE`（§2.2），堵住「事件再投递另起一次执行」这条路；运维 reset 仍会复用 binding，写进 RUNBOOK。
- **上限：** cap 是技术报价的最坏上界，xin 上约 5,597 美元每 run，对失控支出的约束很松。实际起作用的时间上界就是租约。
- **撤销投递缺口（已接受的代价）：** GrowthOS 无法撤销 workspace grant。后端 `ExecutionBudgetAuthorityRepository.revoke()`（`execution-budget-authority.repository.ts:706`）没有任何运行时调用方，平台侧的 R4 投递链也未打通。租约内停止 run 有三种办法：
  1. 等 cap 耗尽。
  2. `temporal workflow terminate --workflow-id discovery-<runId>`（relay 用的 ID，`outbox-relay.service.ts:710`），止住新活动。
  3. 以 app_user 设置 `app.current_workspace_id` 后，向 `execution_budget_authority_revocation` 插入一行。触发器 `mark_execution_budget_authority_revoked` 回写 `revoked_at`，下一次预留即报 `REVOKED`；#614 合入后 run 记为 FAILED。

  第 2、3 种办法要写进 RUNBOOK。
- **审计：** authority 行同时记录准入（`consumed_at`）、Grant 窗口（`expires_at`）和租约（新列）。每次预留有 `tool_budget_operation.created_at`。「Grant 窗口之后、租约之内」的支出可以直接查询：`operation.created_at > authority.expires_at`。不新增个人数据、数据源或出网；DSR tombstone 与禁联检查和 authority 时间无关，不受影响。

## 4. 决策与权衡

| 方案 | 要改什么 | 不选的原因 |
| --- | --- | --- |
| 延长 Grant 本身（如 3 小时） | verifier `MAX_TTL_SECONDS`、表 CHECK（L115）、consume 与平台入参检查、GrowthOS 签发端 | 违反「只改 Backend」；把 bearer token 的出示窗放大 36 倍，泄露的 JWS 在 3 小时内都能启动 run |
| 运行中由 GrowthOS 续期 | Backend 到 GrowthOS 的签名客户端、续期端点、每次续期重报价；工作流处理续期失败 | 跨仓项目，依赖尚未打通的 GrowthOS↔Backend 通道。撤销语义最好（停止续期即停），可作为该通道建成后的后继方案 |
| 分段 run（每段一个 Grant） | 工作流按阶段重新准入，新增请求范围与报价，SaaS 每段参与 | 改动最大，破坏「一次 run 一个 cap」，SaaS 体验变差 |
| 所有 workspace grant 都给租约 | 同本方案，去掉 purpose 条件 | 不必要地放宽其他操作 |
| 不加列，attest 时按 `consumed_at + 3h` 现算 | 只改 attest | 对存量行追溯生效（会让已失败 run 的 authority 复活 3 小时）；没有准入时的记录；以后改长度会追溯 |

本方案只改 Backend 的 SQL，差异最小（两段函数体各几行、一列、一个 CHECK），保留 Grant 窗口、cap、单次使用、撤销和范围检查，回退也容易。

## 5. 风险与回退

- **迁移安全：** 加可空列且无默认值，只改元数据，不重写表。CHECK 校验扫一遍小表（xin 43 行）。整个迁移是一个事务，带 `lock_timeout 5s` 与 `statement_timeout 30s`，拿不到锁就快速失败。不回填。
- **部署门：** 运行时要求库里最新迁移名与镜像证明的 `migration_revision` 完全相等（`runtime-process-lease.ts:567-577`，worker 在 `worker.ts:171-178` 检查）。所以「`migrate deploy` 加换镜像」要在同一维护窗口内完成（RUNBOOK §2，含 R4 续期与 GrowthOS 钉值），两步之间 API 与 Worker 不就绪。换时不能有发现 run 在跑；迁移前准入的 run 租约为 NULL，照旧约 6 分钟失败。
- **回退：** 迁移只向前。正式回退是新迁移把两个函数体恢复原样（列留着，无害）再换镜像。应急时不换镜像也有两种做法：按 run 撤销（§3）；或以 owner 执行 `UPDATE … SET admission_lease_expires_at = NULL WHERE admission_lease_expires_at > now()`（CHECK 允许 NULL），让在跑的 run 回到 Grant 窗口，下一次核验即过期。该表是 FORCE RLS，同一事务里先 `SET LOCAL row_security = off`，见 §8.6。
- **与 #614 的交互：** 兼容。租约结束报的仍是 `GRANT_EXPIRED`，在 #614 的放行集合内。#614 对超出租约、撤销、额度耗尽和其他阶段失败仍然必要。两者文件只在 changelog 重叠，后合者变基。#614 正文与 changelog 里「授权只有 5 分钟」的说法，在本设计合入后要更正。
- **Temporal：** 已确认不改工作流。`discovery.workflow.ts` 里没有任何时间逻辑，binding 只作参数传递，核验都在活动内的 SQL 里；不加 patch，没有确定性问题；活动超时（2、15、30 分钟）不变；relay 启动时不设工作流总超时（`outbox-relay.service.ts:705-716`）。
- **超出租约：** 跑满 3 小时的 run 会像今天一样失败，只是时间点推后到 3 小时。#614 合入后记为 FAILED。
- **与 #597：** 两者都在 ci.yml 同一步追加 postgres spec，会有文本冲突，后合者变基。

## 6. TDD 步骤

1. **RED，静态合同**（零容器，`APP_DATABASE_URL= pnpm --filter @global/api test`）：新 `discovery-run-admission-lease.migration.spec.ts` 断言：
   - 新迁移存在，是单个 BEGIN/COMMIT，含 `lock_timeout`。
   - 没有针对 `execution_budget_authority` 的 UPDATE 或 DELETE（不回填）；新列可空、无 DEFAULT。
   - CHECK 包含 WORKSPACE_GRANT、`discovery.run`、`discovery_run`、`consumed_at IS NOT NULL`、`> expires_at`、`3 hours`。
   - consume 与 attest 的新函数体规范化后，与旧函数体（`20260821090000`、`20260822203000`）相比只有预期的几行差异。
   - 两个函数仍是 `SECURITY DEFINER`，`search_path` 不变，attest 仍是 `STABLE`，attest 仍不含 INSERT/UPDATE/DELETE。
   - 新迁移不重定义 `open_authorized_tool_budget_v1` 与平台入口（准入仍用 Grant 窗口）。

   同时改 `workspace-authority-lifecycle.spec.ts`，让它跟随 attest 的最新定义。先跑一遍，确认失败。
   relay：先写「发现工作流以 `REJECT_DUPLICATE` 启动、qualify 不变」的用例，确认失败。
2. **RED，真库合同**：新 `discovery-run-admission-lease.postgres.spec.ts`（`EXECUTION_BUDGET_ADMISSION_LEASE_DATABASE_TEST=1`，库名须以 `_test` 结尾）。走真实的 `ExecutionBudgetAuthorityRepository.consumeWorkspaceAndOpenInTransaction` 与 `PostgresBudgetStore`。用 owner 连接把该 authority 的全部时间列（含租约）整体前移来模拟时间流逝，整体平移不违反任何 CHECK。用例：
   - a. 发现 run 准入后，租约 = `consumed_at + 3h`；understanding.run、icp.*、`discovery.run`+`company`、contact.verify 准入后为 NULL。
   - b. 前移 10 分钟：attest 正常，`reserve_tool_budget` 返回 EXECUTE（0 微美元）后 release 成功。这是本次的语义 RED，现状报 `GRANT_EXPIRED`。
   - c. 同样前移非发现 run 行：仍报 `GRANT_EXPIRED`。
   - d. 前移 3 小时 2 分钟：报 `GRANT_EXPIRED`，且 TS 映射为同名错误。
   - e. 租约内：插入撤销行后即报 `REVOKED`；账户 exhausted 后报 `EXHAUSTED`；换工作区报 `SCOPE_MISMATCH`；账户关闭后报 `LIFECYCLE_UNAVAILABLE`。
   - f. 准入仍受 Grant 窗口约束：过期 claims 走 consume 报 `GRANT_EXPIRED`；对已过 Grant 窗口的租约行再 open 也报 `GRANT_EXPIRED`。
   - g. owner 直接写入以下租约均被 CHECK 拒绝：平台行、understanding 行、超过 3 小时、不晚于 `expires_at`。
   - h. owner 插入租约为 NULL 的发现 run 行（等同存量行）：按旧口径判断。
   - i. 两个函数的 `prosecdef`、`proconfig`、`provolatile` 与 `has_function_privilege` 矩阵（app_user、平台 writer、PUBLIC）不变。
3. **GREEN：** 写迁移，在 schema.prisma 加列，跑 1、2 至全绿；Copy 重签；`pnpm --filter @global/api build`（新 worktree 先 build，免 7 个假失败）。
4. **收尾：** 更新 §2.4 的文档；`pnpm docs:verify`、`pnpm governance:verify`；推送前 `gctl check`；ci.yml 接入 postgres spec。
5. **xin 真库验证（不花钱）：**
   - 开发期：`docker --context default run -d --rm --pull never -p 127.0.0.1:<port>:5432 --tmpfs /var/lib/postgresql/data pgvector/pgvector@sha256:ccc6e83d…4d6b` 起一次性库（即 ci.yml 钉的同一摘要，本机已有），库名 `global_test`。先部署到 main 的迁移跑一遍 spec 看到 RED，再部署新迁移看到 GREEN，用完删除容器。
   - 部署后在 `global_dev` 只读核对：列与约束存在；存量 43 行租约全为 NULL；`pg_get_functiondef` 含新表达式，ACL、`prosecdef`、`proconfig` 与部署前抓取的一致；以 app_user 对 `733fbf03` 的 authority 调用 attest（STABLE，只读）仍报 `GRANT_EXPIRED`。
   - 可选：在 `global_dev` 上开一个最后 ROLLBACK 的事务，用夹具 claims 做 consume 加 open，读出租约后回滚，不留任何行。要先得到产品负责人同意。
6. **验收（需要一次真实发现 run，会花钱，由产品负责人发起）：** run 越过 6 分钟仍在跑；其 authority 的租约为准入加 3 小时；存在 `created_at > expires_at` 的预留；run 收尾为 DONE 或 PARTIAL。

## 7. 产品负责人确认（2026-10-09 会话内）

1. 租约 3 小时是否确定。预期 1–1.5 小时；查询多、重试多时可能超过 3 小时，届时 run 会失败。
   - 答：确定，3 小时。
2. 范围只含发现 run。understanding.run 与 discover-contacts 保持 5 分钟（时长未实测），出现同样失败时再按本机制各加一个条件。
   - 答：只给发现 run。
3. 平台 Schedule 恢复运行后会遇到同样的约 6 分钟失败，是否另行决定。
   - 答：以后另行决定，本次不给平台行租约。
4. 是否另做加固：run 收尾时关闭账户，让租约随 run 结束提前失效。不在本次范围：finalizeRun 被重试时会撞上 `LIFECYCLE_UNAVAILABLE`，需要和 #614 一起设计。
   - 答：作为后续工作，与 #614 的重试语义一起设计，本次不做。
5. ci.yml 接入真库 spec 会让该 PR 的 CI 跑全部重门，约 40 分钟。
   - 答：接受。
6. 顺带发现，不在本次范围，建议各自立项（答：各自单独跟踪，临时表与 search_path 一项已有任务）：
   - 同一 plan 的 run 失败后无法用新 Grant 重跑。accountKey 由 planId 决定，旧账户仍绑定旧 authority，`open_authorized_tool_budget_v1` 报 `GRANT_REUSED`（`20260821090000` L829-838），与 #614「计划保持 READY，可直接重跑」的说法矛盾；#597 只为 ICP 请求解决了同类问题。
   - authority 相关的 SECURITY DEFINER 函数用 `search_path = pg_catalog, public`。app_user 在 `global_dev` 有 TEMPORARY 权限，未列出的 `pg_temp` 会被优先搜索，临时表可能遮蔽这些函数里未限定 schema 的表。本迁移重定义的两个函数已把 `pg_temp` 放最后；其余函数由 #616（`20261009160000_security_definer_search_path_pg_temp`）统一改为 `pg_catalog, public, pg_temp`。

## 8. 2026-10-10 扩展：ICP 设计与 ICP 查询计划

事实基线：`origin/main@16c1d410`。产品负责人 2026-10-10 决定：准入租约扩展到 ICP 设计与 ICP 查询计划，时长为准入时刻 + 30 分钟；发现 run 仍是 3 小时；不包含其他用途（如 `understanding.run`）。其余全部沿用本设计：只在准入时写入；撤销、范围、cap、耗尽和单持有者检查不变；其余用途为 NULL，沿用 Grant 窗口。

### 8.1 失败证据（xin，只读 SELECT）

| 事实 | 值 |
| --- | --- |
| 失败请求 | `POST /icps/:icpId/query-plans` 返回 HTTP 402 `EXECUTION_BUDGET_GRANT_EXPIRED` |
| authority `ecdb1a5c` | `icp.query_plan` + `icp`；`issued_at` 10:12:04、`expires_at` 10:17:04、`consumed_at` 10:12:10.808（UTC） |
| 该请求的预留 | 规划调用 1 次，10:12:10.832 至 10:14:21.504（约 130 秒）；之后 9 次串行的 `taxonomy.normalize`，10:14:21.845 至 10:18:13.017，全部 `SETTLED`。按 60 秒容差，10:18:04 之后的核验判 EXPIRED，下一次预留被拒 |
| 其余查询计划 | 准入到最后一次结算最长 5:33（16 次预留），离 6 分钟边界只差约 30 秒 |
| ICP 设计 | 单次模型调用；10-10 的两次为 2:14 与 2:29，账本里 18 次的中位数约 1:30、最长 3:04（10-08）；结构化输出不合格时还有修复调用，但在同一个预留里（见 §8.3） |

### 8.2 范围

- 只对 `WORKSPACE_GRANT` 的两组 purpose 与 subject_type 写租约 = 准入时刻 + 30 分钟：
  - `icp.design` + `company`：`POST /companies/:companyId/icps`；
  - `icp.query_plan` + `icp`：`POST /icps/:icpId/query-plans`。
- 字符串已在代码核对：`execution-budget-request-scope.ts:124-137` 把两个端点映射为上述组合；`icp.service.ts:114`（`generateFromCompany`）与 `:496`（`generateQueryPlan`）以它们调用 `consumeWorkspaceGrant`；数据库 `execution_budget_authority_kind_shape_check` 只允许 `icp.design` 配 `company`、`icp.query_plan` 配 `icp`。
- 发现 run（`discovery.run` + `discovery_run`）仍为 3 小时。`understanding.run`、`discovery.run` + `company`（联系人两个端点）、`contact.verify` 与平台 grant 仍为 NULL。
- 迁移不回填：迁移前准入的 ICP 行租约为 NULL，照旧按 Grant 窗口判断。

### 8.3 准入后过期检查的追踪（两条路径）

- 两个端点都是同步 HTTP：`IcpController` → `asExecutionBudgetHttpBoundary` → `IcpService`。不写带 binding 的 outbox 事件，也不启动 Temporal 工作流（`ICPActivated` 来自 `activate`，不走预算）。binding 只在请求处理期间存在于进程内存。
- 准入（不改）：`consumeWorkspaceGrant` → 验签（`MAX_TTL_SECONDS` 300 加 60 秒容差，这两条路径上唯一一次比较 JWS 的 `exp`）→ `consume_workspace_execution_authority` 与 `open_tool_budget`（→ `open_authorized_tool_budget_v1`），三处都按 Grant 窗口判断，在同一个事务里。
- 准入后（全部经 attest）：
  - `executeIcpBudgetedTask`（`icp-budget-execution.ts:13`）在模型调用前调 `PostgresBudgetStore.attestAuthorized`（`budget-store.ts:848`）→ `attest_authorized_tool_budget_v1`；
  - 模型调用走 `RouterModelGateway.run` 的非 paidCost 分支（`router-model-gateway.ts:497`）→ `reserve`（`budget-store.ts:870`）→ `reserve_tool_budget` → attest；结算、释放不查时间（A6）；
  - 查询计划的 `injectTedQuery`、`injectFdaQuery`（`icp.service.ts:585`、`:620`）经 `TaxonomyResolver.executeBudgetedTask`（`taxonomy-resolver.ts:436-465`）：`parseExecutionBudgetBinding` 不含时间，随后 attest 与 reserve 同上；
  - 落库的 `applyDomainAckConsumerTransaction`（`lock_execution_domain_ack_authority_first_v1`、`apply_execution_domain_ack_v1`）不查时间（A7）。
- TS 侧：binding 不含时间；准入后没有代码比较 Grant 的 `exp`；错误码由数据库标记映射（`mapExecutionBudgetPersistenceError`）。ICP 路径不用 ToolBroker。
- ICP 设计在准入后只核验一次、预留一次，都在准入后数秒内：模型调用前的 attest，以及 `run` 里按两次线缆上限的一次 reserve。结构化输出的修复调用在同一个 `run`、同一个预留里（`router-model-gateway.ts:186-360`；runtime 侧 `transportMaxAttempts: 1`、`contentRepairMaxAttempts: 0`），结算不查时间。所以按现有代码，ICP 设计不会因模型耗时在准入后过期；给它租约是产品负责人决定的防御性覆盖，今后它多出一次预算调用时才起作用。真正踩到 6 分钟边界的是查询计划：规划调用之后的每次分类调用都要重新核验与预留。
- 结论：准入后唯一的时间检查是 attest（直接调用或经 reserve），它自 `20261009170000` 起已按 `COALESCE(admission_lease_expires_at, expires_at)` 判断。只要准入时写入租约，两条路径就端到端生效。attest 不重定义，TS 不改。

### 8.4 触点

- 新迁移 `20261010110000_icp_admission_lease`，名字排在 #621 的 `20261010090000` 与 #622 的 `20261010100000` 之后。单个事务，`lock_timeout 5s`、`statement_timeout 30s`：
  - 替换 `execution_budget_authority_admission_lease_check`（同一条 `ALTER TABLE` 里先去掉旧约束再加新约束，加的时候校验存量行）：仍要求 `WORKSPACE_GRANT`、`consumed_at IS NOT NULL`、租约晚于 `expires_at`；三组 purpose 与 subject_type 各有上限：发现 run 3 小时，两个 ICP 操作 30 分钟。所有列非空或已显式判非空，CHECK 是两值逻辑。
  - 列注释改为写明两种时长。
  - `consume_workspace_execution_authority` 从 `20261009170000` 的定义逐字复制，只在租约 CASE 里加两条 WHEN；重述 `LANGUAGE plpgsql`、`SECURITY DEFINER` 与 `search_path = pg_catalog, public, pg_temp`；准入时刻仍只取一次，租约恰好等于 `consumed_at` + 30 分钟。
- `schema.prisma` 只改该字段的文档注释（Copy 重签，只变指纹）。
- 测试：新静态合同 `icp-admission-lease.migration.spec.ts`；真库合同扩写进 `discovery-run-admission-lease.postgres.spec.ts`（同一开关、同一 CI 步骤，所以 ci.yml 不用改）；`workspace-authority-lifecycle.spec.ts` 只改注释。
- 文档：本节；架构设计与 ADR-024 写明两个 ICP 操作的租约；changelog。

### 8.5 合规与安全（相对 §3 的差异）

- 放宽幅度：准入后可预留的时长从约 6 分钟变为 31 分钟（30 分钟加 60 秒容差）。cap 仍是技术报价的最坏上界。
- binding 不持久化：与发现 run 不同，ICP 的 binding 不进 outbox payload 或 Temporal 历史，租约内能用它的只有这次请求本身。重放同一 Grant 报 `GRANT_REUSED`；同一主体的新 Grant 开同一账户也报 `GRANT_REUSED`（#597 处理的问题），旧 authority 不会被另一请求复用。
- 客户端断开：HTTP 客户端超时或断开后，服务端处理不会中止，会在租约内继续跑完并落库（此前约 6 分钟后被拒）。最多花到 cap。
- 撤销投递缺口与 §3 相同：租约内停止一个 ICP 请求只能等它结束、等 cap 耗尽，或以 app_user 写撤销行。
- 不新增个人数据、数据源或出网。

### 8.6 部署与回退

- 迁移与带它的镜像在同一维护窗口上线，按名称顺序排在 #621（`20261010090000`）与 #622（`20261010100000`）之后。运行时按 `finished_at` 取库里最后完成的迁移，要求它与镜像里名字最大的迁移一致；切换时不能有发现 run 或 ICP 请求在跑。
- 合并顺序：#621、#622 先合，或三者合入后同一窗口部署。若本迁移先单独部署，之后再部署名字更早的 #621、#622，它们会最后完成，所有镜像都会报 `MIGRATION_REVISION_MISMATCH`；那时只能把它们的迁移改名排到 `20261010110000` 之后。静态测试无法检查部署顺序，这一条靠合并与部署时遵守。
- 回退：迁移只向前。正式回退是新迁移把 consume 的 CASE 与 CHECK 恢复为 `20261009170000` 的版本；先把已有的 ICP 租约置 NULL，否则旧 CHECK 校验失败。
- 应急（不换镜像）：以 owner 在一个事务里先执行 `SET LOCAL row_security = off`，再执行 `UPDATE "execution_budget_authority" SET "admission_lease_expires_at" = NULL WHERE "purpose" IN ('icp.design', 'icp.query_plan') AND "admission_lease_expires_at" > now()`（CHECK 允许 NULL），在跑的请求即回到 Grant 窗口。该表是 FORCE RLS：不是超级用户或 BYPASSRLS 的 owner 不加这一句时，策略会把行过滤掉，UPDATE 静默改 0 行；加了这一句则直接报错，不会误以为已生效。这一步不阻止新准入带租约，consume 的 CASE 要等正式回退的迁移上线才去掉。

### 8.7 与 #597 的交互

#597（草稿，与 main 冲突）在「之前的 Grant 已超过 60 秒容差」时才为 `icp.*` 开重试账户。本扩展合入后，原 authority 在租约内仍能核验。#597 换户前会强制关闭旧账户，旧 binding 之后的预留会失败，不会重复花钱；但「签发后约 6 分钟才能重试」的口径要在 #597 变基时改为按租约判断。

### 8.8 验收（需要真实调用，会花钱，由产品负责人发起）

- 用**新的** ICP 验证：10-10 失败的那个 ICP 换版后仍不能直接重做查询计划。账户键由 purpose、subject 与请求摘要决定，同一 ICP 的账户仍绑定旧 authority，新 Grant 开户报 `GRANT_REUSED`（`open_authorized_tool_budget_v1`，#597 处理的问题）。ICP 设计同理，要换一个还没设计过 ICP 的公司。
- 通过标准：查询计划越过约 6 分钟仍在预留并成功返回；其 authority 的租约为准入加 30 分钟；存在 `created_at > expires_at` 的预留。
