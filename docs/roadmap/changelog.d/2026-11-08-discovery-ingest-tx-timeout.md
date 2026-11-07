---
date: 2026-11-08
title: Raise interactive-transaction budget for governed discovery query commits
---

- 起因：run `1541ffd9` 实机故障——`executeQuery` 的 Q-TX（domain-ack 回执 + 百级 raw 记录 upsert + run stats 合并）在共享主机负载下超过 Prisma 交互事务默认 5s 上限（实测 7–8s），活动连续重试失败，目录源整轮记录无法入库（run 卡在 RUNNING、查询收据全零、探针无法取样）。
- 改动：`discovery-query-governed-execution.ts` 导出 `DISCOVERY_RAW_INGEST_TX_OPTIONS`（maxWait 10s / timeout 30s），治理路径与 legacy 路径（`discovery.activities.ts`）的查询入库事务显式使用；无行为/契约变化，只放宽事务时限。
- 测试：`pnpm --filter @global/api build` + discovery 相关单测；样本 run 复跑在发车后验证（收据非零、探针行出现）。
- 未做：canonicalize/materialization 等其它批量事务仍用默认超时（观察项，复现另立）；worker 并发与容量（B12）不在本 PR。
