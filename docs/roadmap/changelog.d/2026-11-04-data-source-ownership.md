---
date: 2026-11-04
title: Move platform channel governance to an ops-only scope (data-source ownership P3)
---

- 起因：巡检 B7 实证：平台渠道注册/治理（`source_channel` 为全局表、无 workspace 维度）的写端点与租户共用 `acquisition:write`，任何租户管理员都能新建/改写平台级渠道；运营台 `/ops` 没有渠道页，租户设置页反而承担了平台治理职责。
- 改动：新增引擎授权 scope `ops:write`（`AUTHORIZATION_SCOPES` 第 12 个，运营身份 `saas-ops` 专用，租户角色不得携带）；渠道端点重划权限——`GET /source-channels`→`ops:read`，`POST /source-channels`、`PATCH /source-channels/{id}`、`preview`、`run`→`ops:write`，租户保留 `available`（`acquisition:read`）、enable/disable（`acquisition:write`）与私有导入；导入契约提示：`import-template` 返回 `columns` 与建议 `mapping`，`mapping` 缺失/错配时错误信息列出可用列并给示例；OpenAPI 补 `Channels` tag 描述并重新导出（顺带修复该 tag 缺失的既有漂移）。gain-saas 同批 PR：运营台新增渠道数据源页（`saas-ops` 引擎角色 + 操作审计落 `AuditLog`），租户设置页收缩为「启用渠道 + 导入名单」。
- 测试：`scopes.spec` 十二 scope 闭合契约；新增 `channels-authz.http.spec`（租户身份调用平台端点 403 且零服务调用、`ops` 身份调用租户端点 403、匿名 401、OpenAPI `x-required-scopes` 契约、导入模板 `mapping`）；`channel-import.spec` 增加建议映射与错误提示用例；`authz-openapi`/`controller-authz`/`operation-descriptions` 门全绿。
- 未做：抓取执行仍 fail-closed 409（`platform.channel_crawl` purpose 按 implementation-record 分段实施）；引擎侧不新增审计表——运营动作的 actor 审计落在 gain-saas `AuditLog`（引擎记录本身即渠道表时间戳与运行记录）。
