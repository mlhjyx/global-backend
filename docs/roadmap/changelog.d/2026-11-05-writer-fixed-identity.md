---
date: 2026-11-05
pr: 815
title: Verify the writer fixed-identity token shape on the engine side
---

- 起因：平台授权器（`infra/temporal-platform/server/readerpolicy/machine_policy.go`）把 `platform-temporal-schedule-writer` 定义为「无 profile 的固定身份」：`typ` 必须恰为 `JWT` 且禁止 `profile` 声明。gain-saas（#66）已按该形状签发，但引擎侧 `machine-token-verifier` 仍要求旧的 `temporal-runtime+jwt` + `profile` 形状，把平台接受的令牌拒掉（`PLATFORM_MACHINE_TOKEN_UNAVAILABLE`），writer 身份仍不可用——引擎与签发方两侧契约必须同时对齐（真机验收发现的第三处阻塞点的引擎半边）。
- 改动：`temporal-platform-client` 档案的验证改为固定身份形状：`typ` 必须为 `JWT`、payload 允许字段不含 `profile`（携带即拒）、`permissions` 仍须精确等于 `["platform-automation:write"]`；其余档案（capability/worker/reader）的验证逐字节不变。
- 测试：新用例覆盖「固定身份接受 / 旧档案形状拒绝 / 带 profile 的 JWT 拒绝」三态，红→绿；`machine-token-verifier` 相关套件全过。
- 未做：不改平台授权器；不改 gain-saas（已合并 #66）；随下一班镜像生效。
