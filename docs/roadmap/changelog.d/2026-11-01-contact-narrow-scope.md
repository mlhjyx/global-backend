---
date: 2026-11-01
title: Add a narrow contact-discovery read scope for named-contact surfaces
---

- 起因：联系人挖掘 M4 需要 SaaS 工作空间管理员读取并操作具名联系人（canonical 公司详情、发现、猜测、验证）。这些端点原先要求 `personal-data:read`，而该 scope 只授予事件消费机器身份；若为了 M4 把它整体授给用户角色，会同时打开事件流、线索详情与建站档案等其它个人数据面，超出本功能所需。
- 改动：
  - 新增闭合 scope `contact-discovery:read`，只覆盖具名联系人数据面。
  - `GET /api/v1/canonical-companies/{id}`、`POST /api/v1/canonical-companies/{id}/discover-contacts`、`POST /api/v1/canonical-companies/{id}/guess-emails`、`POST /api/v1/contact-points/{pointId}/verify` 从 `personal-data:read` 切换为 `contact-discovery:read`；三个写端点仍同时要求 `acquisition:write` 与 `compliance:manage`。
  - 同步操作描述、authz OpenAPI 断言与 scope 词表测试；OpenAPI 契约按装饰器重导出。
- 测试：`pnpm --filter @global/api test`（scopes 词表、OpenAPI `x-required-scopes` 断言）；contracts 重导出后 drift 检查。
- 未做：不改变 `personal-data:read` 的既有语义与授予对象；不在本 PR 修改 SaaS 角色映射或部署配置（`contact-discovery:read` 需由 gain-saas 仅授予 `saas-admin`，并在引擎发布该 scope 后一起上线）；`discover-contacts` 的 workspace 报价仍 fail-closed（联系人阶段预算账户/报价是另一个缺口）。
