---
date: 2026-11-10
title: 公司触发信号只读端点（P1-18 闭环读侧）
---

- 起因：P1-18（#981）已把 changedetection/RSSHub 信号归因落库到 `company_signal`，但没有任何读接口，SaaS 公司/线索详情无法展示「触发信号」——闭环接线清单第 2 项的缺口。
- 改动：
  - 新 `GET /api/v1/companies/{companyId}/signals`（`signals/company-signals.controller.ts` + `company-signals.service.ts`，`SignalsModule` 注册进 app.module）：只读 `company_signal` 中已归因到该公司的行（company_id 非空且等于路径公司），按 `observed_at` 倒序 keyset 分页（base64url cursor，limit 默认 20/最大 100）；RLS 走 `withWorkspace`，查询同时显式带 workspaceId/companyId 纵深防御；只返回元数据（providerKey/signalKind/sourceUrl/title/excerpt/observedAt）。
  - 接口门户说明（`docs/operation-descriptions.ts`）与 OpenAPI 契约重导出。
- 测试：`company-signals.service.spec.ts`（分页映射/游标往返/非法 limit/cursor、RLS 事务参数）；OpenAPI 重导出后 contracts drift 门校验。
- 未做：SaaS 公司详情「触发信号」块（gain-saas 侧 PR 跟随）；signal 消费的 ops-check 告警（接线清单第 7 项）。
