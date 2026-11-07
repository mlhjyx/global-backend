# D-MA-7 · 记忆与学习层 v0 落地设计文档（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：D-MA-7 已于 2026-11-08 由产品负责人批准（协调计划 §0.7-G）；同日产品负责人批准本文 D-1~D-8 按推荐值（「批准」），按计划 §0.6 进入 TDD。
> 批准记录：2026-11-08 产品负责人确认 D-1~D-8 全部按推荐值；本文由 DRAFT 转 APPROVED。
> 任务启动门（§0.6）：① 设计文档（本文）② 闭环设计（§7）③ 联网研究（§11）→ 产品负责人过目批准 → TDD。
> 定位：M1.5 与 M2 之间的小步；M2.1 规划器「先有记忆与归因」的前置，只落表与检索，不做策略消费。

## 1. 背景与目标

### 1.1 背景

- D-MA-3 把主脑定为「受限规划器（propose-only）」：M2.1 先 shadow，M2.2 才有有界重规划。前提是**先有记忆与归因**，否则规划器只能凭当次上下文拍脑袋。
- 计划 §0.7-F3 的调研结论：主流记忆层已从「写时 LLM 合并」转向「保留历史 + 检索期排序 + 后台整合」（Mem0 v3 ADD-only；Zep 双时间失效不删）。本项目取最小实现：两张表 + SQL 检索 + 防投毒 + 置信门，**不做**向量库/图数据库/LLM 写时合并。
- 本设计只覆盖 v0：`mem_run_episode`（episodic）与 `mem_knowledge_stat`（semantic）两表、事件驱动写入、SQL 检索与 memory brief。**不实现**自动调策略、探索流量、Thompson 采样决策、前端过程页。

### 1.2 目标（可验收）

1. `mem_run_episode` append-only；同一 workflow/run 的两个时点（run 完成、结果回填）各恰一行，事件重放不产生重复。
2. `mem_knowledge_stat` 只追加版本；scope 键 + Beta-Binomial 计数 + `valid_from/valid_to`；`n >= 30` 且 95% CI 足够窄且 kill switch 打开时才标 `mayInfluenceStrategy=true`，否则只作提示。
3. 检索走 SQL 精确/层级查询；`buildMemoryBrief` 输出 <2k token、每条事实带出处（表 + 行 id + 事件 id + valid 时间）。
4. 语义表只有受信服务角色可写；普通 `app_user` 写入被拒；跨租户不可见。
5. 零现有行为变化：不改 `discovery.activities.ts` / `discovery.workflows.ts` / ai-trace / 预算账本 / gain-saas / skill runtime 文件；消费者默认关闭。

### 1.3 非目标（明确不做）

- 不做「自动调策略」与探索流量（5–10% 探索、Brier/校准监控均留到 M2.2）。
- 不做向量检索、embedding、图关系、LLM 写时合并或摘要。
- 不新增对外事件；不新增 ToolBroker 工具；不暴露公共 HTTP API。
- 不回填历史 run；v0 只从启用时刻起积累。
- 不做 DSR 物理删除路径（episode 不含个人数据；见 §8.4）。

## 2. 现状核对（2026-11-08，main `6bd421a0`）

| 事实 | 证据 |
| --- | --- |
| run 收尾在 finalize 事务内写 `DiscoveryRunCompleted`，payload 含 `planId/status/stats/cost/costBasis/taskRef?` | `apps/api/src/temporal/discovery.activities.ts:3464`（**本设计不修改该文件**） |
| 评分完成后写 `LeadsScored`，aggregate=`ICP`，payload 含 `{scored, queues}` | `apps/api/src/temporal/qualify.activities.ts:260` |
| `DiscoveryRunCompleted` / `LeadsScored` 都是 integration 事件，由 relay 路由进交付账本 | `apps/api/src/relay/event-registry.ts:19-30` |
| relay 以 owner 连接跨租户扫描 outbox；域服务以 `app_user` + RLS 运行 | `apps/api/src/relay/outbox-relay.service.ts` 顶部注释；`apps/api/src/prisma/prisma.service.ts` |
| `DiscoveryRun` 有 `workspaceId/planId/icpId/status/stats/completedAt`，唯一键 `(workspaceId,id)` | `packages/db/prisma/schema.prisma:1453` |
| `Lead.status` 枚举含 `QUALIFIED` | `packages/db/prisma/schema.prisma:2521` |
| 现无任何 `mem_*` 表或记忆层代码 | 全仓检索 `mem_` 无命中 |
| `outbox_event` 只有 `(publishedAt)`、`(workspaceId)` 索引 | `packages/db/prisma/schema.prisma:762` |

