# AI 获客运行治理证据合同

状态：`SOURCE_ONLY` / `NOT_DEPLOYED` / `MIGRATION_NOT_RUN` / `REAL_POSTGRES_NOT_RUN` / `REAL_TEMPORAL_NOT_RUN`

本文件说明 AI 获客运行治理切片的源码合同。它不是当前 Ubuntu 服务状态证明，也不授权迁移、重启、外部源调用、模型调用或费用。只有绑定 exact commit、构建回执、迁移版本和环境的 RuntimeEvidence/Release Bundle 才能把这些能力升级为运行事实。

## 1. 本切片解决什么

本切片收口五个互相关联的运行风险：

1. `signal_ingest` 从“最终 upsert 去重”升级为外部请求前的 `PENDING` lease + token + fencing；
2. Temporal Schedule 明确区分代码所有字段和运维所有字段，并持久记录观察/修复结果；
3. workflow 生命周期、worker polling 和 Schedule 状态形成不含 PII 的持久证据；
4. 新 workflow 按 acquisition、site-builder、maintenance 三个任务队列隔离并发，旧 `understanding` 队列只负责安全 drain；
5. 提供 `/health/ready`、受限 `/health/ops` 可消费的只读聚合端口，但本切片不修改 health controller 或 runtime identity controller。

### 明确不在本切片内

- 不部署或重启 API、worker、Temporal、PostgreSQL、Compose、systemd；
- 不执行迁移，不读 `.env`，不使用真实凭据；
- 不调用 provider、付费模型或任何真实外部源；
- 不实现健康 HTTP controller；由 runtime identity/health 集成切片把本端口接入现有健康合同；
- 不替代持久预算账本、Outbox 数据库单写者租约或 APP/OWNER DB admission；这些由相邻治理切片负责；
- 不移除 legacy task queue，也不强迁移历史 workflow。

## 2. Signal ingest lease 状态机

唯一业务键仍为 `(provider_key, query_fingerprint, window_key)`。`source_signal` 最终 upsert 继续作为第二层幂等保护，但不再承担阻止重复外部拉取的全部责任。

```text
无账本行 ──原子 create──> PENDING(live lease, fence=1, attempt=1)
ERROR ──条件 reclaim──> PENDING(new token, fence+1, attempt+1)
expired PENDING ──条件 reclaim──> PENDING(new token, fence+1, attempt+1)
live PENDING ─────────> lease_busy（零外部调用）
PENDING ──同 token+fence settle──> OK
PENDING ──同 token+fence fail────> ERROR
OK ───────────────────> ledger_hit（零外部调用）
```

关键不变量：

- lease 必须在 broker 调用前原子取得；并发 create 的唯一键冲突会重新观察，而不是直接出网；
- 只有 lease owner、token、fence、`PENDING` 全部匹配的 attempt 才能续租或 settle；
- lease 过期后，新 owner 用条件更新递增 fence；旧 attempt 不能覆盖新 owner 的账本；
- broker 返回后，系统在同一数据库事务内以 owner+token+fence+未过期条件续租并取得账本行锁，再写 `source_signal`，最后以同一 fence 结算 `OK`；事务提交前 successor 无法抢占，续租失败则零 `source_signal` 写入；
- `source_signal` 持久化或 `OK` 结算失败会回滚同一事务，不允许“信号已写但账本未结算”的部分成功；事务外只以原 fence 尝试写闭合 `SIGNAL_PERSIST_FAILED`，若 fence 已丢失则不得覆盖 successor；
- `BudgetExceededError` 仍向 Temporal 传播，但先把当前 lease 结算为机器码 `BUDGET_EXCEEDED`，避免僵死到超时；
- `lease_busy` 是零外部调用结果，不计入 `fetches`；`lease_lost` 若发生在真实 fetch 之后仍如实计入尝试；
- production 默认 lease 为 35 分钟；`SIGNAL_INGEST_LEASE_MS` 只接受 1 秒至 60 分钟的无歧义整数毫秒值。

数据库约束要求 `PENDING` 必须同时具有 owner、UUID token、到期时间且 `completed_at IS NULL`；`OK/ERROR` 必须清空 lease 所有权。`app_user` 保留 ingest 所需的 INSERT/UPDATE，但不再拥有 DELETE。

## 3. Temporal Schedule 所有权与漂移治理

每个 Schedule 的代码合同由 `schedule-governance.ts` 统一注册。代码和运维字段的所有权如下：

