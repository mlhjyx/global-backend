---
date: 2026-11-09
title: Channel record watchlist — review status, sampling endpoint and rejection-rate disable
---

- 起因：v3.0 第 6 章 CH-7 / CP-G8——渠道产出直接进共享池，没有观察名单、没有人工抽检；手册要求「新渠道首 3 轮产出 PENDING、抽检 ≥20 条后才可批量并入正式池」，REJECTED 率 >20% 时渠道回 DISABLED。
- 改动：
  - 迁移 `20261109150000_channel_record_review`：`source_channel_record` 增 `review_status`（PENDING|APPROVED|REJECTED，默认 PENDING）、`reviewed_by`/`reviewed_at` 审计足迹与 `materialized_company_id` 引用位（跨租户口径未定，只留列不建外键）；三态审计一致性 CHECK；`(channel_id, review_status)` 索引。存量 48 行保持 PENDING（从未抽检，不伪造 APPROVED）。
  - 物化写入器：新观测 create 显式 `review_status=PENDING`；重复观测的 update 不改抽检结论（人工决定不被覆盖）。
  - `GET /source-channels/:id/records`：支持 `reviewStatus` 过滤并返回三态计数与审计字段。
  - `POST /source-channels/:id/records/review`（ops:write）：批量置 APPROVED/REJECTED；跨渠道/非法 id 拒绝；已抽检 ≥20 条且 REJECTED 率 >20% 时渠道回 `DISABLED(reason=GOVERNANCE)` 并写健康事件（detail.reason=RECORD_REJECTION_RATE）。
- 测试：物化写入器（PENDING/不覆盖）、抽检服务（审计字段、过滤与计数、20 条与 20% 双阈值、非法输入）、迁移静态契约、authz 矩阵与 operation 描述。
- 未做：「并入正式池」（写 materialized_company_id + companyChannelSighting）因平台渠道记录到租户公司的跨租户口径未定，留待产品拍板后单独卡片；未部署。
