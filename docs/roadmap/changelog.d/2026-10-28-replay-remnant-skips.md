---
date: 2026-10-28
title: Absorb an unreplayable operation left by an earlier attempt instead of failing the run
---

- 起因：验收 run `659f2320`（2026-10-27）在上游连续流错误后失败——16:04–17:07 之间 19 次模型调用被上游中断、已扣费且没有 durable result（$0.42）；活动重试时相邻两家公司都撞上这些不可重放的旧操作，触发 best-effort 阶段的「连续两次不可重放即判 run 失败」规则。该规则把**更早尝试留下的残留**误读成「当前上游整体故障」：画像阶段逐家顺序执行，所谓“连续两家”必然来自两次不同时间的孤立故障（fit 阶段一直按单公司跳过）。
- 改动：`BudgetOperationReplayError` 区分 `origin`——在预留处命中的旧操作是 `remnant`（更早尝试的残留），本次尝试自己已出网、结果没能落库/投影/结算的是 `live`（存储或账本故障的现场证据，默认值，漏标则维持旧行为）。查询、官网画像、信号富集、网站监控四个阶段：`remnant` 一律按单查询/单公司跳过计数（`unreplayableSkips`），`live` 保留原来的「同阶段连续两次即失败」。fit 维持原有语义（所有不可重放都记未判定）。线上的 `previousQueryUnreplayable` / `previousUnreplayable` 交接字段保留，旧 workflow 历史重放不受影响；workflow 代码零改动。
- 测试：四个阶段各新增「活故障连续两次仍停」与「残留/活故障相邻时只计残留」用例；原有“连续两次即停”用例改标为残留并断言逐条吸收；rehearsal 与 workflow 场景改为 PARTIAL + 计数（查询 2/2、信号 12 家上限）。
- 未做：不改变 D13（已扣费无结果、同一 run 内永不重放）；不处理上游 new-api 渠道的健康度（另一条线）。
