---
date: 2026-11-26
pr:
title: "M10-PR2：非 SQL 防吵闹邻居隔离、统一 Postgres Temporal、Outbox 毫秒级唤醒与 ADR-003 platform_shared 物理边界"
---

- 起因：多租户并发下，Redis 限流桶、Temporal 队列与工作流载荷、`new-api` 模型调用、本地抓取/Docling/Embedding 服务缺乏租户份额边界与单日异常熔断，Outbox 仅靠 2 秒轮询唤醒，且 ADR-003 绿名单共享表尚未在 PostgreSQL 落地独立的只读物理 Schema 边界。
- 改动：
  1. Redis 两级限流与内存封顶：升级 `RedisRateLimitStore`，在 `global:tool-limit:${toolId}` 外增加单租户份额桶 `ws:${workspaceId}:tool-limit:${toolId}`（默认上限 ≤ 全局 40%、至少 1 槽，全局失败自动回滚租户租约），`ToolBroker` 透传 `workspaceId`，`docker-compose.yml` 为 Redis 增加 `--maxmemory 200mb --maxmemory-policy allkeys-lru`。
  2. Temporal 多租户隔离与统一 Postgres 编排：客户工作流 WorkflowId 统一为 `ws:${workspaceId}:${type}:${id}`（`cancelRun` / `recoverDemoV0` / `recoverRefurbish` / `workspace-purge` 兼容读取历史无前缀 ID）；引入 `TEMPORAL_DUAL_QUEUE_MODE=split`（`interactive-onboarding` / `batch-discovery` 双队列）与每租户在途活动并发上限拦截器；实现支持密钥环轮换的 AES-256-GCM `PayloadCodec`（`off`/`optional`/`enforce`）与工作流历史长文本截断/PII 脱敏；补充单一 Postgres Temporal 编排 [infra/temporal-unified/compose.yml](../../../infra/temporal-unified/compose.yml) 与迁移手册 [docs/runbooks/temporal-unified-postgres-migration.md](../../runbooks/temporal-unified-postgres-migration.md)。
  3. 模型网关分账、单日异常熔断与客户端并发信号量：`OpenAICompatibleProvider` 向 `new-api` 透传 `X-Workspace-Id` 并支持 `MODEL_GATEWAY_TENANT_KEYS_JSON` 按租户 sub-key 映射；基于 `usage_ledger` 实现 `TenantDailyCostBreaker` 单日底层 USD 异常熔断器并接入 `RouterModelGateway`；为 `crawl4ai`、`searxng`、`docling`、`embeddings` 客户端增加按租户公平信号量，并为 `DoclingClient` / `EmbeddingsClient` 新增 `managed_api` 可选切换开关（默认保持本地 `local` 行为不变）。
  4. Outbox `<1s` PG `NOTIFY` 唤醒与 `kb.service.ts` 显式租户绑定：新增前向迁移 `20261126140000_outbox_notify_wakeup` 在 `outbox_event` 写入事务提交时触发 `pg_notify('global_outbox_wakeup', workspace_id)`，在 `OutboxRelayService` 接入零依赖 `PgNotifyListener` 唤醒（保留 2s 轮询兜底）；`kb.service.ts` 向量检索显式补充 `c.workspace_id` 与 `d.workspace_id` 过滤。
  5. ADR-003 `platform_shared` 物理 Schema 边界：基于 `#1117` 的 `shared-facts/` 模块，新增前向迁移 `20261126141000_adr003_platform_shared_schema` 创建 `platform_shared.company_fact` 与 `platform_shared.domain_cooldown_touch`（`platform_writer` 读写、`app_user` 严格只读 `SELECT`，零自然人 PII 列 + 数据库级 CHECK 约束与触发器拦截个人邮箱/LinkedIn `/in/`/明文冷却键），并实现 `PostgresSharedFactRepository` 与 `PostgresDomainCooldownBackend`。
- 测试：
  - `@global/api` 构建与 G9 体量/复杂度预算门禁全绿；
  - 覆盖 5 块隔离能力的单元与回归测试全绿；
  - 使用独立临时 Redis 容器（`--maxmemory 200mb`）实测两级租户 40% 限流与全局回滚全绿；
  - 使用独立临时 PG16 容器实测 `platform_writer` 读写、`app_user`（`NOSUPERUSER NOBYPASSRLS`）严格只读拒绝写入（`42501`）、数据库级 PII 拦截与 `outbox_event` 事务级 `<1s` `NOTIFY` 唤醒全绿；
  - `pnpm governance:verify`、`pnpm docs:verify`、changelog 片段检查与 `gitleaks` 全绿。
- 未做：本 PR 尚未部署至现网生产容器；双队列分流（`TEMPORAL_DUAL_QUEUE_MODE=split`）、`PayloadCodec` 强制模式（`TEMPORAL_PAYLOAD_CODEC_MODE=enforce`）以及 `DOCLING_BACKEND`/`EMBEDDINGS_BACKEND=managed_api` 均默认保持兼容旧态，待按迁移手册分阶段灰度开启。
