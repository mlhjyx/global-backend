---
date: 2026-11-06
title: Filter run-cost aggregation by the run's budget account key
---

- 起因：真实 ICP 验证 run（86cb6ab4，镜像含 #824）事件 cost=0。discovery 链路的 `ExecutionContext.runId` 是预算账户键 `binding.accountKey`（`discovery.run:discovery_run:request:<sha>:<sha>`，每 run 唯一），sink 写入 `usage_ledger.meta.runId` 的也是它；finalize 却按 run UUID 过滤，永远匹配不到（实查该 run 77 条成本行全部挂在账户键下）。
- 改动：finalize 从 `args.executionBudget` 解析 `accountKey` 作为过滤键（解析失败回退 run UUID，等价不计）。设计文档 D-a 记 v2.1。
- 测试：finalize 归属用例断言过滤参数为 `DISCOVERY_BINDING.accountKey`；`discovery.activities` 全量通过。
- 未做：不回溯已发出的 cost=0 事件（该 run 属验证跑，无需补账）；上线前的存量调用仍无归属键。
