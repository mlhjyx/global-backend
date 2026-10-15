# 开发快速通道：源码 customer worker 只服务一个测试 workspace

> 生命周期：`GUIDE`
> 生命周期依据：[快速通道落地设计](../superpowers/plans/2026-10-14-dev-fast-lane.md) 的 as-built 运维说明；ADR-024 的登记例外见 [ADR registry](../adr/registry.md) ADR-024「2026-10-14 开发快速通道补充」

只在 development 用。目的：改了获客的活动代码或 workflow 代码后，不用每次发布、切换后端镜像，就能让**一个**测试 workspace 的卖方入驻理解、发现 run 与资格判定跑在从源码起的 worker 上。其余所有 workspace、所有 HTTP 写入、readiness 与 outbox relay 仍由已发布、已受证（attested）的镜像承担。pilot/production 里任何一个车道变量都会让进程在启动时拒绝运行。

本页只写与宿主无关的步骤。具体宿主上的环境文件位置、启动命令与回滚记录放在宿主自己的运维手册里；测试 workspace 的 UUID 不进本仓库。

## 1. 结构

| 角色 | 跑什么 | 做什么 |
| --- | --- | --- |
| 管理态 API | 已发布镜像（attested） | 所有 HTTP、readiness、outbox relay。relay 投递时，只把车道 workspace 的 `CompanyProfileCreated`、`DiscoveryRunRequested`、`QualifyRequested` 三条命令发到**开发用 Temporal**（loopback、明文）的 `understanding-dev-fast-lane-<workspaceId>` 队列，并给它们加执行超时；其余命令、其余 workspace 一律照旧发到原生 Temporal 的 `understanding` |
| 管理态 customer worker | 已发布镜像 | 照旧服务原生 Temporal 的 `understanding`，租约、readiness 都不变 |
| 车道 worker | 源码 worktree 的 `apps/api/dist`（无构建回执） | 只 poll 开发用 Temporal 上的车道队列；只注册 understanding、discovery、qualify 三组活动 |

为什么不用原生 Temporal：它的机器授权器把 customer 身份能 poll、能 start 的队列钉死为 `understanding`（`infra/temporal-platform/server/readerpolicy/machine_policy.go` 的 `workerQueue`），车道队列会被拒绝。改授权器要重发原生 Temporal 镜像，所以车道改用开发用 Temporal，它还自带 UI 和 terminate 工具，方便观察和清理。

车道 worker 与管理态 worker 的差异都是刻意的：

- 不写 `runtime_process_lease`，管理态 worker 与 API readiness 看不到它；
- 不拿 owner 数据库连接（不需要 `DATABASE_URL`），不跑 data_provider、jurisdiction_policy、sanctions 三个平台 seed，不能改写跨租户的平台表；
- 不拿机器令牌，不连原生 Temporal；
- 不需要 browser、image pipeline、renderer 与建站、擦除相关的活动；
- 迁移版本取自源码树最新的迁移目录名，schema 摘要取自源码的 `packages/db/prisma/schema.prisma`；
- 网关、ToolBroker、分类器、制裁筛查与三组活动的构造与 `worker.ts` 逐字相同，由 `worker-dev-fast-lane.source.spec.ts` 守住。

## 2. 变量

| 变量 | 谁读 | 取值 |
| --- | --- | --- |
| `RUNTIME_DEV_FAST_LANE_WORKSPACE_ID` | API、车道 worker | 空 = 关；否则恰好一个小写规范 UUID |
| `RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS` | API、车道 worker | 开发用 Temporal 的 `127.0.0.1:<端口>`、`localhost:<端口>` 或 `[::1]:<端口>` |
| `RUNTIME_DEV_FAST_LANE_SCHEMA_DIGEST` | 车道 worker | 管理态 API `/health/build` 返回的 `schema_digest`，原样复制 |

- 三个变量都只经 `resolveDevFastLane`（`apps/api/src/runtime/dev-fast-lane.ts`）读取。test、pilot、production 里任何一个非空，进程启动即失败（`DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT`）；development 里只设后两个、不设 workspace，也失败（`DEV_FAST_LANE_CONFIGURATION_INVALID`）。
- compose 只把前两个转发给 `api` 服务，默认空；worker、platform-worker 与共享锚点都没有。
- 车道 worker 进程必须显式 `APP_ENVIRONMENT=development`、`NODE_ENV=production`。

## 3. 车道保证什么，不保证什么

