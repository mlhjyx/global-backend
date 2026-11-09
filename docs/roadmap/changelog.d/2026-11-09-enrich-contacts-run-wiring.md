---
date: 2026-11-09
title: Run-pipeline enrichment activity with versioned workflow gate (P1-10b)
---

- 起因：P1-10（拆 a/b）——b 把富集接进 run2 深挖流水线：contacts 阶段之后，仅对 fit=match 公司补邮箱（计划 §2.3.4.7）。
- 改动：
  - `discovery.run2.pipeline.activities.ts` 新 activity `enrichContactsForCompany`（withClassifiedFailure 包装）：数据面守卫——无已配置凭据 / data_provider 全 DISABLED / 无 lawful basis 配置（decision_maker.config，与联系人发现同一配置面）时直接跳过，kill switch 期间**不触碰联系人、不写 attempt 账**；通过守卫后预算 = min(run 预算剩余, $0.50/公司)，软截止 10 分钟，runId/run 账户透传公司级核心（P1-10a）。
  - `discovery.run2.pipeline.workflow.ts`：contacts 之后新增版本化步骤 `patched('company-contact-enrichment-v1')` + `fit.verdict === 'match'` + `enrichmentSlot < MAX_RUN_ENRICH_COMPANIES(25)`；富集失败 `.catch` 吞掉——可选增强不把已完成的联系人发现打成 failed（失败仍留在活动历史与 Temporal UI）。
  - `discovery.workflow.ts`：父工作流把深挖批次序号（cursor index）作为 `enrichmentSlot` 传给子工作流（旧历史无此字段，patched() 闸挡住）。
  - `discovery/execution-envelope.ts`：新增 `ENRICH_COMPANY_BUDGET_CAP_MICROUSD=500_000`（调用计数上限之外的第二道钱闸）。
- 测试：activity 4 场景（无凭据/全 DISABLED/无 lawful basis 三跳过 + 通过守卫时 run 账户/basis/软截止/预算 min(剩余,$0.50) 断言，核心以 mock 切面）；子工作流 4 场景（match 触发、mismatch 不触发、slot≥25 与 patched=false 不触发、富集吞错仍 done）；temporal 全套 1440 通过（含 workflow replay 套件）。
- 未做：供应商真实 key / scorecard（用户决策）；报价策略表计价（gain-saas lane 协调）。
