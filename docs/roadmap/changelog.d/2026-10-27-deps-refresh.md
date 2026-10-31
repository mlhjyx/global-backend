---
date: 2026-10-27
pr: 679
title: Clear 13 newly published production advisories and rebind the audit baseline
---

- 起因：2026-10-19 的基线捕获为零 advisory，之后 GitHub 又发布了 13 条 production advisory（body-parser、multer、fast-uri、undici 7/8、zod），而锁文件本身没动——main 的 `production advisory baseline freshness · canary` 变成 `BASELINE_STALE`，并且 11-02 到期后所有改依赖的 PR 都会被拦。
- 改动：
  - root overrides 钉住四条线的修复版本：multer 2.5.0、fast-uri 3.1.9、undici 7.30.1 / 8.12.2、zod 4.6.7；body-parser 2.4.0 由 express 的 `^2.2.1` 自然解析，没有 override，由 `SECURITY_FLOORS` 兜底（将来若被解析回 2.3.x，是 floor 测试报警而不是 override 拦住）。
  - `packages/contracts` 由 zod `^3.25.76` 升到 `^4.6.6`（全仓唯一声明 zod 的包；代码零改动，10,327 个单测通过）。
  - `SECURITY_FLOORS` 上调到修复版本，7 个被替换的版本登记进 `VULNERABLE_PREDECESSORS`。
  - 解析时 pnpm 曾把 `@opentelemetry/propagator-jaeger@2.12.0` 的弃用说明（带 `https://` 链接）写进工作区的锁文件；供应链策略禁止锁文件出现任何 URL，已删除这行纯元数据（main 的锁文件本就没有它，所以 diff 里看不到这条删除）。下次非 frozen 的重新解析可能再带回，届时同样删掉即可。
  - 基线重绑到 `c33861aa` 及其锁文件摘要，`valid_until` 延到 2026-11-10T05:13:39Z；`supply-chain-gates.spec.mjs` 钉值同步；新增冻结回执 `docs/evidence/security/20261027-production-advisory-remediation.json`（修复前 CI 上的 `BASELINE_STALE`/13 条 → 修复后 `FRESH`/0 条）。
  - Copy fixed-source 回执重签（`HASH_ONLY`）。
- 测试：`pnpm --filter @global/api build` 绿；`pnpm --filter @global/api test` 10,327 passed（本机缺 Chrome 的 2 个用例在装上 Chrome 后单独验证 52/52）；`pnpm governance:verify` 绿；`supply-chain-audit verify` 为 `PASS_CLEAR`；`validate-sources` 为 `DEPENDENCY_SOURCES_TRUSTED`。
- 未做：本轮只升级受 advisory 影响的五条依赖线，没有做每月一次的 `pnpm update -r` 全量 minor/patch 批量升级（留给 11 月的月度刷新），也未动 NestJS、astro 等大版本。
