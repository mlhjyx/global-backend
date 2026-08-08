# Lead quality label operator（reference consumer）

该 CLI 是 `LeadQualified` 拉取、schema 校验、人工 QGO/拒绝标签回传和安全 ACK 的**参考消费者**。它不是常驻 worker，不代表正式 SaaS/QGO 集成，不会创建 Opportunity/QGO 状态，也不会修改 Lead 状态。

## 安全边界

- bearer token 只从 `GLOBAL_API_BEARER_TOKEN` 环境变量读取；命令行、状态文件和输出都不保存或打印 token。
- `GLOBAL_API_BASE_URL` 必须是无 userinfo/query/fragment/path 的 HTTPS origin；开发环境仅允许 `http://localhost`、`127.0.0.1` 或 `[::1]`。
- 网络请求有 10 秒超时和 1 MiB 响应上限；错误只报告动作与 HTTP 状态，不打印远端响应原文。
- 所有 HTTP 请求固定 `redirect=error`。`qgo`/`reject` 必须同时提供原始完整 `LeadQualified` envelope 文件；CLI 在任何写请求前复核 envelope schema、payload schema、event/lead/workspace binding，并把规范化 envelope+label 请求的 SHA-256 写入最小状态。
- `qgo`/`reject` 默认 dry-run：零网络、零状态写。只有显式 `--execute` 才会执行 POST/ACK。
- 本地状态机只有 `PENDING → LABEL_POSTED → ACKED`。标签 POST 成功（包括服务端幂等 replay）后先 durable 写 `LABEL_POSTED`，随后才 ACK；POST 失败、schema 拒绝或 `defer` 都不 ACK。
- 无“裸 ACK”命令。ACK 失败时只能对 durable `LABEL_POSTED` 执行 `retry-ack`；只有逐事件结果 `ACKED_NOW` 或 `ALREADY_ACKED` 才进入 `ACKED`，`NOT_DELIVERED`/`NOT_FOUND` 保持 `LABEL_POSTED` 并要求人工对账。ACK 只写消费证据 `ackedAt`，不会把 relay 尚未记录的 `deliveredAt` 伪造成当前时间。
- 状态文件只存 event id、label receipt id、label、请求 SHA-256、ACK outcome 与时间；不存事件 payload、公司/联系人字段。专属目录必须由当前用户拥有且为 `0700`，文件为 `0600`；每个 event 的跨进程 operation lock 覆盖完整 state-read → label POST → durable receipt → ACK 链，状态写另走原子 lock + 临时文件 rename。锁记录绑定 PID+Linux process start time，只回收已证明进程不存在/PID 已复用且 inode 未漂移的 stale lock；畸形或不可判定锁 fail-closed。默认路径为 `~/.local/state/global-backend/lead-quality-label-operator.json`，可用 `GLOBAL_LEAD_QUALITY_LABEL_STATE_PATH` 指向另一个**专属 0700 目录**中的文件。

当前分支只冻结授权集成合同，不能把普通 `AuthGuard` 误称为 scope enforcement。三条 operator endpoint 目前由 `AUTHORIZATION_INTEGRATION_PENDING` 硬门统一返回 503，故本分支上的 reference CLI **不可联机使用**。最终授权集成必须精确绑定：拉取=`acquisition:read + personal-data:read`，写标签=`acquisition:label:write`，ACK=`acquisition:event:ack`；只有 OpenAPI `x-required-scopes`、统一 401/403 测试和真实 runtime guard 全部通过，才能移除 503 硬门。

## 准备

```bash
export GLOBAL_API_BASE_URL=https://api.example.com
read -r -s GLOBAL_API_BEARER_TOKEN
export GLOBAL_API_BEARER_TOKEN
```

CLI 从环境读取 token；不要把 token 写进参数、JSON 输入、shell history 或工单。

## 拉取并校验 LeadQualified

```bash
pnpm --filter @global/api lead-quality-labels:operator -- pull --limit 50
pnpm --filter @global/api lead-quality-labels:operator -- pull --cursor 123 --limit 50
```

每个事件必须同时通过 `events/envelope.schema.json` 与 `payloads/lead-qualified.v1.schema.json`，并要求 payload 的 `lead_id` / `workspace_id` 与 envelope 的 aggregate / workspace 精确相绑；分页元数据畸形也会 fail-closed。每个非空页（包括 `has_more=false` 的终页）都必须返回最后一条账本位置作为 `next_cursor`，只有空页返回 `null`，因此消费者可持久化终页 checkpoint 后继续轮询。输出只含哈希化 event id、schema 状态和本地处理状态，不显示 payload/公司/联系人值。`pull` 不改本地状态。

## 人工 QGO 标签

