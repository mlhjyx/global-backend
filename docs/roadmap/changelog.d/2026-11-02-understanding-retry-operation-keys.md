---
date: 2026-11-02
title: Scope understanding model budget operations per workflow run and attempt
---

- 起因：2026-11-01 live 实测「理解失败后重试」时发现，同一公司的第 2 次真实尝试必失败：模型付费操作键（paidOperationKey 含 context.correlationId）在理解活动里没有运行/尝试维度，第一次失败后预算行以 RELEASED 保留，后续 Temporal attempt（乃至新 workflow run 的重试）在 reserve 时被判为「已有操作且无 durable result」的 remnant，抛出 `BudgetOperationReplayError`（origin=remnant）。
- 改动：`understanding.activities` 把 `workflowRunId:activityId:a<attempt>` 作为模型调用（extractClaims / extractOfferings / extractAndPersistProfile）与 crawl broker 的 correlationId；同一 attempt 内保持幂等，跨 attempt/跨重试各用独立预算操作行。
- 测试：新增 `modelOperationCorrelationId` 单测；understanding 活动/工作流既有 29 用例全绿；`gctl check` 全绿。
- 未做：其它域的模型活动（discovery / icp / outreach）有同类风险，需逐域评估后再改（不在本 PR 扩大范围）。