约束：本设计**不得**修改 `apps/api/src/temporal/discovery.activities.ts` 与 `discovery.workflows.ts`（整改线在飞）、ai-trace、budget 账本、gain-saas、skill runtime 文件。episode 写入必须走 outbox 事件消费者。

## 3. 承重假设与证伪条件

| # | 假设 | 若被证伪 |
| --- | --- | --- |
| A1 | `DiscoveryRunCompleted` 每个 run 终态只成功写一次；重复尝试不重发（现有注释与测试支持） | 唯一键 `(workspace,workflow,run,phase)` 仍保证可观察结果恰一行 |
| A2 | run 收尾后触发 `QualifyRequested` → 评分 → `LeadsScored`；`discovery_run.icp_id` 能把事件与 run 关联 | 若评分被合并/跳过，phase 2 可能延后；由**后续任一次** `LeadsScored` 在回看窗口内补齐；窗口外缺失按「未回填」处理并在 brief 标注 |
| A3 | `outbox_event` 行只追加、可按 `(event_type, occurred_at)` 扫描 | 若表被清理，回看窗口内的事件仍可处理；更早的丢失不影响 v0 增量 |
| A4 | `app_user` 连接强制 RLS，owner 只用于跨租户扫描 | 若生产误用 owner 跑域逻辑，跨租户负向测试会失败并阻断发布 |
| A5 | episode 只存聚合计数与事件元数据，不含个人数据 | 若未来 payload 引入 PII，必须先接 DSR/保留策略再启该字段 |
| A6 | `n>=30` + CI 宽度门足以避免噪声驱动策略 | 阈值是 env 可调的保守默认；v0 默认 `hint_only`，不产生策略影响 |
| A7 | 消费者默认关闭 = 零现有行为变化 | 迁移为 additive；消费者无写入时无副作用 |

## 4. 触点与数据模型

### 4.1 触点清单

| 文件/目录 | 动作 | 说明 |
| --- | --- | --- |
| `packages/db/prisma/schema.prisma` | 修改 | 新增 `MemRunEpisode` / `MemKnowledgeStat` 模型；`DiscoveryRun` 增加反向关系；`OutboxEvent` 增加 `(eventType, occurredAt)` 索引声明 |
| `packages/db/prisma/migrations/20261108120000_memory_layer_v0/migration.sql` | 新增 | 建表、约束、索引、RLS、授权、语义写角色、outbox 索引 |
| `apps/api/src/memory/memory.module.ts` | 新增 | Nest 模块 |
| `apps/api/src/memory/memory-episode.consumer.ts` | 新增 | outbox 事件消费者（默认关闭） |
| `apps/api/src/memory/memory-query.service.ts` | 新增 | SQL 检索 + memory brief |
| `apps/api/src/memory/memory.contracts.ts` | 新增 | payload 白名单解析、类型、置信度计算 |
| `apps/api/src/memory/*.spec.ts` | 新增 | 单测/负向测试 |
| `apps/api/src/memory/memory.postgres.spec.ts` | 新增 | RLS/授权/幂等真库测试 |
| `apps/api/src/app.module.ts` | 修改 | 注册 `MemoryModule` |
| `docs/governance/app-user-table-privileges.json` | 修改 | 登记两表对 `app_user` 的权限 |
| `docs/roadmap/changelog.d/2026-11-08-memory-layer-v0.md` | 新增（实现 PR） | 代码 PR 必需片段 |

**明确不碰**：`discovery.activities.ts`、`discovery.workflows.ts`、`relay/outbox-relay.service.ts`、`ai-trace`、`usage_ledger`/预算账本、`gain-saas`、`skill-runtime` 相关文件。

### 4.2 `mem_run_episode`（episodic，append-only）

