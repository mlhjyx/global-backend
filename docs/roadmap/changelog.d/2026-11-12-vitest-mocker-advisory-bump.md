---
date: 2026-11-12
title: Bump vitest to 4.1.12 for the @vitest/mocker advisories
---

- 起因：2026-11-12 审计 P1-9；Dependabot 对 `@vitest/mocker` 4.1.11 报出 2 条 medium（手工 mock 注册可注入、Windows 反斜杠穿越绕过 redirect 白名单），修复版本 4.1.12。
- 改动：三个 workspace 的 `vitest` 由 4.1.11 升到 4.1.12（`@vitest/mocker` 随之解析到 4.1.12），`@vitest/coverage-v8` 同步钉 4.1.12；锁文件变动按 `docs/backend/dependency-refresh.md` §4 在第 2 个提交重新绑定漏洞基线并更新 `supply-chain-gates.spec.mjs` 的 `REPOSITORY_BASELINE_NOW`。
- 测试：`pnpm audit --prod` 零 advisory（生产面不变）；`pnpm governance:verify`；`@global/api` build + 全量单测；CI 必需检查。
- 未做：`minimatch`（经 eslint 10 / typescript-eslint 8 解析 10.2.6）与 `glob`（经 @nestjs/cli 11 解析 13.0.6）的修复版本要求跨大版本（11.x / 14.x），上游父依赖的范围尚未放宽，强推 overrides 会破坏 lint/build 工具链；`@faker-js/faker` 5.5.3 由 `json-schema-faker` 钉死在 v5（v5 无修复版本）；`deepmerge` 4.3.1 上游无修复。以上均为 dev 工具链路径、不在生产依赖审计范围，保留 Dependabot 告警并在审计报告登记。
