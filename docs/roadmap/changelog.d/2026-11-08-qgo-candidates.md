---
date: 2026-11-08
title: Candidate batch events and read-only candidate view (QGO step 10-1)
---

- 起因：M2 步 10（QGO/SAO/Opportunity 与 Candidate≠Lead）需要引擎侧把「机器候选」从线索语义里剥离出来：候选批次要可追溯（哪个 qualify run、哪一批、判定分布），LeadQualified 要带候选批次引用与证据摘要供下游 QGO 记录「提升时看到的证据版本」。
- 改动：
  - `qualify.activities.ts`：每批（scoreCandidates 分页事务）发一条 `CandidateBatchCompleted`（run_ref/icp_id/batch_no/batch_ref/判定分布/候选 refs，无个人数据），并给每条 lead 的 `score_detail` 写入 `candidateBatchRef = qualify:<runRef>:<batchNo>`；`qualifyWorkflow` 以 `workflowInfo().runId` 注入 runRef（replay 安全；直接调用记为 `qualify:direct:<n>`）。
  - `LeadQualified` 快照升 v2：新增可选 `candidate_batch_ref` 与 `evidence_digest`（资格证据材料 SHA-256），v1 契约文件保留给历史事件；新增 `packages/contracts/events/payloads/lead-qualified.v2.schema.json` 与 `candidate-batch-completed.v1.schema.json`；`CandidateBatchCompleted` 登记进 `INTEGRATION_EVENTS`。
  - 新只读端点 `GET /api/v1/lead-candidates`（`?runId=` 按批次引用前缀 / `?icpId=`/`?queue=` 收窄，游标分页）——不复制表，候选行仍是 lead。
- 测试：`qualify.activities.spec`（每批事件载荷/批次引用写入）、`qualify.workflow.spec`（runRef 注入）、`lead-qualified-snapshot.spec`（v2 契约校验/摘要稳定性/旧载荷兼容）、新增 `lead-candidates.spec`（runId 过滤/投影/空引用/游标分页）。
- 未做：gain-saas 三表迁移与 QGO/SAO/Outcome 端点（10-2）、web 提升入口与 QGO 页（10-3）、E2E-M2.10 联调（10-4）。