```sql
CREATE TABLE mem_run_episode (
  id                      uuid PRIMARY KEY,                 -- Prisma @default(uuid()) 客户端生成
  workspace_id            uuid NOT NULL,
  workflow_type           varchar(32) NOT NULL,          -- v0: 'discovery'
  run_id                  uuid NOT NULL,                 -- discovery_run.id（未来按 workflow 解释）
  phase                   varchar(32) NOT NULL,          -- 'run_completed' | 'results_backfilled'
  occurred_at             timestamp(3) NOT NULL,         -- 源事件 occurred_at
  source_event_id         uuid NOT NULL,                 -- outbox_event.event_id
  payload                 jsonb NOT NULL,                -- 白名单聚合，≤16KB
  provenance              jsonb NOT NULL,                -- event_type/schema_version/producer/correlation/causation
  privacy_classification  varchar(32) NOT NULL,
  created_at              timestamp(3) NOT NULL DEFAULT now(),
  CONSTRAINT mem_run_episode_phase_check CHECK (phase IN ('run_completed','results_backfilled')),
  CONSTRAINT mem_run_episode_payload_size_check CHECK (pg_column_size(payload) <= 16384),
  CONSTRAINT mem_run_episode_run_fkey FOREIGN KEY (workspace_id, run_id)
    REFERENCES discovery_run (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT mem_run_episode_key UNIQUE (workspace_id, workflow_type, run_id, phase)
);
CREATE INDEX mem_run_episode_lookup_idx ON mem_run_episode (workspace_id, workflow_type, run_id, occurred_at);
CREATE INDEX mem_run_episode_event_idx ON mem_run_episode (source_event_id);
```

- **append-only**：`app_user` 只授 `SELECT, INSERT`；不授 `UPDATE/DELETE`。owner 保留运维清理能力（保留期/DSR 未来由 owner 执行）。
- **两时点各一行**：`phase` 区分；`(workspace,workflow,run,phase)` 唯一。这是对「workflow/run 唯一」的落地解释（见决策 D-2）。
- 与 `discovery_run` 复合外键保证 run 存在且同租户；run 被 DSR 级联删除时 episode 一并删除。
- `payload` 白名单（v0）：
  - `run_completed`：`planId`、`status`、`cost`、`costBasis`、`taskRef`（可选）、`stats`（仅保留计数结构，见 §5.2）。
  - `results_backfilled`：`scored`、`queues`（来自 `LeadsScored`）。
  - 解析时拒绝未知顶层键，防止未来事件字段把 PII 带进来。

### 4.3 `mem_knowledge_stat`（semantic，只追加版本）

```sql
CREATE TABLE mem_knowledge_stat (
  id                      uuid PRIMARY KEY,                 -- Prisma @default(uuid()) 客户端生成
  workspace_id            uuid NOT NULL,
  scope_type              varchar(32) NOT NULL,   -- workspace | icp | source | channel | industry | country
  scope_key               varchar(200) NOT NULL,  -- uuid 或规范键；长度 1..200
  stat_key                varchar(64) NOT NULL,   -- qualify_rate | reply_rate | source_yield ...
  successes               integer NOT NULL,       -- Beta-Binomial 成功计数
  failures                integer NOT NULL,       -- 失败计数
  valid_from              timestamp(3) NOT NULL,
  valid_to                timestamp(3),           -- NULL = 开区间；否则必须 > valid_from
  supersedes_id           uuid,                   -- 上一版本（可空，仅溯源）
  provenance              jsonb NOT NULL,         -- 源（系统 of record）/抽样窗口/写入者/run id 列表
  privacy_classification  varchar(32) NOT NULL,
  created_at              timestamp(3) NOT NULL DEFAULT now(),
  CONSTRAINT mem_knowledge_stat_scope_check CHECK (scope_type IN ('workspace','icp','source','channel','industry','country')),
  CONSTRAINT mem_knowledge_stat_key_check CHECK (char_length(scope_key) BETWEEN 1 AND 200 AND char_length(stat_key) BETWEEN 1 AND 64),
  CONSTRAINT mem_knowledge_stat_counts_check CHECK (successes >= 0 AND failures >= 0),
  CONSTRAINT mem_knowledge_stat_validity_check CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT mem_knowledge_stat_key UNIQUE (workspace_id, scope_type, scope_key, stat_key, valid_from)
);
CREATE INDEX mem_knowledge_stat_lookup_idx
  ON mem_knowledge_stat (workspace_id, scope_type, scope_key, stat_key, valid_from DESC);
```

