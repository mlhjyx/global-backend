---
date: 2026-10-31
title: Update the API portal intro to the gain-saas identity source
---

- 起因：接口门户的接入说明写的是 GrowthOS 签发 JWT、token 声明名为 `workspace_id`，与 2026-10-29 起的 gain-saas 身份源（`https://127.0.0.1:18446`，claim 为 `workspace`）不符；配套的 `api-token` 工具仍走已退役的 GrowthOS 登录页，对接方拿不到可用于调试的 token。
- 改动：
  - `apps/api/src/docs/portal-intro.ts`：认证说明改为 gain-saas 签发、claim 名 `workspace`；机器通道（ExecutionBudget / PlatformAuthority）改称 gain-saas；地址表补充门户自身地址 `http://100.68.31.20:3000/api/portal`。
  - `packages/contracts/INTEGRATION.md`：新增「模块与接口覆盖」一节（模块→分域→接口；无独立接口的模块说明数据从哪来；对接三个常见坑）。
  - 工作区工具 `/global/local-config/bin/api-token` 改为经 gain-saas `EngineTokenSigner` 现铸 300 秒 token（不入本仓）。
- 测试：用新 token 实测 `GET /api/v1/leads` 200；`nest build` 通过（CI `contracts · drift · lint · breaking`）。
- 未做：门户文本随镜像构建生效，需下一次后端发版才会出现在运行中的门户。
