---
date: 2026-11-17
pr:
title: Persist bounded provider query outcomes with the strict receipt
---

- 起因：提供方显式返回的 outcome（参数无效 vs 源显式空结果）原先只存在于执行期返回值，run 详情读不回来，两类情况在持久事实里无法区分。
- 改动：
  - 新增 `run.stats.queryDiagnostics` v1 命名空间（严格白名单投影、限界与确定性幂等合并），在 legacy 与 governed 查询提交的同一事务、同一 run 行锁内与既有 `discovery-query-receipt/v1` 一起只写一次 stats update。
  - 将 `finalizeRun` 的最终 stats 计算等价提取到 `discovery-run-final-stats`，原漂移/缺失错误与 FAILED 回执补齐语义不变；锁内已提交诊断在 DONE/PARTIAL/FAILED/CANCELLED、授权结束降级与 watchdog 收尾中原样保留，workflow 同名注入无效。
  - 两处 `DiscoveryRunCompleted.payload.stats` 统一用投影剔除该命名空间；receipt 字段、工作流消息与结果、事件类型、预算/Raw/血缘/ACK 均未改。
- 测试：离线沙箱（pnpm 9.15.9 离线 store 安装）内 vitest：诊断协议 12 用例、final-stats 9、governed 16、activities 329、controller 7 全过；任务单指定相关回归 13 个 spec 445 用例全过。治理：governance:verify 502/502、docs:verify PASS、file-budgets/module-boundaries/api-postgres-coverage/unsafe-raw-sql/contracts:lint/code-intelligence:test 均 exit 0。`gctl check` 全量结果见 PR 描述。
- 未做：真实 PostgreSQL 行锁/回滚并发未验证（离线 fake 事务不能证明）；未调用真实 DB/宿主 Temporal/外部 API；无迁移、无接口字段变更。
