# 实现状态矩阵（设计 ↔ 实现）

> 文档 ID：`DOC-STATUS-IMPLEMENTATION-MATRIX-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-02（基于 247 份 md 通读 + 代码审计）
> 用法：排期与验收的唯一矩阵；详细证据见各模块 `technical.md` 与 `status/current.md`。

| 模块 | 能力 | 设计 | 实现 | 测试 | 运行 | 缺口/下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 账户与工作空间 | 注册/登录/会话 | APPROVED | gain-saas as-built | 部分 | 运行 | 限流落库、CSRF、cookie Secure |
| 01 | 工作空间/成员/切换 | APPROVED | as-built | 少 | 运行 | `/api/workspace/context`（角色/允许动作/引导态）已上线（2026-11-03）；Entitlement 预算与计费仍待 Phase 1b/二期 |
| 01 | 注册引导 | APPROVED | gain-saas as-built（2026-11-03 上线） | 有（onboarding 控制器 8 例 + BFF 门禁） | 运行 | 注册页「创建账号」口径与邀请码显隐已整改；公司名去留等字段细则留 Phase 5 |
| 02 卖家知识中心 | 公司档案/Offering/Claim | APPROVED | 引擎 as-built | 中 | 运行 | `targetMarkets`/`businessEmail`/`Offering.source` 已落（#743，2026-11-02 迁移）；资料库仍缺 |
| 02 | 资料库（上传/解析/检索） | APPROVED | 缺（site-builder KB 可复用） | — | — | seller_document + ingest（Phase 2） |
| 02 | 文档事实抽取/审批 | APPROVED | 缺 | — | — | extract_facts + 证据门（Phase 3） |
| 02 | 理解双源/ICP 消费 | APPROVED | 官网-only | 中 | 运行 | 双源 + ICP 上下文（Phase 3） |
| 03 买家知识网络 | canonical/证据/联系人 | APPROVED | as-built（M1–M4） | 中 | 运行 | 背调（Phase 3）、customs 源（RL2） |
| 03 | 禁联/信号 | APPROVED | as-built | 中 | 运行 | 通知与 scope 调整 |
| 04 发现与资格 | ICP/计划/run/线索/交付包 | APPROVED | as-built | 强 | 运行 | 性能改造（Phase 2b）、rerun（Phase 4） |
| 04 | 任务/重试（SaaS） | APPROVED | 缺 | — | — | AcquisitionTask/TaskRun（Phase 4） |
| 05 独立站 | M1（intake/素材/KB/Release） | APPROVED | as-built | 中 | 运行 | 冻结（PRD4-D1）；M2/M3 未实现 |
| 06 内容与 GEO | 目标 | 设计 | 缺 | — | — | 后续模块 |
| 07 触达与会话 | 目标 | 设计 | 缺（OpenOutreach/Chatwoot 参考） | — | — | RL4 |
| 08 机会与 QGO | 目标 | 设计 | 缺（SaaS） | — | — | 后续 |
| 09 学习与增长 | 目标 | 设计 | 缺 | — | — | Phase 8 平台学习层 |
| 平台 | R4 平台权威 | 设计 | gain-saas 迁移完成 | 中 | 运行 | GrowthOS 退役收尾 |
| 平台 | 事件消费 | APPROVED | as-built | 少 | 运行 | 即时触发/对账/毒事件隔离（Phase 6） |
| 平台 | 可观测性 | APPROVED | 缺 | — | — | 日志/trace/metrics/告警（Phase 6） |
| 平台 | 成本账本 | APPROVED | 失效（payload 不匹配） | — | — | 修复（Phase 6） |
| 平台 | 备份 | APPROVED | 引擎有/gain-saas 无 | — | 部分 | gain-saas 备份（Phase 1a） |
| CI/CD | 5 项必需检查 | APPROVED | as-built | 强 | 运行 | 提速（Phase 1b） |
| CI/CD | dev 自动发布 | APPROVED | 缺 | — | — | Phase 1b |
| 前端 | 六步主链路 | APPROVED | PRD 子集 | 无 | 运行 | 重建（Phase 5） |
| 前端 | 资料库/背调/任务中心 | APPROVED | 缺 | — | — | Phase 3–5 |

## 图例

- 设计：`APPROVED` / `DRAFT` / `SUPERSEDED`。
- 实现：`as-built` / `部分` / `缺`。
- 测试：`强` / `中` / `少` / `无`。
- 运行：`运行` / `部分` / `—`（无运行证据）。
