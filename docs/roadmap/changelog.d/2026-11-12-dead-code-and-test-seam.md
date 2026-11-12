---
date: 2026-11-12
title: Remove a zero-reference data file and move a test seam out of the production build
---

- 起因：2026-11-12 审计 C-3 复核了三个候选：`temporal/workflows.ts` 初看零 import，但它是被 replay specs 与 verify 脚本**按路径**使用的活入口，保留；`acquisition/fair-source-catalog.ts` 全仓零引用；`execution-budget/governed-subject-relation.repository.ts` 只被 spec 通过 URL 加载，却被编译进生产 `dist`。
- 改动：
  - 删除零引用的 `acquisition/fair-source-catalog.ts`。
  - 把 `governed-subject-relation.repository.ts` 重命名为 `*.test-fixture.ts`（`tsconfig.build.json` 已排除该模式），三个 spec 的 URL 引用同步更新；测试语义与覆盖不变。
  - `temporal/workflows.ts` 保留，本次不删。
- 测试：`node --test scripts/governance-workflow-constants.spec.mjs`；全量零容器单测；`pnpm --filter @global/api build`。
- 未做：不删除 governed-subject relation 的测试；不重构 33 模块环；`workflows.ts` 作为路径入口保留。
