---
date: 2026-10-28
title: Absorb every unreplayable operation per query or company instead of failing the run
---

- 起因：验收 run `659f2320`（2026-10-27）在上游连续流错误后失败——16:04–17:07 之间 19 次模型调用被上游中断、已扣费且没有 durable result（$0.42）；活动重试时相邻两家公司都撞上这些不可重放的旧操作，触发 best-effort 阶段的「连续两次不可重放即判 run 失败」规则。该规则把**上一次尝试留下的残留**误读成「当前上游整体故障」：画像阶段逐家顺序执行，所谓“连续两家”必然来自两次不同时间的孤立故障，与当前上游健康与否无关（fit 阶段一直是按单公司跳过的）。
- 改动：查询、官网画像、信号富集、网站监控四个阶段的不可重放操作一律按单查询 / 单公司跳过并计数（`unreplayableSkips`），run 以 PARTIAL 结束；上游是否健康仅由当前尝试自身的控制错误判定（既有的重试等待与租约停止链路）。线上的 `previousQueryUnreplayable` / `previousUnreplayable` 交接字段保留（旧历史重放不受影响），但不再影响任何决定；`isUnreplayableOperation` 的文档改为上述推理。
- 测试：`discovery.activities.spec.ts` 四个阶段的“连续两次即停”用例改为“逐条吸收并计数”；`workspace-authority.workflow.spec.ts` 与 rehearsal 的同名场景改为断言 PARTIAL 与计数（查询 2/2、信号 12 家上限）。全量零容器单测与 `gctl check --fast`。
- 未做：不改变 D13（已扣费无结果的调用永不重放、避免二次付费）本身；不处理上游 new-api 渠道的健康度（另一条线）。
