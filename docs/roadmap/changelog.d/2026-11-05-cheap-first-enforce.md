---
date: 2026-11-05
title: Enforce per-source query budgets for cheap-first discovery routing (cheap-first PR-2)
---

- 起因：Q33② 的规划层（PR-1）只做了 shadow 观测；真正把「结构化源每轮各 ≤100 家、新源前 10 次试跑限额」落到执行路径还缺一步。物化发生在查询阶段之后、收据又是严格键契约，因此按设计 §4.3 的实现对齐点，以「每源每轮查询预算」等价落地：每查询每源记录上限 25 条 × 预算条数。
- 改动：
  - `plan-query-sources`：新增 `SOURCE_QUERY_BUDGET` 裁剪原因；`routePlannerQueries` 支持 `sourceBudgets`（结构化源默认 4 条、试跑源 1 条、public_web 豁免），enforce 时裁掉超额副本、shadow 只统计并在计划注记「将按预算移出 N 条」；新增 `sourceQueryBudgetConfig`（`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_MAX_COMPANIES`/`DISCOVERY_TRIAL_MAX_RUNS`，带默认与钳制）与 `sourceQueryBudgets`。
  - `source-trial`：按工作空间统计 `raw_source_record` 的 distinct run 数判定试跑期（失败降级为空集，不阻塞规划）。
  - `icp.service`：规划时计算每源预算并传入路由；shadow/enforce 语义沿用 `DISCOVERY_CHEAP_FIRST`。
  - 设计文档追加 §11「实现裁定」，说明等价关系与未动的契约面。
- 测试：新增 `sourceQueryBudgets`/预算裁剪/enforce 弃取/shadow 统计/配置解析/试跑计数映射单测；`plan-query-sources` 与 `icp.service` 既有套件回归。
- 未做：不改查询收据与工作流/活动接口；gain-saas 归因「查询数」列与租户投影另行排期。
