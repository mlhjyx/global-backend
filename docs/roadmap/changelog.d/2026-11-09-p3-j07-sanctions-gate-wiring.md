---
date: 2026-11-09
title: Wire the L0 sanctions gate into quick scan and deep judge with a deduped stale alert
---

- 起因：P3 J07（设计 §4.3.2.2 W8）——J05 的门引擎已在库里，但判定链从未调用它；制裁名单陈旧（当前真实数据 `eu_fsf` 最近一次刷新 FAILED）既不会标记结果，也不会告警。
- 改动：
  - `apps/api/src/discovery/judgment/gate-chain.ts`：L0 门链接线层——`evaluateL0Gates` 归一化门链结论（G1 四态 fresh/yellow/red/not_screened、G5 UNKNOWN、补数门集合），`quickScanGateBlock`/`deepJudgeGateBlock` 执行模式矩阵（与 `JUDGE_CONTRACT_MODE` 协同：深判 off 不评估 L0、shadow 记录不拦截、enforce FAIL 拦截；快扫总是评估、但 G1 拦截仅 enforce）。`SANCTIONS_LIST_STALE` 告警复用已注册的 `SanctionsListStale` outbox 集成事件，按「workspace × 状态 × 失败/缺刷新源集合」去重（6 小时常量窗口 + 进程内缓存 + 库内回看）。
  - `SanctionsScreeningService.freshness()`：四态口径与门引擎同源（72h/168h 常量）；`screen()` 结果带 `stale` 标记（yellow/red）。`eu_fsf` FAILED 且超 168h 推导 red。
  - 深判接线：`fitCompanyOnce`（run2 流水线）在模型调用前评估 L0——enforce 下 FAIL 不调模型、job 记 NOT_FIT；yellow/red 不拦截，`sanctionsStale` 随 `lead.fitReasons` 落库。快扫 `quickJudgeBatch` 把 stale 标记写进 `company_done` 事件。
  - `docs/backend/sanctions-operator-refresh.md` §7：四态口径、告警载荷与去重、处置顺序。
- 测试：`gate-chain.spec.ts`（四态 × 红线：eu_fsf FAILED→red、yellow/red 不判 NOT_FIT、模式矩阵、告警去重 6h、replay 幂等、补数任务写入）；`sanctions-screening.spec.ts` 四态与 `screen().stale`；`discovery.run2.activities.spec.ts` shadow/enforce 快扫行为；`discovery.run2.pipeline.activities.gate.spec.ts` 深判三种模式。
- 未做：影子期金标对比（L0 记录 vs 旧路径产出的一致性报表）；legacy `discovery.activities.ts` 的 `qualifyFitForRun` 未接线（当前生产走 run2 快扫 + companyPipeline；该路径等 run2 开关全量后随旧链路退役）；`>14 天硬停` 的 env 熔断仍按「不用 env」保持未实现（red 只标记 + 告警，不拦截判定，执行在 J20）。
