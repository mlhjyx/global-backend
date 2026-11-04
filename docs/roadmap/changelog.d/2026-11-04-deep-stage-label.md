---
date: 2026-11-04
title: Label deep-stage discovery failures with their own stage
---

- 起因：巡检实测（run f8f494e8，取消落在深挖段）发现 `stats.failure.stage` 记的是 `quickScan`——工作流的 stage 变量在进入深挖后没有更新，失败/取消记录因此指向错误的阶段（前端阶段卡与排障都受影响）。
- 改动：`DiscoveryRunStage` 增加 `'deep'`；进入深挖（`markRunPhase(deep_started)`）后把 stage 置为 `'deep'`，用 `discovery-deep-stage-label-v1` patch 守卫——patch 前的旧历史重放仍按原值记录，命令序列不变。前端（runs 页 FAILURE_STAGE/TECH_FAILURE_STAGE）在 P1-G3 已支持 `deep` 的映射，无需改动。
- 测试：`discovery.run2.workflow.spec` 新增用例——深挖子工作流以 Temporal 失败中止时，最终 `finalizeRun(FAILED)` 的 `stats.failure.stage === 'deep'`；run2 工作流套件 8/8。
- 未做：不改变任何取消/失败语义（仅修正记录值）；不新增事件类型。
