# 单一 Postgres Temporal 统一编排与多租户隔离迁移手册

最后核验：2026-11-26

## 1. 适用范围与目标

本手册用于将历史 SQLite 开发态 Temporal 或分离部署的双 Temporal 实例，平滑收敛至单一 PostgreSQL 16 支撑的 Temporal 服务（[infra/temporal-unified/compose.yml](../../infra/temporal-unified/compose.yml)），并分阶段启用以下三项 M10-PR2 多租户隔离能力：

1. **客户 WorkflowId 租户前缀**：全部新启动的客户工作流统一使用 `ws:<workspaceId>:<type>:<id>`，取消与恢复路径（`cancelRun`、`recoverDemoV0`、`recoverRefurbish`、`workspace-purge`）自动兼容读取历史无前缀 ID。
2. **双任务队列隔离与每租户并发上限**：通过 `TEMPORAL_DUAL_QUEUE_MODE=split` 将交互型建档/规划/建站路由至 `interactive-onboarding`，批量发现/清扫/导出路由至 `batch-discovery`；所有 worker 均通过 `WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES`（默认 `4`）限制单租户在途活动并发。
3. **PayloadCodec（AES-256-GCM）加密与历史正文瘦身**：通过 `TEMPORAL_PAYLOAD_CODEC_KEYS_JSON` + `TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID` 加密工作流与活动载荷，同时通过 `TEMPORAL_HISTORY_TEXT_MAX_CHARS`（默认 `32000`）截断抓取长文本并脱敏诊断日志中的个人邮箱/LinkedIn 链接。

## 2. 统一 Postgres Temporal 准备

1. 在既有 PostgreSQL 16 实例中为 Temporal 创建受限角色与两个独立库（禁止复用业务库 `public` schema）：
   - `CREATE ROLE temporal LOGIN PASSWORD '<strong-password>';`
   - `CREATE DATABASE temporal OWNER temporal;`
   - `CREATE DATABASE temporal_visibility OWNER temporal;`
2. 使用 [infra/temporal-unified/compose.yml](../../infra/temporal-unified/compose.yml) 拉起统一 Temporal，并通过 `temporal operator cluster health` 确认健康。
3. 如需按命名空间隔离客户与平台任务，在统一集群中创建 `customer` 与 `platform-automation` 两个 namespace，分别配置 `TEMPORAL_CUSTOMER_BACKEND_MODE=postgres_platform`、`TEMPORAL_CUSTOMER_ADDRESS`、`TEMPORAL_CUSTOMER_NAMESPACE`。

## 3. 分阶段灰度切换（零停机）

### 阶段 A：开启双队列 worker 监听（先兼容读，再切写）

1. 先重启 `worker` 设置 `TEMPORAL_DUAL_QUEUE_MODE=split`（或按需拆分独立 Pod，用 `TEMPORAL_WORKER_TASK_QUEUES=interactive-onboarding` 与 `batch-discovery` 分池部署）。
2. 此时 worker 同时监听 `understanding`、`interactive-onboarding`、`batch-discovery`，存量在飞任务继续在 `understanding` 跑完。
3. 再给 `api` / `outbox-relay` 设置 `TEMPORAL_DUAL_QUEUE_MODE=split`，新任务即刻分流。

### 阶段 B：开启 PayloadCodec（`optional` → `enforce`）

1. 生成 32 字节（64 hex 或 base64）对称密钥，配置到所有 `api`、`outbox-relay`、`worker` 进程：
   - `TEMPORAL_PAYLOAD_CODEC_KEYS_JSON={"k2026-11":"<32-byte-key>"}`
   - `TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID=k2026-11`
   - `TEMPORAL_PAYLOAD_CODEC_MODE=optional`
2. `optional` 模式下，新写入的载荷全部使用 AES-256-GCM 加密，存量未加密历史仍可正常解码完成。
3. 待全部存量在飞工作流结束后，将 `TEMPORAL_PAYLOAD_CODEC_MODE` 切换为 `enforce`，进入 fail-closed 强加密模式。
4. 密钥轮换：在 `TEMPORAL_PAYLOAD_CODEC_KEYS_JSON` 中追加新键并将 `TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID` 指向新键；保留旧键直至所有使用旧键的历史超过 retention 窗口后移除。

### 阶段 C：下线旧 SQLite / 第二套 Temporal

1. 确认旧 Temporal 中无 `Running` 状态工作流。
2. 切换 `TEMPORAL_CUSTOMER_BACKEND_MODE=postgres_platform` 并重启 `api`、`outbox-relay`、`worker`。
3. 观察新任务执行与 `/health/ready` 探针正常后，停止旧 Temporal 容器。

## 4. 回滚步骤

- **双队列回滚**：先将 `api` / `outbox-relay` 的 `TEMPORAL_DUAL_QUEUE_MODE` 改回 `legacy`（新任务回 `understanding`），待 `interactive-onboarding` 与 `batch-discovery` 排空后再改回 worker。
- **PayloadCodec 回滚**：切回 `TEMPORAL_PAYLOAD_CODEC_MODE=optional` 即可重新兼容明文读取；只要密钥仍在 `TEMPORAL_PAYLOAD_CODEC_KEYS_JSON` 中，已加密历史均可继续解码，禁止在存量工作流未结束前删除旧密钥。
