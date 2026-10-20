---
date: 2026-10-20
title: Write a discovery run's outcome once, and record FAILED at finalize when its authority already ended
---

- 起因：`finalizeRun` 有两处缺陷。
  - 授权已结束（准入租约到期、被撤销或预算耗尽）时收尾 `DONE` 或 `PARTIAL`：attest 直接抛错，什么都没写入，工作流因收尾错误失败，run 一直停在 `RUNNING`。ADR-024 的补充写的是「超出租约记 FAILED」，实际却从来没有记上。
  - 收尾结果已提交、但回执丢失后重试：会再更新一遍、计划版本再加 1，并再发一次 `DiscoveryRunCompleted` 和 `QualifyRequested`。
- 改动（`apps/api/src/temporal/discovery.activities.ts`，只改活动，不改工作流，不需要 patch）：
  - 终态只写一次：库里已经是同一个终态时直接返回。这一步只读，放在 attest 之前，所以授权到期后的重试也能成功。请求 `DONE` / `PARTIAL` 而库里已是另一个终态时，抛不可重试的 `DISCOVERY_RUN_ALREADY_FINALIZED`。`FAILED` 仍然只关闭 `RUNNING` 的 run。
  - 授权已结束时收尾 `DONE` / `PARTIAL`：在同一个写事务里改记 `FAILED`，`stats.failure = { stage: 'finalize', errorType: 'ExecutionBudgetGrantError', control: true }`，其余 stats 保留（回执比对照旧）；fit 判过公司时照常请求评分；之后以不可重试的原错误失败，工作流照样失败，但库里与它一致。
  - `DiscoveryRunStage` 新增 `'finalize'`，并加入「已到 fit」的阶段集合。
  - `packages/contracts/INTEGRATION.md` 写明这种收尾结果。
- 测试：`discovery.activities.spec.ts` 先 RED 后 GREEN。
  - 授权已结束时把 `DONE` / `PARTIAL` 改记 `FAILED(stage=finalize)`：3 例，覆盖到期、撤销、耗尽。这条替换了原来锁定「什么都不写」的用例。
  - 已提交的重试：不 attest、不再写、不发事件，2 例。
  - 已是别的终态时拒绝：3 例。
  - temporal、discovery 下共 2299 例通过。
- 未做：
  - 没有加「卡在 `RUNNING` 的 run」的兜底清理器（通过 terminate 或执行超时停下的 run）。
  - 也没有改「授权结束后不花钱的收尾能否仍记 `DONE` / `PARTIAL`」这条口径；需要的话由产品负责人决定。
  - 租约感知的软截止另起 PR：让 run 在租约到期之前就以 `PARTIAL` 收尾，这样多半不会走到这里。
