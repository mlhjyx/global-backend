---
date: 2026-11-05
title: Enforce a per-run discovery company pool cap
---

- 起因：Q33② 的「总池 500」兜底配额（`DISCOVERY_RUN_POOL_CAP`）从未实现；既有 `QUICK_SCAN_POOL_LIMIT` 只是 quick-scan 消费侧上限，不约束发现阶段的物化（cheap-first 计划 §11 自审核正）。
- 改动：
  - governed 物化批内按 run 统计已入池公司（outcome 表 distinct `canonical_company_id`），达 cap 后跳过会新增公司的物化，该行落 `NOT_CANONICALIZABLE` + `RUN_POOL_CAP_REACHED`；已在池的公司与终态行（suppressed/restricted/expired/隔离）不受影响。
  - 达界时 `canonicalizeRun` 返回 `poolCap{cap,skipped}`，run stats 记 `poolCap`，`run_event` 同事务写一条 `pool_cap_reached`（幂等）。
  - 新迁移只放宽 outcome 的原因码 CHECK（加 `RUN_POOL_CAP_REACHED`）；`DISCOVERY_RUN_POOL_CAP` 默认 500，`off` 关闭，非法值回退 500。
- 测试：`run-pool-cap` 纯逻辑单测、governed 物化批接线单测（达界/入池放行/终态优先/env off）、真库 postgres spec（恰好 500 边界、跨查询累计、public_web+wikidata 混合、off 回退）。
- 未做：达界不改 run 状态（不是 PARTIAL/FAILED）；契约前历史 run（LEGACY）不设闸以保持重放确定性；gain-saas 归因无改动。