| 所有者 | 字段 | 行为 |
|---|---|---|
| 代码 | workflow type、task queue、args、workflow execution timeout、schedule schema version、overlap=`SKIP`、catchup window=1 分钟 | 观察到漂移时自动修复；两个 policy 是防重入/防陈旧 catchup 的安全合同 |
| 运维 | cadence/spec、paused、note、remaining actions | 更新 action 时逐字保留，不自动取消暂停或覆盖 cadence override |

所有 8 个平台 Schedule 使用同一 registry。三个历史单 Schedule 脚本也从该 registry 创建 action，避免再次写出缺 schema/version/timeout 的旧合同。

每次启动和每 5 分钟默认一次的受控观察会记录 append-only `schedule_drift_receipt`：

- `CREATED`、`IN_SYNC`、`RECONCILED` 或 `FAILED`；
- desired/observed code hash 和发生变化的机器字段名；
- paused、下一次动作时间、missed catchup 累计数、skipped overlap 累计数；
- worker build SHA 与闭合错误码。

receipt 不保存 cadence、operator note、workflow args、Temporal 错误文本或 token。初次 describe 失败、create 失败、create race 后 describe 失败、update 失败都会得到机器码失败证据。每次 update 后必须立即重新 describe；只有 post-update `observed_hash == desired_hash` 且 changed fields 已清空，才写 `RECONCILED`，否则写 `SCHEDULE_POST_RECONCILE_DESCRIBE_FAILED` 或 `SCHEDULE_POST_RECONCILE_DRIFT` 并使启动失败。若 Temporal 在建立连接前不可达，则没有新 receipt，健康读模型通过 receipt freshness 超时发现证据中断。

## 4. Worker 拓扑与 legacy drain

| Domain | Task queue | 默认 activity/workflow 并发 | 新 workflow |
|---|---|---:|---|
| legacy drain | `understanding` | 2 | 禁止；只承接切分前已存在的历史执行 |
| acquisition | `acquisition` | 8 | understanding、discovery、qualify、acquisition/intent/backlog/external-intent sweep |
| site builder | `site-builder` | 4 | demo、refurbish、KB ingest/recovery |
| maintenance | `maintenance` | 2 | deletion、patents、sanctions、asset cleanup、site release maintenance |

每个队列是独立 Temporal Worker 和独立并发预算，但当前仍在一个 OS worker 进程内共享受控依赖。任一 Worker `run()` 致命退出时，fleet runner 会先 shutdown 其余 poller、等待 drain，再保留并抛出原始失败；不允许进程处于“部分队列仍活着”的假健康状态。

`LEGACY_WORKER_CONCURRENCY`、`ACQUISITION_WORKER_CONCURRENCY`、`SITE_BUILDER_WORKER_CONCURRENCY`、`MAINTENANCE_WORKER_CONCURRENCY` 只接受 1–64 的规范整数。切分后不得立即删除 `understanding` poller；必须先用 Temporal 可审计查询证明旧队列没有 open workflow，再由独立变更退役。

## 5. Workflow receipt 与 worker heartbeat

新 workflow history 通过 `workflow-run-receipt-v1` patch marker 启用 lifecycle interceptor。旧 history replay 时 marker 不存在，interceptor 不引入新的 Local Activity command，避免 nondeterminism。

`workflow_run_receipt` 是 append-only、幂等的生命周期事实：

- `STARTED`、`COMPLETED`、`FAILED`；
- workflow/run/type/task queue、可选 workspace UUID、worker build SHA；
- bounded stage、最多 32 个非负整数统计值、闭合错误码、budget truncation、retry attempt；
- receipt key = run/attempt/phase/stage 的 SHA-256。

结构上不接受 workflow args、result、message、error text、联系人值或 provider payload。成功结果只读取精确布尔字段 `budgetTruncated === true`，不复制结果；失败只接受闭合 `error.code`，已知 `BudgetExceededError` 映射为 `BUDGET_EXCEEDED`，其他失败归一为 `WORKFLOW_FAILED`。

`worker_heartbeat` 是唯一可变的运行状态表，以 `(worker_instance_id, task_queue)` upsert。每个进程默认每 15 秒记录 polling/build/concurrency，停机前写 `STOPPING`。它不保存 hostname、IP、用户名、环境变量或凭据。

pilot/production 必须提供受 attestation 约束的 40/64 位十六进制 build SHA；只有显式 development 可使用 `development-unattested`。最终集成时应由 runtime identity 的不可变 build receipt 提供该值，而不是从脏工作树推断。

## 6. 健康读模型端口

`RuntimeOpsReadService` 只返回非 PII 聚合：

- 预期队列中 active/stale/missing poller；
- 当前 active worker build SHA 与 unexpected build；
- 预期 Schedule 中 missing、drifted（包括 disposition 失败、observed hash 缺失或与 desired hash 不同）、paused、late、unobservable、freshness stale；
- 自上次观察新增的 missed catchup/skipped overlap；
- 最近 24 小时 workflow failed/budget-truncated 数量；
- signal ingest pending、expired lease、error 数量。