- **只追加版本**：不更新旧行；新版本插入新 `valid_from`，检索取「当前窗口内 `valid_from` 最大」的一行。旧行保留用于回溯。
- **防投毒**：`app_user` 只授 `SELECT`；写入只授给 `memory_semantic_writer`（NOLOGIN 组角色，部署时绑定受信服务主体）。v0 无写入代码；表先建好、权限先收紧。
- **有效期**：写入者必须给 `valid_from`；`valid_to` 可选（建议默认 `valid_from + 180 天`，由写入者决定）。检索过滤 `valid_from <= now AND (valid_to IS NULL OR valid_to > now)`。
- **kill switch**：`MEMORY_SEMANTIC_CONSUMPTION_ENABLED`（默认 `false`）关闭时，检索服务忽略 semantic 行；另可用 `valid_to` 让某版本立即过期。紧急撤销不 UPDATE 旧行（保持 append-only），而是停用开关。

### 4.4 Prisma 模型

按仓库约定新增两个 model（`@map` snake_case；时间用 `Timestamp(3)`；`Json` 字段）。`DiscoveryRun` 增加 `memEpisodes MemRunEpisode[]`；`OutboxEvent` 增加 `@@index([eventType, occurredAt])`。

## 5. 接口与事件契约

### 5.1 事件映射

| 源事件 | 触发时点 | 写入 | 幂等键 |
| --- | --- | --- | --- |
| `DiscoveryRunCompleted` / v1 | run 收尾事务提交后（消费者轮询看到事件） | `phase='run_completed'`；payload 白名单 | `(workspace, 'discovery', run_id, 'run_completed')` |
| `LeadsScored` / v1 | 评分完成（`aggregate_id` = ICP） | 为该 ICP 在回看窗口内**已存在 phase 1、尚未 phase 2** 的 run 各写一行 `phase='results_backfilled'` | `(workspace, 'discovery', run_id, 'results_backfilled')` |

`LeadsScored` 与 run 的关联规则（确定性）：

```
runs = discovery_run
  WHERE workspace_id = $ws AND icp_id = $icp
    AND completed_at IS NOT NULL
    AND completed_at <= $event.occurred_at
    AND completed_at >= $event.occurred_at - $lookback
    AND EXISTS (mem_run_episode phase='run_completed' for run)
  ORDER BY completed_at DESC
```

- 若一次 `LeadsScored` 对应多个 run，写多行（每个 run 一行）；重复事件/重复轮询由唯一键吸收。
- 若某 run 的 phase 2 已写，后续 `LeadsScored` 不再写（同一 phase 唯一）。
- 回看窗口默认 14 天（`MEMORY_CONSUMER_LOOKBACK_DAYS`），覆盖重启/短暂停机；更早的历史不回填。

### 5.2 payload 白名单

`run_completed`（≤16KB）：

```json
{
  "planId": "<uuid>",
  "status": "DONE|PARTIAL|FAILED|CANCELLED",
  "cost": 1.23,
  "costBasis": "usage_ledger-runid/v1",
  "taskRef": {"taskId": "…", "taskRunId": "…"},
  "stats": {"<source>": {"…": "仅数字/布尔/短字符串计数"}}
}
```

- `stats` 只保留 `perSource`、`perQuery` 的计数结构和总量；解析器拒绝包含 `email`、`phone`、`fullName`、`contact`、`payload` 等键的对象（防未来 PII 混入）。
- 事件 payload 超过 16KB 时**拒绝整条事件**并告警（不截断，避免产生半真事实）。

`results_backfilled`：

```json
{ "scored": 378, "queues": { "recommended": 12, "needs_review": 90 } }
```

`provenance`（两表共用形状）：

```json
{
  "eventType": "DiscoveryRunCompleted",
  "schemaVersion": 1,
  "producer": "global-backend",
  "eventId": "<uuid>",
  "correlationId": null,
  "causationId": null
}
```

### 5.3 检索服务（内部，无公共 HTTP）

`apps/api/src/memory/memory-query.service.ts`，注入 `PrismaService`（`app_user` + RLS）：

```ts
getRunEpisodes(input: { workflowType: string; runId: string }): Promise<RunEpisodeView[]>
listKnowledgeStats(input: {
  scopes: Array<{ type: ScopeType; key: string }>; // 子→父顺序，SQL 用 IN 精确匹配
  statKey?: string;
  now?: Date;
}): Promise<KnowledgeStatView[]>
buildMemoryBrief(input: {
  workflowType: string;
  runId?: string;
  scopes?: Array<{ type: ScopeType; key: string }>;
  maxTokens?: number; // 默认 2000，硬上限 2000
}): Promise<MemoryBrief>
```

