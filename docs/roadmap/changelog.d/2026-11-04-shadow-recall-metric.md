---
date: 2026-11-04
title: Judge shadow recall on the compared companies and wire the run-event lock test into CI
---

- 起因：影子验收第二轮实况（老路径判 66 家/正面 27，快扫判 27 家/正面 6）——`recallNotLower` 按两侧总数比较，在池子天然不等时把「覆盖差异」误报成「召回下降」；另 run-events 真库用例（#799 热修附带）尚未接入 CI，同类 void 列问题可能再次裸奔上线。
- 改动：`recordRunShadowDiff` 的召回判定改为 **compared 集内比较**（summary 聚合数保留两侧覆盖口径）；新增「不等池子」单测（聚合 4<7 但同集合 4≥3 → 不降）；CI 增加 `run-events.postgres.spec.ts` 步骤（global_test 已迁移环境下执行真实锁语句）。
- 测试：activities spec 9/9；CI 全门（本 PR 含 ci.yml，全量重门跑一遍）。
- 未做：无。