`ready=true` 要求所有预期 poller、构建、Schedule 和 lease 指标均健康，且近期没有失败/预算截断。健康 controller 接入时必须显式注入：

- `WORKER_DOMAINS` 的预期 task queues；
- 当前不可变 build SHA；
- `PLATFORM_SCHEDULES` 的预期 IDs；
- heartbeat freshness、Schedule lateness tolerance、Schedule observation freshness。

该聚合需要平台级只读数据库连接。普通 workspace `app_user` 在 FORCE RLS 下只能看到自己的非空 `workflow_run_receipt`；不能用单租户视图冒充平台全局健康。HTTP 层仍必须由 `ops:read` scope 保护。

建议默认：heartbeat freshness 45 秒、Schedule observation freshness 15 分钟、lateness tolerance 2 分钟。实际值应在 deployment manifest 中冻结。

## 7. 数据库权限与迁移顺序

迁移 `20260808010000_runtime_ops_evidence`：

- 扩展 `signal_ingest` lease/fence/state 约束；
- 创建 `workflow_run_receipt`、`worker_heartbeat`、`schedule_drift_receipt`；
- workflow receipt 启用并强制 workspace RLS；空 workspace 行只对平台连接可见；
- app role 对三张 ops 表只读；workflow/schedule receipt 额外由 trigger 阻止 UPDATE/DELETE；
- Schedule/workflow receipt 不通过普通 API 物理删除。

安全升级顺序：

1. 在隔离恢复环境先验证 migration forward；
2. 部署包含新 Prisma Client 的代码；
3. 执行 migration；
4. 只启动绑定 exact build receipt 的 worker；
5. 验证四个队列 heartbeat、8 个 Schedule receipt 和 health 聚合；
6. 最后允许新的 workflow start。

本迁移是向前兼容的列/表扩展；紧急代码 rollback 不应删除新表、列或审计证据。任何 schema downgrade 必须另立经批准的迁移，并先导出证据摘要，禁止手工 DROP/TRUNCATE。

上线前必须预查存量 `signal_ingest.status` 只含 `OK/ERROR`；发现未知状态时迁移应停止，不做静默归一。

## 8. 隔离 PostgreSQL verifier

`apps/api/scripts/verify-runtime-ops-postgres.mts` 默认在创建 Prisma client 之前拒绝运行。它不会加载 `.env`，仅接受：

- `RUNTIME_OPS_ISOLATED_VERIFY=true`；
- loopback PostgreSQL；
- 数据库名严格匹配 `runtime_ops_disposable_[a-z0-9]{6,48}`；
- URL 与显式数据库名逐字绑定；
- 目标不得等于任何 APP/OWNER/relay/shared database URL。

调用者必须先创建并迁移专用 disposable 数据库，再通过 secret reference 注入只属于该数据库的凭据。不要把密码写进命令行、文档、日志或 evidence。授权后从仓库根运行：

```bash
RUNTIME_OPS_ISOLATED_VERIFY=true \
RUNTIME_OPS_ISOLATED_DATABASE_NAME=runtime_ops_disposable_<suffix> \
RUNTIME_OPS_ISOLATED_DATABASE_URL="$RUNTIME_OPS_DISPOSABLE_SECRET_URL" \
pnpm --filter @global/api exec tsx scripts/verify-runtime-ops-postgres.mts
```

verifier 证明表/RLS/权限/append-only trigger、workspace 负例、live lease 不可被抢和正确 fence settle；所有 fixture 在事务中 rollback。当前交付没有获得 isolated DB 授权，因此真实 PostgreSQL verifier 保持 `NOT_RUN`。

## 9. 部署前剩余集成门

- 将 worker 的 owner connection 合并到统一 `OWNER_DATABASE_URL` resolver/admission，禁止回退到普通 `DATABASE_URL`；
- 用 runtime identity 的 immutable build receipt 替换本切片的 build SHA port；
- 将 `RuntimeOpsReadService` 接入受 `ops:read` 保护的 `/health/ops`，并按既有 health 合同决定 `/health/ready` 的依赖；
- 与 durable acquisition budget 和数据库 Outbox lease 切片一起回归多副本；
- 在隔离 PostgreSQL 和 Temporal test server 执行 migration、RLS、actual replay、worker restart、Schedule missed-catchup/cadence/pause 演练；
- Release Bundle 必须记录 exact commit、build/artifact digest、migration revision、队列、并发、freshness 阈值及验证结果。
