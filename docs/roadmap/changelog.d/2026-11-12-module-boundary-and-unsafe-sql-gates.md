---
date: 2026-11-12
title: Add module-boundary, unsafe-raw-SQL and coverage ratchet gates
---

- 起因：2026-11-12 工程审计 A/C/L 发现 `apps/api` 存在一个覆盖 33 个模块的运行时依赖环且无 import 边界门；生产代码有 34 处 `$queryRawUnsafe`/`$executeRawUnsafe`，没有约束新增调用。
- 改动：
  - 新增 G16 `scripts/governance-module-boundaries.mjs`：按运行时相对 import 建模块对，基线 `g16-module-boundaries.json` 记录当前 286 对；新增对失败，消失的对只提示。
  - 新增 G17 `scripts/governance-unsafe-raw-sql.mjs`：按文件记录当前 34 处 RawUnsafe 基线；超出基线的新调用必须带 `// unsafe-reason:`（同 行或前 3 行），基线文件消失未清条目也失败。
  - `build-test` 接入两道门；`docs/backend/ci-gates.md` 登记 G16/G17。
  - G18 覆盖率棘轮：`apps/api/vitest.config.ts` 增加 v8 coverage 阈值（实测 lines 88.99 / statements 86.8 / functions 88.18 / branches 81.19，阈值取整为 88/86/87/80）；由 `governance.yml` 每周一 + 手动触发运行，排除 Temporal/eval 与静态扫描测试。
- 测试：两道门 `verify` 通过；覆盖率在本地以同口径实测并生成摘要；阈值门在 CI 中执行。
- 未做：不重构现有 33 模块环；不重写现有 RawUnsafe 调用；覆盖率暂不进入每 PR 必过门（每周棘轮，避免重复跑全量测试）。
