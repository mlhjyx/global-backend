# Lead quality label operator（reference consumer）

该 CLI 是 `LeadQualified` 拉取、schema 校验、人工 QGO/拒绝标签回传和安全 ACK 的**参考消费者**。它不是常驻 worker，不代表正式 SaaS/QGO 集成，不会创建 Opportunity/QGO 状态，也不会修改 Lead 状态。

## 安全边界

- bearer token 只从 `GLOBAL_API_BEARER_TOKEN` 环境变量读取；命令行、状态文件和输出都不保存或打印 token。
- `GLOBAL_API_BASE_URL` 必须是无 userinfo/query/fragment/path 的 HTTPS origin；开发环境仅允许 `http://localhost`、`127.0.0.1` 或 `[::1]`。
- 网络请求有 10 秒超时和 1 MiB 响应上限；错误只报告动作与 HTTP 状态，不打印远端响应原文。
- `qgo`/`reject` 默认 dry-run：零网络、零状态写。只有显式 `--execute` 才会执行 POST/ACK。
- 本地状态机只有 `PENDING → LABEL_POSTED → ACKED`。标签 POST 成功（包括服务端幂等 replay）后先 durable 写 `LABEL_POSTED`，随后才 ACK；POST 失败、schema 拒绝或 `defer` 都不 ACK。
- 无“裸 ACK”命令。ACK 失败时只能对 durable `LABEL_POSTED` 执行 `retry-ack`；已 `ACKED` 的 event 再出现只显示去重状态，不重复 POST。
- 状态文件只存 event id、label receipt id、label 与时间；不存事件 payload、公司/联系人字段。专属目录必须由当前用户拥有且为 `0700`，文件为 `0600`；写入用跨进程 lock + 临时文件原子 rename。默认路径为 `~/.local/state/global-backend/lead-quality-label-operator.json`，可用 `GLOBAL_LEAD_QUALITY_LABEL_STATE_PATH` 指向另一个**专属 0700 目录**中的文件。

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

每个事件必须同时通过 `events/envelope.schema.json` 与 `payloads/lead-qualified.v1.schema.json`，并要求 payload 的 `lead_id` / `workspace_id` 与 envelope 的 aggregate / workspace 精确相绑；分页元数据畸形也会 fail-closed。输出只含哈希化 event id、schema 状态和本地处理状态，不显示 payload/公司/联系人值。`pull` 不改本地状态。

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

先 dry-run，再显式执行：

```bash
pnpm --filter @global/api lead-quality-labels:operator -- qgo --input /secure/path/qgo.json
pnpm --filter @global/api lead-quality-labels:operator -- qgo --input /secure/path/qgo.json --execute
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
pnpm --filter @global/api lead-quality-labels:operator -- reject --input /secure/path/reject.json
pnpm --filter @global/api lead-quality-labels:operator -- reject --input /secure/path/reject.json --execute
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
