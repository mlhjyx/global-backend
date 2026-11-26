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

## 3. 分步切换流程（零中断目标）

1. **在 PostgreSQL Temporal 注册独立命名空间**
   - 在目标 PostgreSQL Temporal 集群创建 `customer-workflows` 命名空间（保留期按合规要求设置，建议 7-30 天），确保使用与 `platform-automation` 不同的命名空间及队列。
   - 核实客户端机密凭证与 CA 文件已挂入 API 和客户 Worker，权限 `0600`。
2. **启动前配置自检**
   - 设置上述 5 个 `TEMPORAL_CUSTOMER_*` 变量，排空旧任务后再重定向产出和消费。若批准在切换窗口并行，保留原集群及轮询原命名空间和队列的兼容 Worker，直到旧任务结束。
   - 启动诊断 `ConfigDriftDiagnosticsService` 会在启动日志检查双模配置；若有 `TEMPORAL_CUSTOMER_CONFIG_DRIFT` 告警则先修正再切流。
3. **验证 `/api/v1/health/ready` 与灰度跑通**
   - 重启客户 API 与客户 Worker 后，核实 `GET /api/v1/health/ready` 返回 `200` 且 `temporal` 探针正常。
   - 在用户明确授权的试点窗口发起有界任务，确认工作流执行记录落入 `customer-workflows` 命名空间且 PostgreSQL 持久化表有对应记录。
4. **排空并安全退役 SQLite `temporal-dev`**
   - 查询旧 `temporal-dev`（`default` 命名空间）是否仍有 `Running` 状态的工作流；等待全部完成或安全取消。
   - 确认旧队列已排空及备份可恢复，再由获授权的运行流程停用旧 `global-temporal-dev` 容器。本机旧 `temporal-dev.service` 已退役，核对实际容器与 launcher。
   - **禁止**在此过程中删除或改动 `temporal-platform` 容器及其数据库。

### 路由回退

回退前保存两侧的路由配置、命名空间与可恢复的历史。先阻止向故障目标继续派发，确认哪些新集群任务尚未结束。若已在新集群开出任务，保留其 Worker 和连接直至完成，或按批准的业务取消与补偿流程处理；切换路由不会移动已创建的 Temporal 历史。确认原配置、租约与队列可用后，在授权窗口回到原路由，分别验证新任务创建和两侧尚存任务的可观察性。

## 4. `execution_domain_ack` 治理瘦身的独立 PR 边界

Track 2B 保留 `execution_domain_ack` 的既有执行合同。曾经固定四个源文件字节指纹；2026-11-26 后 [结果策略](../governance/durable-result-strategies.json) 将物理执行接线登记为 `REVIEW_ONLY`。任何 ACK 语义变更、付费提交时机或不确定结果重试，都按独立规格、代码审查与适用的 PostgreSQL 事务回归验证执行，以当前治理规则和源码为准。
