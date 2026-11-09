---
date: 2026-11-09
title: P3 J17 — 人工复核队列 API、优先级/SLA 与结论回流
---

- 起因：ch04 §4.3.8 —— UNKNOWN/borderline 只能靠人判，但没有队列就没有 SLO、没有回流、没有 overturn 度量；J04 已建好 `judgment_review_task`/`judgment_golden_label` 两张表，本卡把队列跑起来。
- 改动：
  - `apps/api/src/discovery/judgment/review-queue.ts`：优先级公式（UNKNOWN/CONFORMAL_ABSTAIN 高价值=P0，其余 UNKNOWN/BORDERLINE=P1，RANDOM_AUDIT=P2，DRIFT_AUDIT/APPEAL=P3）与 SLA（24h/72h/120h/168h）；`enqueueReviewTask`（同 record+reason 幂等）；`listReviewTasks`（priority/dueAt/id 升序、keyset 游标、含公司名与判定）；`claimReviewTask`（queued→in_review，同人幂等）；`resolveReviewTask`（单事务：状态校验 → 写新 `judgment_record`（`model_requested='human'`、`prompt_hash=sha256('human-judgment/v1')`、attempt+1、criteria 支持人工覆写）→ 回流 `judgment_golden_label`（split=candidate、 annotatorHash 只存稳定哈希）→ 任务 resolved）；`judgmentReviewStats`（状态/原因/优先级分布 + overturn rate）。
  - `judgment-review.controller.ts`：`GET /api/v1/judgment-reviews`、`POST :id/claim`、`POST :id/resolve`（acquisition:review）、`GET /api/v1/judgments/:id`（acquisition:read）、`GET /api/v1/judgments/stats`；typed 错误映射 404/409/400。
  - `packages/db/test/judgment-review-queue.rls.spec.mjs` + ci-manifest service 组：真库生命周期（enqueue→list→claim→resolve→stats、同人认领幂等、重复 resolve 拒绝、跨租户不可见）。
- 测试：`review-queue.spec.ts` 6 例纯函数单测；库上 spec 由 service 组在 CI 执行；OpenAPI 已重导出。
- 未做：`upsertLeadFit` Lead 投影（留给 J06 与 record 写入一起接，避免两处映射）、P0 24h SLA 报表（ops 报表，J16/J20 一并做）、BFF/gain-saas 运营台页面。
