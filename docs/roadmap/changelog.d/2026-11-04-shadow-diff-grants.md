---
date: 2026-11-04
pr: 792
title: Grant app_user UPDATE on run_shadow_diff for shadow upserts
---

- 起因：M0⑥ 影子对比由 `runShadowDiff.upsert` 写入，但 `20261104130000_run_shadow_diff` 只授了 `SELECT, INSERT`（照抄 `run_event` 的 append-only 模式）；首个真实影子 run 即以 `42501 permission denied for table run_shadow_diff` 失败（2026-11-04 影子两轮验收发现）。
- 改动：
  - 新迁移 `20261104190000_run_shadow_diff_app_user_grants`：`GRANT UPDATE`（无删除路径，`DELETE` 保持不授）。
  - `docs/governance/app-user-table-privileges.json`：`run_shadow_diff` → `INSERT, SELECT, UPDATE`。
  - 权限矩阵行为测试新增用例：以 `app_user` 在租户上下文中真实执行 create → update upsert（事务回滚）。
- 测试：本地 `global_test` 上 RED（42501，与生产一致）→ GREEN（15/15）；CI 必需检查验证。
- 未做：无。
