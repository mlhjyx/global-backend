---
date: 2026-11-05
title: Enforce per-source query budgets for cheap-first discovery routing (cheap-first PR-2)
---

- 起因：Q33② 的规划层（PR-1）只做了 shadow 观测；真正把「结构化源每轮各 ≤100 家、新源前 10 次试跑限额」落到执行路径还缺一步。物化发生在查询阶段之后、收据又是严格键契约，因此按设计 §4.3 的实现对齐点，以「每源每轮查询预算」等价落地：每查询每源记录上限 25 条 × 预算条数。
- 改动：
  - `plan-query-sources`：新增 `SOURCE_QUERY_BUDGET` 裁剪原因；`routePlannerQueries` 支持 `sourceBudgets`（结构化源默认 4 条、试跑源 1 条、public_web 豁免），enforce 时裁掉超额副本、shadow 只统计并在计划注记「将按预算移出 N 条」；新增 `sourceQueryBudgetConfig`（`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_MAX_COMPANIES`/`DISCOVERY_TRIAL_MAX_RUNS`，带默认与钳制）与 `sourceQueryBudgets`。
  - `source-trial`：按工作空间统计 `raw_source_record` 的 distinct run 数判定试跑期；零记录的新源（SQL 不产出行）按 0 次运行进入试跑期；失败降级为空集，不阻塞规划。
  - `icp.service`：规划时计算每源预算并传入路由；shadow/enforce 语义沿用 `DISCOVERY_CHEAP_FIRST`。
  - 设计文档追加 §11「实现裁定」，说明等价关系与未动的契约面。
  - 合入前自审修复：零运行新源进试跑期；结构化预算按 §11 精确公式（公司帽 <25 → 0 条，`max(1,…)` 只用于试跑源）；shadow 替换计数改在预算后副本上计算（与 enforce 同口径）；env 参数拒绝畸形数字串（`1e3`/`100abc` 不再被 parseInt 截断）。
- 测试：新增 `sourceQueryBudgets`/预算裁剪/enforce 弃取/shadow 统计/配置解析/试跑计数映射单测；`source-trial` 增补零行源与失败降级用例；`icp.service` 补 `$queryRaw` 注入，钉住「试跑预算 → 路由 → 落库注记」的 shadow/enforce 双语义接线。
- 未做：不改查询收据与工作流/活动接口；public_web 的 run 总池 500 硬闸门与 `data_provider.config` 试跑覆盖本轮未实现（§11 已更正，另行排期 / PR-3 候选）；gain-saas 归因「查询数」列与租户投影另行排期。