- **迁移**：车道 worker 只保证「源码树最新的迁移名 = 数据库最新完成的迁移名」（`MIGRATION_REVISION_MISMATCH` 否则不 poll）。这不是 schema 等价：schema 可能不带迁移地变化。
- **schema**：源码 `schema.prisma` 的 sha256 必须等于管理态镜像的 `schema_digest`（`SCHEMA_DIGEST_MISMATCH` 否则不 poll）。构建前要按这份 schema 重新生成 Prisma client。
- **覆盖范围**：车道只换掉三个 workflow 的 workflow 体与活动体。下面这些仍是管理态镜像的代码，改它们必须换镜像：
  - workflow 的输入（relay 拼装，`outbox-relay.service.ts` 的 dispatch）；
  - outbox 命令的 payload（API 写入，例如 `company.service.ts`、`discovery.service.ts`）；
  - 事件注册表（`relay/event-registry.ts`）：车道代码发出的命令或事件如果不在旧镜像的注册表里，或不合合同，会被 park；
  - API 进程内同步执行的获客操作：ICP 设计、查询计划、回测、discover-contacts、guess-emails、verify。
- **understanding 只能由新建公司触发**：`CompanyProfileCreated` 只在 `POST /companies` 时写入，每次还要用掉一张 GrowthOS grant。
- **擦除**：`DeletionRequested`、`PersonalArtifactCleanupRequested` 留在管理态。车道分支不得改 durable-result、artifact、raw 的持久化格式和对象版本语义，否则旧代码可能擦不干净；做不到就只用不含真实个人数据的 workspace 跑车道。删除流程发出的重评分 `QualifyRequested` 也会进车道，车道 worker 停着时它会在 30 分钟后超时作废。车道 workflow 的历史（输入与活动结果）存在开发用 Temporal 自己的本地库里，保留期按它的配置；擦除流程不清理 Temporal 历史，这一点与原生 Temporal 相同。
- **readiness**：车道开启时 `/health/ready` 多一个 `capabilities.dev_fast_lane = {status: not_proven, code: DEV_FAST_LANE_UNATTESTED_ROUTING}`。它永远不会 ok，也不参与整体状态和客户写入准入。巡检工具把它列为非 ok 能力属预期。`/health/build` 报告的仍是 API 自己的受证构建，不代表车道 worker。
- **证据**：车道时段的观察不能作为 RuntimeEvidence PASS 依据，不能进入 PILOT/GA Release Bundle。要记录时 `evidence_kind` 以 `dev-fast-lane-` 开头、`environment=development`，正文写明「worker 为源码 unattested，API 为受证镜像」；验证器会拒绝非 development 的车道证据，也拒绝把车道 kind 写进 release chain 的 `required_evidence_kinds`。

## 4. 前置

1. 运行中的镜像必须已经包含本功能（含 `DevFastLaneTemporalClient` 的 relay）。首次落地要发布一次镜像并换上；如果主线在那之前带了迁移，按带迁移的换镜像流程走。
2. 开发用 Temporal 在 loopback 上可达，namespace `default` 存在。
3. 车道 worktree 从**运行镜像的源提交**创建（`/health/build` 的 `build_sha`），再叠加要测的提交，不要从最新 main 创建：main 若已多出迁移或 schema 改动，车道 worker 会停在 `MIGRATION_REVISION_MISMATCH` 或 `SCHEMA_DIGEST_MISMATCH`。
4. 在 worktree 里：安装依赖 → `pnpm --filter @global/db generate` → `pnpm --filter @global/api build`。不要往 `apps/api/dist` 放任何 `build-attestation.json`，也不要设 `RUNTIME_IMAGE_REFERENCE`：有回执却不匹配会得到 `BUILD_ATTESTATION_INVALID`，进程按管理态规则停住。

## 5. 起车道 worker（先于打开路由）

先起 worker 再开路由：poll 一条空队列没有副作用；反过来，路由开着而 worker 没起，入驻的 understanding 每步都要核验 5 分钟有效的 workspace grant，约 6 分钟后就会因 `EXECUTION_BUDGET_GRANT_EXPIRED` 失败。

1. 环境文件（0600，不进仓库）：取管理态 customer worker 的同一套配置（`backend-runtime.env`、`backend-worker-runtime.env` 与 compose 锚点里的路径变量，容器内路径换成宿主路径），然后：
   - **删掉** `DATABASE_URL`、`RUNTIME_WORKER_LEASE_DATABASE_URL`、`MACHINE_BOOTSTRAP_*`、`TEMPORAL_MACHINE_*`、`TEMPORAL_ADDRESS`、`TEMPORAL_TLS_*`、`GENERIC_OPERATION_ARTIFACT_CLEANUP_S3_*`、`RUNTIME_IMAGE_REFERENCE`；
   - **加上**第 2 节的三个变量；`SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE` 指向宿主上的常规文件（0600，不经符号链接）。
2. 用 `DOTENV_CONFIG_PATH` 指向这份文件后启动 `node apps/api/dist/temporal/worker.js`（`worker.ts` 开头的 `dotenv/config` 就不会去读 worktree 的 `apps/api/.env`），记录 PID。一次只起一个车道 worker。
3. 期望日志：`[worker] DEV FAST LANE: unattested source worker for workspace … on task queue 'understanding-dev-fast-lane-…'` → 依赖准入 → `[worker] dev fast lane worker up on task queue '…'`。

