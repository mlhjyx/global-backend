---
date: 2026-11-08
title: Add the ops surface for skill enablement and finish S0 documentation
---

- 起因：S0 Skill Runtime v0 第 3 步——运营需要能看技能目录并一键启停；收尾模块文档与状态页回写（设计 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`，已批准）。
- 改动：
  - 新增引擎 ops API：`GET /api/v1/skills`、`GET /api/v1/skills/:skillKey`、`PATCH /api/v1/skills/:skillKey/status`（平台 kill switch）、`GET|PUT|DELETE /api/v1/skills/:skillKey/workspaces/:workspaceId`（workspace 覆盖）。仅 `ops:read`/`ops:write`，租户 token 403。
  - 重新导出 `packages/contracts/openapi/openapi.json`（新增 5 个端点）。
  - 新增模块文档 `docs/modules/ai-foundation/{product,technical}.md`；`docs/status/current.md` 增加 S0 落地与「尚未发车」说明。
- 测试：controller 授权拓扑（guards/每 handler 的 ops scope 元数据）与参数校验单测、service 生效语义与 404 单测（共 15 例）；`gctl check --fast` 与 `docs:verify` 全绿。
- 未做：gain-saas 运营台页面与租户自助启停（S1+）；实际发车部署（需产品负责人单独授权）。