`MemoryBrief` 形状：

```ts
{
  text: string;              // <2k token（按 chars/4 估算，超限截断并加「…[truncated]」）
  citations: Array<{ table: 'mem_run_episode'|'mem_knowledge_stat'; id: string; sourceEventId?: string; validFrom?: string }>;
  tokenEstimate: number;
  truncated: boolean;
  semanticEnabled: boolean;  // kill switch 状态
}
```

置信度（在查询期计算，不落库）：

- 先验 `α0=β0=1`；后验 `α=successes+1`、`β=failures+1`；点估计 `α/(α+β)`；`posteriorLowerBound = ciLow`。
- 95% 区间用 Wilson score interval（仅依赖标准库）；`n = successes+failures`。Thompson 采样属策略消费，v0 不实现（M2.2）。
- 层级检索：调用方给出子→父的 scope 链（如 `icp:<id>` → `workspace:<id>`），SQL 用 `(scope_type,scope_key) IN (...)` 精确匹配，不做递归查询；每层取当前有效版本，brief 中按「越具体越靠前」排序。
- `mayInfluenceStrategy = n >= MEMORY_STRATEGY_MIN_N (默认 30)
   && (ciHigh - ciLow) <= MEMORY_STRATEGY_MAX_CI_WIDTH (默认 0.20)
   && MEMORY_SEMANTIC_CONSUMPTION_ENABLED === 'true'`
- 不满足时 `usage='hint_only'`，brief 中显式标注「仅提示，不得作为策略依据」。

### 5.4 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `MEMORY_LAYER_V0_ENABLED` | `false` | 消费者总开关；关闭时完全不写 episode |
| `MEMORY_CONSUMER_POLL_MS` | `60000` | 轮询间隔 |
| `MEMORY_CONSUMER_LOOKBACK_DAYS` | `14` | 事件回看窗口 |
| `MEMORY_CONSUMER_BATCH_SIZE` | `100` | 单轮处理上限 |
| `MEMORY_SEMANTIC_CONSUMPTION_ENABLED` | `false` | 语义记忆 kill switch（检索是否使用 semantic 行） |
| `MEMORY_STRATEGY_MIN_N` | `30` | 允许影响策略的最小样本量 |
| `MEMORY_STRATEGY_MAX_CI_WIDTH` | `0.20` | 允许影响策略的最大 95% CI 宽度 |
| `MEMORY_BRIEF_MAX_TOKENS` | `2000` | brief 上限（硬上限 2000） |

## 6. 幂等与重试

1. **写入幂等**：两表唯一键 + `INSERT … ON CONFLICT DO NOTHING`（或 Prisma `createMany({skipDuplicates:true})`）；每事件一个事务，失败整条回滚，下一轮重试。
2. **扫描幂等**：消费者用**独立 owner 连接**（与 relay 同模式）从 `outbox_event` 按 `event_type IN (...)` 且 `occurred_at >= now() - lookback` **只读**扫描（绝不更新 `publishedAt`/`parkedAt`，不影响 relay 分流），按 `id ASC` 处理；不维护游标表。重复扫描是 no-op，重启后窗口内自动补齐。
3. **并发**：v0 单副本部署，依赖唯一键幂等兜底；多副本时每个事件可再加 `pg_try_advisory_xact_lock(hashtextextended('mem-episode:'||event_id,0))`（写事务内），拿不到就跳过——advisory lock 不是 v0 的前置条件，避免长事务。
4. **事件解析失败**：记录 error 日志 + 事件 id，不写半行；该事件在窗口内会反复失败（可观测），不阻塞其他事件；提供运维手册（停用开关/修 payload/重放）。
5. **消费者关闭**：`MEMORY_LAYER_V0_ENABLED=false` 时不启动轮询；已有数据保留。
6. **观测**：每轮日志输出 `scanned/inserted/skipped/failed` 计数；不引入新指标系统。

## 7. 闭环设计（§0.6 必含）

