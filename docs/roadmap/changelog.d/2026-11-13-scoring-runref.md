---
date: 2026-11-13
title: Attribute qualification batches to the discovery run that triggered them
---

- 起因：`QualifyRequested` 已带发现 `runId`，但 relay 只透传 `{workspaceId, icpId}`；评分批次只落在 `lead` 的最新投影上，无法回答「本 run 评了哪些公司、各得多少分」（MP-0.3）。
- 改动：
  - relay 把 `QualifyRequested.payload.runId` 作为 `runRef` 与 `discoveryRunId` 传给 qualifyWorkflow（历史 payload 缺 `runId` 时保持旧参数形状）。
  - `scoreCandidates` 在 `discoveryRunId` 指向本 workspace 真实 run 时，每批追加一条 `run_event`（type=`qualification_batch_scored`，append-only，payload 无个人数据）；按 `batchRef` 去重，活动重试/重放不重复；`candidateBatchRef` 与 `CandidateBatchCompleted.run_ref` 同源。
  - 手工/删除触发的重评分没有 `discoveryRunId`，不写 `run_event`、不伪造 run 归属；虚假/跨租户 run id 视为未提供，不影响评分成功。
  - relay 的 payload 兼容告警与 qualify 参数构造合并到 `relay/event-payload-helpers.ts`，避免既有文件超出 G9 文件预算。
- 测试：`qualify.activities.spec.ts` 新增 4 个用例（每批一条、直接触发不写、run 不可见跳过、按 batchRef 幂等）；`outbox-routing.spec.ts` 新增 2 个用例（runId 透传、缺省保持旧参数）；定向 107 用例通过。
- 未做：LeadQualified 快照的 `runRefs`/`scoreSnapshotRef` 与终端 UX（PR-07）不在本 PR；历史 run 不回填评分留痕。
