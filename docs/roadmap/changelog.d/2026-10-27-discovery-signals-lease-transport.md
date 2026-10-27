---
date: 2026-10-27
title: Stop the signals stage on the lease and count a lost source in stats
---

- 起因：租约软截止（#672）只覆盖查询、画像、fit、富集与监控；信号富集是唯一未接租约的慢阶段，租约见底后仍会逐家读完，run 只能在更晚的收口里被动失败或 PARTIAL。另 #674 已把站点断连造成的单源损失计为 `transportFailed`，但编排层还没把它计入 stats 与状态。
- 改动：
  - `enrichSignalsRun` 在每家公司的 SUSPENDED 检查之后看租约余量，不够一个 `enrich` 单位就停下，余下仍需读取（TTL 新鲜或已完整读过的公司不计）记入 `skippedForLease`。
  - 工作流把 `skippedForLease` 按阶段累计进 `stats.skippedForLease.signals`（run 至少 PARTIAL），并把 `transportFailed` 以 `stats.transportFailed.signals` 呈现（仅在 >0 时出现）；`resolveRunStatus` 增加 `transportFailedSkips` 输入（BI-25），断连损失不再可能读成 DONE。被拒主体与无法重放的公司不重复计入。
- 测试：`discovery.activities.spec.ts` 新增 signals 租约 3 个用例与 `resolveRunStatus` 2 个用例；activities、signals-retry、rehearsal 三个测试文件 311 个用例全部通过。
- 未做：`profileWebsitesForRun` 的首页+Impressum 读取与模型调用仍作为一批 ACK（MIXED 风险），留待单独 PR。
