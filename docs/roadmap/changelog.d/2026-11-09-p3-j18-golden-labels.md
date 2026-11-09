---
date: 2026-11-09
title: P3 J18 — 金标晋升/季度退役 CLI 与分布报表
---

- 起因：ch04 §4.3.8.3 —— 复核结论先入 `candidate`，需人工批量评审后晋升 `calib`/`test` 才进校准与回归；没有晋升/退役工具，金标池只会越积越乱且无法轮换。表为 append-only（J04 授权 SELECT/INSERT），故晋升与退役都必须**追加新 split 的行**。
- 改动：
  - `apps/api/src/discovery/judgment/golden-label.ts`：纯函数 `planPromotion`（按 labeledAt 升序、limit、`--ids` 白名单、已晋升幂等跳过）与 `planRetirement`（保留最新 N 行、其余退役）；`promoteGoldenLabels` / `retireGoldenLabels` / `goldenLabelSummary` 三个 withWorkspace 事务封装；dedupe key = 七维内容键。
  - `scripts/judgment/promote-golden-labels.mts`：ops CLI（`--to calib|test|retired`、`--limit`、`--ids`、`--dry-run`、`--retire-keep/--from-split`、`--summary`），输出 JSON 摘要，非零退出表示失败；连接优先 app_user（RLS 生效）。
  - `packages/db/test/golden-label.rls.spec.mjs`（db-tests service 组）：晋升追加/原行不变/重跑只晋升剩余/退役幂等/跨租户不可见。
- 测试：`golden-label.spec.ts` 5 例纯函数；库上 spec 2 例；`nest build` 通过。
- 未做：晋升审批流（本周由质量负责人跑 CLI 评审）、overturn 周报（J16 与度量报表一并做）、真实标注集（J13，需人力）。
