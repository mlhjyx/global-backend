# 平台权威轻量化（`PLATFORM_AUTHORITY_MODE=internal_db`）与网关/容器瘦身操作手册

> 最后核验：2026-11-26

## 1. 概述

本手册记录 Wave 3 M10-PR3 引入的三项向后兼容减负开关，默认配置全部保持现网行为零破坏，可按环境分阶段切换：

1. **`PLATFORM_AUTHORITY_MODE=r4|internal_db`**（默认 `r4`）：在 `internal_db` 模式下，4 个平台调度（`acq-sweep`、`intent-sweep`、`sanctions-refresh`、`patents-cache-refresh`）改由数据库表 `public.platform_schedule_config` 控制 Kill Switch，免除 7 天 `deployment-binding.json` 续期、5 套 RSA 密钥与 R4 JWKS 强依赖。
2. **`NEW_API_SETTLEMENT_READBACK_ENABLED=false`**（默认未设置，沿用 `MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL` 是否存在判定）：未启用或显式关闭读回探针时，系统不再预加载 `new-api-request-bound-settlement.ts`，也不执行额外读回探针网络请求。
3. **`openox-video-compat` 可选 Compose Profile**：在根 `docker-compose.yml` 中移入 `profiles: ["video-compat"]`，默认 `docker compose up -d` 不再常驻启动视频兼容代理容器。

## 2. 切换 `PLATFORM_AUTHORITY_MODE=internal_db`

### 2.1 数据库前提与权限边界

迁移 `packages/db/prisma/migrations/20261126150000_platform_schedule_config/migration.sql` 创建 `public.platform_schedule_config(schedule_id, enabled, updated_by, updated_at)` 并预置全部 4 条调度为 `enabled = false`（fail-closed，切换模式不会误触发外网抓取）：

- `app_user`：仅拥有 `SELECT` 权限，应用租户层绝不能修改平台开关。
- `execution_budget_platform_writer` / `platform_writer`：拥有 `SELECT, INSERT, UPDATE` 权限（无 `DELETE` / `TRUNCATE`）。

### 2.2 环境变量配置

在 API 与 `platform-worker` 进程中设置：

```bash
PLATFORM_AUTHORITY_MODE=internal_db
PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN=<32字节以上随机内部服务令牌>
```

在 `internal_db` 模式下：

- API 与 `platform-worker` 不再启动 R4 `CapabilityRuntime` 轮询，不要求 `PLATFORM_CAPABILITY_*`、`MACHINE_BOOTSTRAP_*` 或 7 天 `deployment-binding.json`。
- `platform-worker` 若未配置 `MACHINE_BOOTSTRAP_ENDPOINT`，直接通过统一 Postgres Temporal 配置（`TEMPORAL_CUSTOMER_ADDRESS` / `TEMPORAL_ADDRESS`）连接。
- 每次平台调度准入（`admitPlatformSchedule`）、活动鉴权（`attestAuthorized`）以及出网围栏（`authorize` / `claimSend`）都会实时查询 `platform_schedule_config.enabled`；关闭开关后，在途任务的下一次物理出网也会立即中断（错误码 `PLATFORM_EGRESS_SCHEDULE_DISABLED_BY_KILL_SWITCH`）。

### 2.3 受服务令牌保护的只读与启停接口

内部控制面（如 `gain-saas` 运营台）通过 `x-service-token` 访问：

- 只读查询：`GET /internal/platform-schedules`
- 启停切换（写入 DB 并输出结构化 `[platform-schedule-config-audit]` 审计日志）：

```bash
curl -sS -X PATCH "http://127.0.0.1:3000/internal/platform-schedules/sanctions-refresh" \
  -H "Content-Type: application/json" \
  -H "x-service-token: ${PLATFORM_SCHEDULE_CONFIG_INTERNAL_SERVICE_TOKEN}" \
  -d '{"enabled":false,"updatedBy":"ops-admin","reason":"maintenance pause"}'
```

### 2.4 回退到 R4 模式

将 `PLATFORM_AUTHORITY_MODE` 切回 `r4`（或删除该环境变量）并重启 API 与 `platform-worker`，即可恢复原有 R4 能力校验与 RS256 平台 Grant 链路。

## 3. 关闭 `new-api` 读回探针

在仅使用常规 LLM 路由与 `usage_ledger` 对账的部署环境中：

- 不设置 `MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL`，或显式设置 `NEW_API_SETTLEMENT_READBACK_ENABLED=false`；
- 启动期与运行期均不会加载 `new-api-request-bound-settlement.ts`，对普通 `ModelGateway` 路由零额外网络开销；
- 若需临时恢复 Site Builder 付费读回，取消 `NEW_API_SETTLEMENT_READBACK_ENABLED=false` 并提供完整读回凭据与 keyring 文件即可。

## 4. `openox-video-compat` 按需启停

默认基础栈不再拉起 `openox-video-compat`：

```bash
# 常规启动（不含 openox-video-compat）
docker compose up -d

# 仅在需要视频生成兼容代理时显式启用
docker compose --profile video-compat up -d openox-video-compat
```
