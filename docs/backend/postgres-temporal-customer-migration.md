# 客户工作流迁往 PostgreSQL Temporal 运维迁移指南

> 生命周期：`GUIDE`
> 生命周期依据：2026-11-26 Phase 2 Track 2B 新增的客户工作流 PostgreSQL Temporal 迁移与 `execution_domain_ack` 受控瘦身边界指南
> 最后核验：2026-11-26

本文档说明如何将客户侧 Temporal 工作流（发现、背调、联系人补全等）从单节点 SQLite `temporal-dev` 平滑切换至 PostgreSQL 持久化 Temporal，并明确 `execution_domain_ack` 瘦身的后续受控变更边界。

## 1. 现状与迁移目标

- **现状**：平台定时调度（`platform-automation` 命名空间）已运行在 PostgreSQL 支撑的 `temporal-platform` 上，而客户工作流默认仍指向单节点 SQLite `temporal-dev`（`namespace=default`）。单机 SQLite 在高并发任务和异常断电下存在锁竞争与历史恢复风险。
- **目标**：通过双模配置让客户工作流以独立命名空间（如 `customer-workflows`）切入 PostgreSQL Temporal，全程**不动** `temporal-platform` 容器、**不碰** `platform-automation` 命名空间、**不破坏** `/api/v1/health/ready` 契约，待旧任务排空后再下线 `temporal-dev`。

## 2. 双模环境变量说明

配置解析与 fail-closed 就绪校验位于 `apps/api/src/temporal/temporal-config.ts`，由 `TemporalClient` 消费：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TEMPORAL_CUSTOMER_BACKEND_MODE` | `dev_sqlite` | 可选 `dev_sqlite`（向后兼容旧模式）或 `postgres_platform`（PostgreSQL Temporal 模式） |
| `TEMPORAL_CUSTOMER_ADDRESS` | 回退 `TEMPORAL_ADDRESS` | 客户侧 Temporal gRPC 地址（`postgres_platform` 模式必填） |
| `TEMPORAL_CUSTOMER_NAMESPACE` | 回退 `TEMPORAL_NAMESPACE` / `default` | 客户侧独立命名空间；**硬禁止**与 `platform-automation` 同名（触发 `TEMPORAL_CUSTOMER_NAMESPACE_COLLISION`） |
| `TEMPORAL_CUSTOMER_TLS_SERVER_NAME` | 回退 `TEMPORAL_TLS_SERVER_NAME` | TLS 服务端 SNI 校验名（`postgres_platform` 模式必填） |
| `TEMPORAL_CUSTOMER_TLS_CA_FILE` | 回退 `TEMPORAL_TLS_CA_FILE` | CA 证书绝对路径（`postgres_platform` 模式必填且权限须为 `0600`） |

## 3. 分步切换流程（零中断）

1. **在 PostgreSQL Temporal 注册独立命名空间**
   - 在目标 PostgreSQL Temporal 集群创建 `customer-workflows` 命名空间（保留期按合规要求设置，建议 7-30 天），确保与 `platform-automation` 物理隔离。
   - 核实客户端机密凭证与 CA 文件已挂入 API 和客户 Worker，权限 `0600`。
2. **启动前配置自检**
   - 设置上述 5 个 `TEMPORAL_CUSTOMER_*` 变量，保留原 `temporal-dev` 运行以便排空旧任务。
   - 启动诊断 `ConfigDriftDiagnosticsService` 会在启动日志检查双模配置；若有 `TEMPORAL_CUSTOMER_CONFIG_DRIFT` 告警则先修正再切流。
3. **验证 `/api/v1/health/ready` 与灰度跑通**
   - 重启客户 API 与客户 Worker 后，核实 `GET /api/v1/health/ready` 返回 `200` 且 `temporal` 探针正常。
   - 发起 1 次真实客户发现任务，确认工作流执行记录落入 `customer-workflows` 命名空间且 PostgreSQL 持久化表有对应记录。
4. **排空并安全退役 SQLite `temporal-dev`**
   - 查询旧 `temporal-dev`（`default` 命名空间）是否仍有 `Running` 状态的工作流；等待全部完成或安全取消。
   - 备份旧 SQLite 文件后，再停用 `temporal-dev.service`。
   - **禁止**在此过程中删除或改动 `temporal-platform` 容器及其数据库。

## 4. `execution_domain_ack` 治理瘦身的独立 PR 边界

本阶段（Track 2B）刻意**不修改** `execution_domain_ack` 写路径与以下 4 个 SHA-256 锁定文件（见 `docs/governance/durable-result-strategies.json`）：

- `apps/api/src/tools/tool-broker.ts`
- `apps/api/src/model-gateway/router-model-gateway.ts`
- `apps/api/src/tools/tool-broker.factory.ts`
- `apps/api/src/model-gateway/model-gateway.module.ts`

原因：这 4 个文件受治理哈希锁与 CODEOWNERS 保护，强行在同一 PR 内改动会触发治理门禁失败并与普通业务/基建改动混审。后续推进 `execution_domain_ack` 瘦身时，应按以下步骤单开受控 PR：

1. 明确需要保留的强一致 ACK 域（联系人外调扣费提交、网站构建付费结算）与可下沉为普通幂等键的只读抓取/搜索操作；
2. 在独立 PR 中同步更新 `docs/governance/durable-result-strategies.json` 锁定哈希与对应合约测试；
3. 走 CODEOWNERS 审阅与 PostgreSQL 实库事务回归验证后单独合入。