输入文件只含 API 请求字段，例如：

```json
{
  "source_event_id": "operator:qgo:1001",
  "lead_id": "11111111-1111-4111-8111-111111111111",
  "lead_qualified_event_id": "22222222-2222-4222-8222-222222222222",
  "label": "QGO_CREATED",
  "occurred_at": "2026-08-07T12:00:00.000Z",
  "source_system": "quality-label-operator"
}
```

另把从 `pull` 获得、未经改写的完整 envelope 保存为当前用户私有文件（不得只保存 `event_id`）。两个输入文件都必须是当前用户拥有、group/other 不可访问的普通非 symlink 文件。先 dry-run，再显式执行：

```bash
pnpm --filter @global/api lead-quality-labels:operator -- qgo --input /secure/path/qgo.json --event-envelope /secure/path/lead-qualified.json
pnpm --filter @global/api lead-quality-labels:operator -- qgo --input /secure/path/qgo.json --event-envelope /secure/path/lead-qualified.json --execute
```

## 人工拒绝标签

`reject` 输入必须是 `LEAD_OUTCOME_REJECTED` 并携带封闭 `reason_code`：

```json
{
  "source_event_id": "operator:reject:1001",
  "lead_id": "11111111-1111-4111-8111-111111111111",
  "lead_qualified_event_id": "22222222-2222-4222-8222-222222222222",
  "label": "LEAD_OUTCOME_REJECTED",
  "reason_code": "NOT_ICP",
  "occurred_at": "2026-08-07T12:00:00.000Z",
  "source_system": "quality-label-operator"
}
```

```bash
pnpm --filter @global/api lead-quality-labels:operator -- reject --input /secure/path/reject.json --event-envelope /secure/path/lead-qualified.json
pnpm --filter @global/api lead-quality-labels:operator -- reject --input /secure/path/reject.json --event-envelope /secure/path/lead-qualified.json --execute
```

## defer 与 ACK 恢复

`defer` 保持事件为 `PENDING`，不 POST、不 ACK、不写状态：

```bash
pnpm --filter @global/api lead-quality-labels:operator -- defer --event-id 22222222-2222-4222-8222-222222222222
```

若标签已成功、ACK 失败，状态会停在 `LABEL_POSTED`。确认后先 dry-run，再重试 ACK：

```bash
pnpm --filter @global/api lead-quality-labels:operator -- retry-ack --event-id 22222222-2222-4222-8222-222222222222
pnpm --filter @global/api lead-quality-labels:operator -- retry-ack --event-id 22222222-2222-4222-8222-222222222222 --execute
```

`retry-ack` 对 `PENDING`/未知事件 fail-closed；不能用它跳过标签处理。

## HELD 修正与对账

`HELD` 是不可变证据，不会在后续 prerequisite 到达后自动翻成 `ACCEPTED`。以下情况明确 HELD：事实早于其精确 handoff、超过服务端观察时间 5 分钟 future-skew、同 handoff 已有更晚的 ACCEPTED 事实、缺 prerequisite、或与已有 ACCEPTED 事实矛盾；同一 handoff 的两个拒绝标签若 `reason_code` 不同，也属于 `CONTRADICTORY_REJECTION`。不同 `lead_qualified_event_id` 的事实绝不互相充当前置条件。

修正协议是追加新事实：保留原 HELD 行；使用新的 `source_event_id`，绑定同一 `lead_qualified_event_id`，给出真实且不早于 handoff 的 `occurred_at`，并确保所需 ACCEPTED prerequisite 的 `occurred_at <=` 新事实时间。相同 source event 只能做字节语义一致的 replay，不能覆盖修正。若业务事实本身矛盾，先人工对账，不要伪造时间或新 handoff；learning/tuning 只读取 ACCEPTED，且 50-QGO 门按 50 个不同 handoff 计数，同一 handoff 的重复来源不会刷高门槛或样本权重。

## 可选的真 PostgreSQL 验证器（本交付未运行）

`pnpm --filter @global/api verify:lead-quality-labels:postgres` 默认只输出 `NOT_RUN`，不会读取或连接 `DATABASE_URL`。唯一执行入口 `--execute-disposable` 还要求精确 acknowledgement 与 `pgvector/pgvector:<tag>@sha256:<digest>`；它自行创建随机命名、tmpfs、Docker 动态 loopback 端口的临时容器，迁移后把 trigger function 转交给 `NOSUPERUSER NOBYPASSRLS` 的临时 owner，再以 owner/app_user 验证 FORCE RLS 下的 direct INSERT handoff identity、append-only FK/trigger 与并发唯一性，最后只删除自己创建的容器。本文和本 PR 均不构成运行授权。
