---
date: 2026-11-26
pr: 1110
title: "feat(runtime): 治理瘦身、自托管爬虫零虚扣、四方配置漂移诊断与基建加固"
---

- 起因：获客链路存在 `data_provider` 表 / 容器 env / 安全白名单四方配置漂移、`contact-enrichment-safety` 多处重复策略判定、`ai_trace` 与 `usage_ledger` 记账口径不一致且自托管 `crawl4ai` 虚记 1¢/次、`runtime_process_lease` 僵尸租约堆积、`gate_enrichment_task` 零消费者死队列持续写入，以及模型网关硬编码 IP / SearXNG 403·429 缺自动兜底 / 客户 Temporal 缺 PostgreSQL 双模配置等架构与稳定性隐患。
- 改动：
  1. 新增 `ConfigDriftDiagnosticsService`（`apps/api/src/runtime/config-drift-diagnostics.ts`），启动时非阻塞比对 14 个 provider 的 `data_provider` 表状态、环境变量存在性（绝不记录密钥值或长度）、安全受控白名单及 `ICP_INPUT_GUARDRAILS` / 网关 / Temporal 配置，输出结构化告警并暴露诊断摘要；
  2. 新增 `apps/api/src/enrichment/safety/enrichment-safety-policy.ts` 单一真值策略模块，收敛 `enrichment-call-plan.ts`、`enrichment-result-reader.ts`、`enrichment-domain-commit.ts` 与 `contact-enrichment-safety.composition.ts` 中重复的供应商集合、快照读取、步骤事实一致性与执行头状态聚合逻辑；
  3. 停止对免费自托管 `crawl4ai.fetch` / `crawl4ai.render`（workspace 路径）/ `social.fetch` 虚记 1¢/次，同步修正 `workspace-technical-budget-envelope.ts` 报价口径；统一 `ai-trace.sink.ts` 中 `ai_trace.cost_usd` 与 `usage_ledger.cost_usd` 结算口径，并在 `measurement/billing-reconciliation.ts` 增加三账对账与自托管工具虚扣分离字段；
  4. 新增 `RuntimeLeaseMaintenanceService`（`apps/api/src/runtime/runtime-lease-maintenance.ts`）按批回收过期僵尸租约并清理超期 `STOPPED` 行（低权限角色安全降级）；在 `discovery/judgment/gates.ts` 增加 `GATE_ENRICHMENT_TASK_WRITE_ENABLED` 开关（默认关闭）停止向无消费者的 `gate_enrichment_task` 写垃圾行并保持读侧兼容；
  5. 新增 `adapters/model-gateway-endpoint.ts`（环境变量与 Compose 服务名解析、拦截非回环硬编码 IP）、`adapters/searxng-fallback.ts`（SearXNG 403/429 冷却并自动切换 Serper/Exa，接入 `searxng.search` 工具）、`temporal/temporal-config.ts`（客户工作流 SQLite / PostgreSQL Temporal 双模配置与命名空间隔离校验，接入 `TemporalClient`）及运维迁移文档 `docs/backend/postgres-temporal-customer-migration.md`。
- 测试：完成全部新增与变更模块单元测试、`pnpm --filter @global/api build`、G9 文件与复杂度预算检查、Copy 绑定源码指纹校验、文档漂移校验、`pnpm docs:verify` 与 `gitleaks` 扫描。
- 未做：未修改 `docs/governance/durable-result-strategies.json` 锁定的 4 个核心文件、`platform-execution-contract.ts` 与 Copy 绑定源码文件；`execution_domain_ack` 瘦身留待独立 CODEOWNERS PR 推进；尚未在现网容器环境执行真实 PostgreSQL Temporal 切换与在线压测。
