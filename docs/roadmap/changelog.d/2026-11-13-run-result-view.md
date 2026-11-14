---
date: 2026-11-13
title: Add a read-only run result view separating this-run scoring from latest scores
---

- 起因：run 收尾后只有候选与 lead 的最新投影，无法回答「本轮发现了谁、本轮评了多少分」；lead 是 ICP 级最新投影，把最新分当作本轮评分是错误归因（MP-0.3）。
- 改动：新增 `GET /discovery-runs/:runId/result-view`（只读）：候选集来自 `discovery_company_job + canonical_company`（封顶 500 并回报 `truncated`）；本轮评分来自 `run_event` 的 `qualification_batch_scored`（按 seq 回放，同公司后批覆盖，无事件时标 `not_scored_in_run`，不回填）；最新评分来自 `lead`，单独一列并标注 `latest_not_necessarily_this_run`。
- 测试：新增 `run-result-view.spec.ts` 五个用例（run 不存在、候选截断、本轮与最新分分离、无事件不回填、坏历史 payload 容忍）与 controller 透传用例；`openapi.json` 已重导出。
- 未做：评分批次留痕的写入端在 PR-06b；历史 run 没有该事件时视图如实显示「未评分」，不回填。
