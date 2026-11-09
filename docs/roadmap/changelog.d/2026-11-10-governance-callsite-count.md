---
date: 2026-11-10
title: Fix stale physical tool callsite count after tool additions
---

- 起因：`#976`（deepseek.search/deepseek.fetch）与 `#975` 先后各加一条物理工具调用点后，`scripts/execution-authority-policy.spec.mjs` 的两处断言仍停在 45，main 的 Governance 与 build·typecheck·test 双红（`verifyExecutionAuthorityPolicy` 对源码的比对本身无 issue，仅数字过期）。
- 改动：`EXPECTED_TOOL_CALLSITES.length` 与 `result.physicalToolCallsiteCount` 的期望值 45 → 46。
- 测试：`node --test scripts/execution-authority-policy.spec.mjs` 17/17 通过（main 上 15/17）。
- 未做：无（不改工具、任务或治理规则）。