- **SoR**：`discovery_run` / `lead` / `outbox_event` 仍是事实源；`mem_run_episode` 是**派生事件日志**，`mem_knowledge_stat` 是**派生统计**。两者都可从源重建（v0 不做重建工具，保留 provenance 以备后续）。
- **对外事件**：无新增。v0 不改变任何 SaaS 交付契约。
- **Tool Contract**：无。检索是纯 SQL 读，不走 ToolBroker；memory brief 由调用方（未来的 `campaign.plan` AI Task）作为上下文注入。
- **闭环位置**（计划 §17.6）：Understand/Qualify 之后、Campaign 规划之前；M2.1 规划器只读检索，M2.2 才允许「满足置信门」的 semantic 行影响策略。
- **端到端演示脚本**（dev）：
  1. 部署迁移 + `MEMORY_LAYER_V0_ENABLED=true`。
  2. 跑一个小 discovery run（真实 run 或已有 canary）。
  3. `SELECT phase, count(*) FROM mem_run_episode WHERE run_id='<run>' GROUP BY phase;` → 期望 `run_completed=1`；评分完成后 `results_backfilled=1`。
  4. 手工重放同一条 outbox 事件（测试环境）→ 计数不变。
  5. 调用 `buildMemoryBrief`（测试或脚本）→ 输出带出处、≤2k token。
- **负向测试**：跨租户读不到；`app_user` 不能写 semantic、不能 UPDATE/DELETE episode；重复事件不重复；非法 payload 不落库；kill switch 关闭时 semantic 不出现。

## 8. 权限与合规

### 8.1 数据库角色与授权

| 表 | `app_user` | `memory_semantic_writer` | owner |
| --- | --- | --- | --- |
| `mem_run_episode` | `SELECT, INSERT` | 无 | 全部（运维/DSR） |
| `mem_knowledge_stat` | `SELECT` | `SELECT, INSERT` | 全部 |

- `memory_semantic_writer`：`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`，迁移中按 `execution_budget_platform_writer` 的模式校验/创建；不与 `app_user` 互相 membership。
- RLS：两表 `ENABLE/FORCE ROW LEVEL SECURITY`，策略 `workspace_id = current_workspace_id()`（USING + WITH CHECK）。
- `docs/governance/app-user-table-privileges.json` 同 PR 登记两表权限；真库权限测试逐表比对。
- append-only 由授权保证（`app_user` 无 UPDATE/DELETE）；owner 保留保留期清理能力，不建触发器（避免阻断未来 DSR/保留期迁移）。

### 8.2 防投毒

- semantic 写入只有受信服务角色；v0 **没有任何生产写入代码**，表先空着。
- 每条统计必须有 `provenance`（源、窗口、写入者、样本 run 列表）与有效期；无 provenance 的写入被 NOT NULL 拒绝。
- 检索期置信门 + kill switch + brief 显式标注 `hint_only`/`eligible`。
- 不接受来自网页/模型输出的文本作为统计值；写入者必须聚合系统 of record（回复/会议/成交）——M2.2 实现时校验。

### 8.3 个人数据

- episode 只存 run 聚合计数、状态、成本与事件元数据，不存公司名、联系人、邮箱、电话或自由文本。payload 解析器拒绝已知 PII 键；16KB 上限。
- semantic 只存计数与 scope 键（uuid/规范键），不存个人数据。
- `privacy_classification` 从源事件复制（`DiscoveryRunCompleted` 默认 `CONFIDENTIAL`），供未来保留策略使用。

### 8.4 保留期与 DSR

- v0 建议：episode 保留 365 天；semantic 每版本 `valid_to` 默认 180 天（写入者决定）。清理作业不在 v0 实现，由 owner 运维 SQL 执行（文档化）。
- 因不含个人数据，v0 不接 DSR 删除；若未来 payload 引入任何 PII，必须先接 deletion workflow 的级联路径再启用该字段（写进 payload 白名单评审）。
- `discovery_run` 被删除时 episode 级联删除（复合外键）。

## 9. 预算与成本

- 零模型调用、零 embedding、零外部 API；不写 `usage_ledger`。
- 消费者：每 60s 最多扫 100 条事件；每条事件 1 个事务、1–N 行插入；回看窗口有索引。
- 检索：单次 brief 最多 3 条 episode + 10 条 semantic 行；输出 ≤2000 token（约 8000 字符）。
- 迁移：新增索引在 `outbox_event` 上，`lock_timeout 5s`，低峰执行。