| 停在 | 含义 |
| --- | --- |
| `DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT` | `APP_ENVIRONMENT` 不是 development |
| `DEV_FAST_LANE_*_INVALID` / `DEV_FAST_LANE_CONFIGURATION_INVALID` | 变量取值或组合不对（进程退出） |
| `not ready: build:DEV_FAST_LANE_UNATTESTED,…` | 除缺回执外还有准入项失败（例如 `environment:MANAGED_NODE_ENV_REQUIRED`），按管理态规则停住 |
| `DEV_FAST_LANE_SCHEMA_DIGEST_REQUIRED` / `SCHEMA_DIGEST_MISMATCH` | 没给或给错了期望 schema 摘要，或 worktree 的 schema 与镜像不同 |
| `MIGRATION_REVISION_MISMATCH` | worktree 的迁移与数据库不一致；不要手改库，换 worktree 的基线 |
| `DEV_FAST_LANE_TEMPORAL_UNAVAILABLE` | 开发用 Temporal 不可达 |
| 一行 `RUNTIME_DEV_FAST_LANE_WORKSPACE_ID is set but this process is not the fast-lane worker` | 这是一个有效回执的受证进程，它按管理态继续，不进车道 |

## 6. 打开 API 路由

1. **前置检查**（只读）：该 workspace 没有未发布、未停靠的三类命令，也没有 `RUNNING` 的 discovery run。路由在 relay **投递时**决定，不在命令写入时决定：开关前写入、开关后才投递的行跟随新路由。

   ```sql
   SELECT count(*) FROM outbox_event
    WHERE workspace_id = '<ws>' AND published_at IS NULL AND parked_at IS NULL
      AND event_type IN ('CompanyProfileCreated', 'DiscoveryRunRequested', 'QualifyRequested');
   SELECT count(*) FROM discovery_run WHERE workspace_id = '<ws>' AND status = 'RUNNING';
   ```

2. 在管理态 runtime 的 compose 插值环境里设 `RUNTIME_DEV_FAST_LANE_WORKSPACE_ID` 与 `RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS`，**只重建 api 服务**（环境变了要重建，不是重启）；worker、platform-worker 不动。两个变量必须一起设、取值合法：API 对不合法的车道配置拒绝启动（进入重启循环，期间所有写入不可用），回退就是删掉这两个变量再重建 api。
3. 核验：`/health/build` 仍 `attested: true`；`/health/ready` 仍 `ready`，并出现 `capabilities.dev_fast_lane`；与开关前的快照相比只允许 `ts` 与这个键不同。API 启动日志有一行 `[api] DEV FAST LANE: …`。

## 7. 验收（有界样本）

用测试 workspace 发起一次小规模操作。车道 worker 日志命中对应的 workflowId（`discovery-<runId>`、`qualify-<icpId>`、`understanding-<companyId>`），管理态 worker 日志对它们零命中；开发用 Temporal 的 UI 能看到这些 workflow；`/health/ready` 的 `components.worker` 仍 ok；`runtime_process_lease` 没有车道 worker 的行。

## 8. 迭代

1. 先确认该 workspace 没有在途的车道 workflow（以 discovery run 与 outbox 为准，或看开发用 Temporal UI）。
2. 只改活动代码：SIGTERM 停车道 worker（按 PID）→ build → 重新启动。
3. 改了 workflow 代码：要么先排空在途 workflow，要么用 `patched()` 做版本演进（`discovery.workflow.ts` 已有先例）。新代码重放旧历史会报不确定性错误（NDE），workflow task 无限重试，run 一直停在 RUNNING。

## 9. 关闭

1. 等测试 workspace 的在途 run 结束；第 6 节的前置检查同样适用。
2. 从 compose 插值环境里删掉两个变量，只重建 api；核验 `/health/ready` 不再有 `capabilities.dev_fast_lane`。
3. 按 PID 停车道 worker。不要按命令行 pkill：宿主网络下，管理态容器的 node 进程在宿主进程表里同样可见。
4. 清理孤儿：车道队列上没人 poll 的 workflow 会在执行超时后结束（发现 run 185 分钟，理解与资格判定 30 分钟），也可以在开发用 Temporal 上直接 terminate。超时或 terminate 都不跑收尾，对应的 discovery run 会一直是 `RUNNING`：确认没有在跑的 workflow 后，由运维用属主连接把它标为 `FAILED`。不要留着它：换镜像的前置检查会因 `RUNNING` 的 discovery run 拒绝切换。

## 10. 与其他操作的关系

- **换后端镜像前先关车道**：换镜像工具会比较切换前后的 readiness，只容忍时间戳不同；切换期间车道状态不同就会在核验一步失败。
- 车道开着时不要跑不带 workspaceId 的 backlog、external-intent sweep：它们遍历所有 ACTIVE ICP，会在 `understanding` 上用旧代码处理测试 workspace。恢复平台 schedule 前先关车道。
- 车道 worker 不取机器令牌，不占用 GrowthOS 的机器令牌签发配额；workspace grant 的核验与预留与管理态相同。
