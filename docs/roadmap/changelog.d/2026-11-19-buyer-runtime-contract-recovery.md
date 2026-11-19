---
date: 2026-11-19
pr:
title: Repair buyer corroboration persistence and provisional recovery
---

- 起因：独立测试的工厂直采运行因数据库运行事件类型未同步而未能提交补证记录；失败后 quick_scan 暂存判定阻止正常重入。另验证了 Wikidata 标准 hash/missing 响应兼容缺口及限流反馈处理不足。
- 改动：新增仅 DDL 迁移，同步闭合事件类型和 country_qid 的 SQL/应用净化规则；恢复暂存候选且保护最终与人工决定；遵守 Wikidata Retry-After 并使用项目联系地址，不自动重复物理请求；严格接受并丢弃 snak hash、保留缺失实体的空投影。原有来源、预算和身份校验继续执行。
- 测试：真实 PostgreSQL 中以 app_user 和 RLS 验证完整事件词表、非法事件拒绝、字段净化一致性、候选恢复、最终判定保护、当前批次来源约束和跨租户数量上限。6 项真实数据库测试通过（相关覆盖 lines 94.11%、branches 87.5%）；8 文件 224 项应用/provider 回归通过（1 跳过，相关覆盖 lines 96.36%、branches 85.8%）。构建、lint、文档、治理及 ContractGraph 通过；必需 CI 随 PR 核验，具体结果保存在本次任务证据中。
- 未做：不改生产环境、不释放历史未知费用、不重写历史判定、不放宽来源政策或资格门槛；尚须在独立测试环境部署迁移后完成三类客户真实搜索。
