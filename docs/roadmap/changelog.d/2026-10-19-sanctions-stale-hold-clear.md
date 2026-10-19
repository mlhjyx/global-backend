---
date: 2026-10-19
title: Hold a lead whose stored sanctions hit is not cleared, as accept and export already do
---

- 起因：qualify 的 sanctions_hold 只看这次的 live 筛查，accept 与周报导出却同时按库里的命中硬拦（复审 #1 的跨进程兜底）。一家公司的命中消失后（名单移除了实体、匹配规则修正了误报，或索引未生效），lead 停在推荐队列，却永远 accept 不了、也导出不了，原因在队列里看不出来。
- 改动：
  - 新增共用的 `storedScreeningBlocks`（库里的 potential_match 未被人工清白就拦），accept（`decide`）、周报导出与 qualify 三处都用它，不再各算各的。
  - qualify 先对整批公司算完筛查，再用一次查询读出其中「这次没有命中」的公司在库里的命中；未清白（open 或 confirmed_true_hit）的，lead 进 sanctions_hold，由人在复核端点清白。这次有命中的公司走原来的 reconcile 与 upsert，不变。
  - qualify 不新建、不改写任何筛查记录：命中只由人关闭。第一版改成「live 无命中就把旧命中改写为 clear」，对抗复审证实两条误放路径：单独停用一个名单源时，「索引生效」只代表至少一个源有数据，只命中那个源的 open 命中会被清掉；复核人确认真命中与改写并发时，确认会落在一条已是 clear 的记录上。因此改为现在的 fail-closed 做法。
  - 设计决策④（索引未生效时门不拦）有一处收紧：库里已有的未清白命中照样让 lead 进 sanctions_hold，与 accept 早已在做的一致。[制裁筛查设计](../sanctions-screening-design.md) 顶部加了 as-built 注记。
- 测试：`storedScreeningBlocks` 4 例；`qualify.activities.spec.ts` 新增 9 例（open/confirmed × clear/not_screened 均 hold 且不写记录、已清白不 hold、无库存命中不 hold、未接筛查服务也按库存 hold、一批多家只 hold 有命中的那家、有命中照旧 upsert）；新增 `lead.service.sanctions-review.spec.ts` 2 例（清白回落 needs_review、确认的真命中不可清白）。先 RED（10 例失败）后 GREEN。真实数据：xin 上 8 条记录都是人工清白的误报，用本分支的匹配器对真实名单（12268 个实体）重筛仍全部命中且已清白，所以这次部署不改变任何现有 lead 的队列。
- 未做：命中消失后的**自动关闭**（无人复核就放行）没有做。真要做，需要产品负责人拍板，并且至少要有三样东西：名单覆盖与版本单调的守卫、复核端点的条件写，以及带旧命中的审计事件。
