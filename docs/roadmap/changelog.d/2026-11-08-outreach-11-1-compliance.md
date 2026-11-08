---
date: 2026-11-08
title: Add the outreach DNC compliance base (11-1)
---

- 起因：M2 步 11 受控邮件触达的合规底座（设计 `docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md`，APPROVED）：发送前必须同时检查租户禁联名单与跨租户全局抑制，任一命中 fail closed。
- 改动：
  - 新增平台级 `outreach_global_suppression`（只存规范化邮箱 SHA-256，无明文；`app_user` 仅 `SELECT/INSERT`，append-only）。
  - 新增 `OutreachModule`：`POST /api/v1/outreach/dnc/check`（≤50 个邮箱，`compliance:manage`）同时查询租户 `suppression_record`（RLS）与全局哈希表，返回命中来源，不回传明文；服务层提供 `suppressGlobal`（幂等）供 11-4 退订接线。
- 测试：`outreach-dnc.service.spec.ts` 覆盖规范化/哈希、租户与全局命中、幂等、去重、非法邮箱/超批；`app-user-table-privileges` 真库清单随表更新。
- 未做：11-2 邮箱/发送工具、11-3 审批流、11-4 回复/退订端点；本步不发送任何邮件。
