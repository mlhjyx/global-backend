---
date: 2026-11-09
title: Quick scan runs the G5 domain gate first and queues domainless companies for enrichment
---

- 起因：P3 J08（设计 §4.3.2.6 W9）——「77% match 无域名」的池噪声来自把无官网/死域公司直接送 LLM 判定；G5 门要前置到批量粗判之前，UNKNOWN 的进补数队列而不是烧模型费用。
- 改动：
  - `quickJudgeBatch`（`apps/api/src/temporal/discovery.run2.activities.ts`）在批量判前逐家评估 L0 门链：无域名（`GATE_DOMAIN_MISSING`）或 DEAD 域（`GATE_DOMAIN_DEAD`）→ G5 UNKNOWN，`evaluateGates` 写 `gate_enrichment_task(queued)`，该公司不进 LLM 批量、job 停 `skipped` 并记 `last_error_code`，`company_done` 事件标 `stage=gate_blocked`；`result.gated` 与 `phase_completed` 载荷计数。
  - ICP `companyAttributes.allow_domainless=true` → G5 NOT_APPLICABLE，无域名公司照常判定。
  - `createRun2Activities` 新增可选 `domainStatusFor` 依赖：P2 域名解析流水线的存活校验接入缝（未注入 = 无存活证据、不视为 DEAD）。
  - `docs/backend/sanctions-operator-refresh.md` §7 增补补数队列的运营查询与消费者现状。
- 测试：`discovery.run2.activities.spec.ts` 新增四例——无域名 100% 进补数队列且模型批量输入不含该公司（mock 断言）、DEAD 域同理（注入 `domainStatusFor`）、allow_domainless 放行照判、同一 (company, icp, gate) 重跑不重复建任务；`gate-chain.spec.ts` 覆盖 G5 决策表与 allow_domainless。
- 未做：`gate_enrichment_task` 的消费者——P2 域名解析流水线尚未接线（仓库只有候选生成器 `registry/domain/domain-resolver.ts`，无队列消费者、无域名存活状态生产者）；本卡只负责生产任务 + 状态查询，消费者与补数后重评留待 P2 后续波次。深判路径的 G5 UNKNOWN 不拦截（设计 UNKNOWN 不短路），只在快扫前置。
