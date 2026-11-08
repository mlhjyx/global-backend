---
date: 2026-11-08
pr: 896
title: Expose platform-wide DNC suppression endpoint
---

- 起因：M2 步 11-4 需要把退订/投诉/退信事实写进平台级抑制表，跨租户阻止后续发送。
- 改动：新增 `POST /outreach/dnc/suppress`（`compliance:manage` + 控制面服务令牌 `OUTREACH_INTERNAL_SERVICE_TOKEN`），复用 `suppressGlobal`，只落邮箱 SHA-256、幂等；OpenAPI 重新导出。
- 测试：`src/outreach` 单测 9/9（含服务令牌 503/403/放行）；构建与 OpenAPI 导出通过。
- 未做：gain-saas 侧的调用接线在 gain-saas 11-4 PR；真实域名验收属 11-5。
