---
date: 2026-11-10
title: Acquisition vNext W3 evaluation sets, precision@k, Chapman coverage and source-yield accounting
---

- 起因：获客挖掘 vNext 要求「覆盖率是可测的量」（golden set precision@k、双源捕获-再捕获 recall 估计、每源边际产出会计、账单三方对账），计划 docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W3。
- 改动：
  - 迁移 20261110060000_acquisition_evaluation 追加四张租户表（均 ENABLE+FORCE RLS）：evaluation_set、evaluation_label、source_yield_ledger、coverage_estimate；app_user 权限同步登记到 docs/governance/app-user-table-privileges.json。
  - 新模块 apps/api/src/evaluation：POST /evaluation/sets、POST /evaluation/sets/:id/labels、GET /evaluation/sets/:id/report（precision@k）、GET /evaluation/coverage（Chapman 估计 + 95% CI，自动存证）。
  - source_yield_ledger 生产写入接入 discovery finalizeRun 同事务（幂等），并提供 backfill-source-yield-ledger 回填脚本与 evaluation-import-golden-set 导入脚本。
  - /metrics 新增 GET /metrics/source-yield（按日/周×源聚合）与 GET /metrics/billing-reconciliation（usage_ledger ↔ tool_budget_operation ↔ tool_budget_account 三方视图，标注余额来源表）。
- 测试：Chapman 数值/零重叠/一边为空边界、precision@k 口径、对账差额、候选/覆盖身份键、迁移结构单测；OpenAPI 重导出，operation-descriptions 全覆盖。
- 未做：真实 golden set 标注样例由产品负责人提供后导入（≥100 家）；覆盖估计的真实双源数据要等 W4 原始源装载器上线后在真实 run 上取数；客户钱包余额真值仍在 gain-saas，对账的余额侧只到执行包络。
