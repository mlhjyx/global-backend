---
date: 2026-11-04
pr:
title: Close the ICP feedback loop (decision aggregation, query-family EMA weights, suggestion cards)
---

- 起因：设计 §7.1——判断结果（接受/拒绝 + mismatch 理由）目前只落库不回喂；本轮把「判断 → 聚合 → 查询权重与 ICP 建议」闭起来，且坚持建议卡人工采纳才改 ICP。
- 改动：
  - 新表 `icp_feedback`（来源/渠道/行业/国家的接受率与拒绝理由分布）与 `icp_query_performance`（来源类目的 EMA 质量分，Alpha=0.3）；租户 RLS。
  - `IcpFeedbackService`：幂等重算（Lead + LeadDecision + 渠道 sighting + raw 来源血缘）、建议卡（零接受行业/渠道/国家、强势细分）、规划提示词加权备注。
  - 接受/拒绝接口在决定成功后 best-effort 触发重算；`GET /icps/:id/feedback` 与 `POST .../feedback/recompute` 两个端点。
- 测试：聚合/理由计数/EMA 混合/建议卡阈值/规划备注 4 条单测、迁移静态契约；全量 API 单测与 docs/governance。
- 未做：查询族按「查询文本」精确聚合（v1 按来源类目）；回复/退订结果回流（随触达阶段）；watches 刷新 run 调度（下一 PR）。
