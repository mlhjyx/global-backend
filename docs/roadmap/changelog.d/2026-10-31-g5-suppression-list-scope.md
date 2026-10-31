---
date: 2026-10-31
title: Open the workspace-scoped suppression list to tenant admins
---

- 起因：G5（gain-saas 验收 2026-10-30 交回 backend）发现租户 admin 能 `POST /suppressions`（只要求 `compliance:manage`）却列不出名单（`GET` 额外要求 `personal-data:read`），形成「能写不能读」的盲写黑洞：加错删不掉、也看不到自己加了什么。禁联记录本身是 workspace 隔离的租户合规登记（数据主体反对/退订/投诉），不是引擎采集的招揽联系人。产品负责人 2026-10-31 拍板 D2-B，见 [G5 决策方案](../../superpowers/plans/2026-10-31-g5-tenant-detail-contract.md)。
- 改动：`GET /api/v1/suppressions` 的 scope 从 `compliance:manage` + `personal-data:read` 放宽为仅 `compliance:manage`；`personal-data:read` 仍不授予任何 SaaS 用户角色，联系人/事件流等个人数据面不受影响。同步更新操作描述、authz OpenAPI 断言与契约导出。
- 测试：`authz-openapi.spec` 断言该端点 scope 仅 `compliance:manage`；重导出 OpenAPI 无其他漂移；零容器单测通过。
- 未做：D1-A 的 gain-saas 侧 BFF 路由清理（移除 `GET leads/:leadId`、`GET canonical-companies/:id`）由 gain-saas 仓另行执行；未发布镜像。
