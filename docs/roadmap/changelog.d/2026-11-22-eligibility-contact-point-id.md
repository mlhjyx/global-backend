---
date: 2026-11-22
pr:
title: Eligibility response carries contactPointId for bounce writeback addressing
---

- 起因：GainOS 发送门已接线 P1-16 可触达性事实源与 bounce-events 回写，但 eligibility 结果不含 contact_point id——SaaS 只能建草稿时自存 pointId，legacy 草稿无法归因，回写覆盖率受限（对接需求 engine-requests.md「必做」项）。
- 改动：`POST /outreach/contact-eligibility` 裸 SQL 增取 `contact_point.id`，`ContactEligibilityResult` 新增 `contactPointId`（多行取最强态时随获胜行返回，未命中 null）。纯响应字段新增，不改匹配口径/RLS/服务令牌鉴权；调用方向后兼容。
- 测试：service spec 增三处断言（VALID 命中带回 id、未命中 null、多行最强态 id 随获胜行）；tsc/eslint 净。
- 未做：无（纯响应字段新增；catch-all 灰度策略与 complaint 回写增强另列于对接需求文档的「可选」项）。