## 10. 迁移与回滚

### 10.1 迁移

- 单个 additive 迁移 `20261108120000_memory_layer_v0`：建两表、约束、索引、RLS、授权、`memory_semantic_writer` 角色、`outbox_event(event_type, occurred_at)` 索引。
- 无回填、无数据迁移；不需要停写；不改现有表结构（除新增索引）。
- 部署顺序：迁移 → 部署代码（消费者默认关）→ 观察 → dev 开 `MEMORY_LAYER_V0_ENABLED=true` 做 canary。

### 10.2 回滚

1. 立即：`MEMORY_LAYER_V0_ENABLED=false`（停止写入）；两表保留，不影响任何现有路径。
2. 代码回滚：回退镜像即可；迁移可留在库中（新表未使用）。
3. 数据回滚：两表均为派生数据，可直接 `DROP TABLE`（需 owner）；不影响 discovery/lead/outbox。
4. `outbox_event` 新增索引可保留（纯读优化），无需回滚。

## 11. 联网研究（借 / 集 / 建 / 避）

| 来源 | 结论 | 本设计取舍 |
| --- | --- | --- |
| Mem0 v3 迁移文档（[OSS v2→v3](https://docs.mem0.ai/migration/oss-v2-to-v3)、[Platform v2→v3](https://docs.mem0.ai/migration/platform-v2-to-v3)） | v3 改为**单次抽取 + ADD-only**：不再在写入时做 ADD/UPDATE/DELETE 决策；变更保留两个版本，由检索排序呈现当前值 | **借**「只追加、检索期取当前」；**避**写时 LLM 合并与向量库依赖 |
| Zep / Graphiti 论文（[arXiv:2501.13956](https://arxiv.org/abs/2501.13956)） | 双时间（valid time + transaction time）+ 失效不删除；episode（原始输入）/语义事实/社区三层；检索混合排序后注入带有效期的上下文 | **借** `valid_from/valid_to` 与「失效不删」；**避**图数据库、实体消解、社区摘要（v0 不需要） |
| 计划 §0.7-F3 调研结论 | 奖励只取系统 of record；n≥30 且 CI 足够窄才允许影响策略；5–10% 探索流量留到 M2.2 | **建**最小两表 + SQL 检索 + 置信门；策略消费与探索流量明确延后 |

## 12. 测试与 TDD 步骤

### 12.1 RED → GREEN 顺序

1. **迁移与权限**：先写 `memory.postgres.spec.ts`（表存在、列/约束、`app_user` 权限与 `app-user-table-privileges.json` 一致、RLS 跨租户不可见、`app_user` 写 semantic 被拒、UPDATE/DELETE episode 被拒）→ RED（表不存在）→ 写迁移 → GREEN。
2. **契约解析**：`memory.contracts.spec.ts`（事件 payload 白名单、PII 键拒绝、16KB 上限、phase/scope 校验、Wilson 区间与置信门边界）。
3. **消费者**：`memory-episode.consumer.spec.ts`（DiscoveryRunCompleted → 1 行；重放 → 仍 1 行；LeadsScored 关联多个 run → 各 1 行；窗口外不写；phase 1 不存在不写 phase 2；解析失败不写半行；kill switch 关闭不启动）。
4. **检索**：`memory-query.service.spec.ts`（精确/层级 scope 查询、当前版本选择、过期过滤、kill switch、brief ≤2k token、出处完整、截断标注）。
5. **真库集成**：seed `outbox_event` + `discovery_run`（owner）→ 跑 consumer tick → 断言两 phase 各 1 行；重放事件 → 计数不变。
6. **回归**：`gctl check --fast` / 全量单测 / 真库套件；确认 `discovery.activities.ts`、`discovery.workflows.ts`、ai-trace、预算账本无 diff。

### 12.2 负向测试清单（验收必过）

- 跨租户：workspace A 的 `app_user` 读不到 workspace B 的 episode/stat。
- 写权：`app_user` `INSERT mem_knowledge_stat` → `42501`；`UPDATE/DELETE mem_run_episode` → `42501`。
- 幂等：同一 `DiscoveryRunCompleted` 重放 3 次 → 1 行；同一 `LeadsScored` 重放 → phase 2 不重复。
- 关联：`LeadsScored` 早于 run 完成/窗口外 → 不写 phase 2。
- 数据：payload 含 `email` 键 → 拒绝；payload >16KB → 拒绝；非法 phase/scope/空键 → 约束拒绝。
- 策略门：n=29 或 CI 宽度 >0.20 → `hint_only`；kill switch 关闭 → semantic 不出现。
- 预算：consumer tick 不产生 `usage_ledger`/`ai_trace` 行。
- 回滚：开关关闭 → 零新行。

### 12.3 验收对照（任务卡）

| 任务卡验收 | 证据 |
| --- | --- |
| 迁移落地 | 迁移应用日志 + `\d mem_run_episode` / `\d mem_knowledge_stat` |
| canary run 两时点各恰一次 | SQL 计数 + 重放测试 |
| 检索函数单测 + RLS 跨租户不可见 | 单测/真库测试名称与输出 |
| 语义表写权负向测试 | `app_user` INSERT 被拒的测试输出 |
| 零现有行为变化 | `git diff --name-only` 不含禁止文件；消费者默认关 |

## 13. 风险与开放问题

> 2026-11-08 产品负责人批准 D-1~D-8 按推荐值。

| # | 风险/决策 | 说明 | 建议（已批准） |
| --- | --- | --- | --- |
| D-1 | 「结果回填」的触发事件 | 现网没有专门的「结果回填」事件；本设计取 `LeadsScored`（评分完成）为 phase 2 触发 | 接受；若产品负责人希望用 `LeadQualified`（人工接受）作更强奖励信号，可加第三个 phase，留 M2.2 |
| D-2 | episode 唯一性 | 「workflow/run 唯一」与「两时点写入、append-only」冲突；本设计采用 `(workflow,run,phase)` 唯一、每个 run 两行 | 接受；不合并成一行（合并需要 UPDATE，违背 append-only） |
| D-3 | 消费者位置 | 放 API 进程（与 relay 同进程，owner 扫描 + app_user 写入），不碰 worker | 接受；多副本用 advisory lock + 幂等兜底 |
| D-4 | 语义写角色 | 现在创建 `memory_semantic_writer` NOLOGIN 角色但无登录主体；v0 无写入代码 | 接受；M2.2 接入服务主体时再绑定 |
| D-5 | 保留期 | episode 365 天、semantic 版本默认 180 天 | 接受；清理作业留 M2.2 |
| D-6 | 置信阈值 | `n>=30`、CI 宽度 `<=0.20` | 接受；env 可调，v0 默认 hint_only |
| D-7 | kill switch | 只用 env + `valid_to`，不做在线开关表 | 接受；紧急停用需重启配置 |
| D-8 | 不暴露 HTTP | v0 只提供内部服务；M2.1 规划器直接注入 brief | 接受；需要调试时用测试/脚本 |

其他风险：事件量增长导致扫描变慢（回看窗口 + 索引 + 批量上限）；payload 未来夹带 PII（白名单 + 16KB + 评审）；策略过度信任（默认 hint_only + kill switch）。

## 14. 给产品负责人的说明

- **你会得到什么**：引擎开始积累「每次 run 发生了什么、结果如何」的可检索记忆；M2.1 规划器可以先读记忆再提计划，而不是每次从零猜。所有记忆都可溯源到具体事件，且默认不改变任何现有行为。
- **明确没有改变什么**：不改 discovery 编排/评分/预算/ai-trace，不发送、不写 CRM、不调用模型；消费者默认关闭，开启后只新增两张派生表。
- **风险与回退**：主要风险是事件关联不准（LeadsScored 合并）与未来 payload 混入个人信息；设计用回看窗口、幂等键、payload 白名单与 16KB 上限兜底。回退只需关闭 env 开关，两表可随时丢弃。
- **建议**：批准 D-1~D-8 按推荐值，进入 TDD；v0 完成后先在 dev 用一条 canary run 验收，再谈 M2.2 的策略消费与探索流量。

## 15. 开放问题（已由产品负责人确认）

2026-11-08 已全部按推荐值批准（D-1~D-8 生效）：

1. D-1：phase 2 用 `LeadsScored`（评分完成）——接受；更强奖励信号留 M2.2。
2. D-2：每个 run 两行（两 phase），唯一键含 phase——接受。
3. D-5：episode 365 天、semantic 180 天——接受。
4. M2.2 的奖励信号（回复/会议/成交）等 `LeadOutcome` 数据可用后再定义。
