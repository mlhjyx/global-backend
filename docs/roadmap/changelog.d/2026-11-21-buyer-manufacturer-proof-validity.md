---
date: 2026-11-21
pr:
title: Bound delivery validity by the current manufacturer proof deadline
---

- 起因：厂家证明已按真实 artifact/source/identity 最短期限过期，但交付包、accept 快照与周报仅按 FieldEvidence 分级 TTL 显示半年后有效期。
- 改动：共享读取器仅取同工作区/公司的当前最新厂家字段，通过只读 proof 表精确关联及既有 schema、主体、时间和权利校验获得原期限，交付读模型与既有字段 TTL/intent 取最早。合法过期期限继续参与计算；存在但无法验证的字段显示未知，读取失败不伪造未来日期。无厂家字段保持旧路径，不新增 API、公开字段或迁移。
- 测试：GET 与共享计算先复现一天期限被扩为半年后的 RED；受影响 lead/report 单测与现厂家 codec 回归覆盖来源、租户/主体/日期/权利负例、过期不续鲜、accept delivery/不可变 snapshot、周报和无厂家旧语义；新增隔离 PostgreSQL 测试实际验证 SQL、app_user ACL/RLS、最新字段、过期 JSON、伪造 FE 与跨租户/主体。
- 未做：未改评分、资格/联系人缓存或准入政策，未触业务/生产 DB，未发起真实 Provider/模型调用、业务运行或部署；main 后续整合及其额外迁移/新制品采用另行验证。
