---
date: 2026-11-08
title: Onboarding-derived claim drafts to unblock NO_APPROVED_CLAIMS
---

- 起因：新用户/新空间的注册引导只落 CompanyProfile + Offering，不产生 Claim；无官网或理解失败时永远没有可审批事实，ICP 生成被 `NO_APPROVED_CLAIMS` 卡死（P5 断点）。
- 改动：
  - `POST /companies` 建档同事务新增档案事实草稿：主营产品 → `capability`、行业 → `company_fact`、目标市场 → `market`，状态 `NEEDS_REVIEW`，证据记「注册引导填写」；不带 `originKey/factKey`，可直接走既有审批（不需要 Site bridge）。
  - 新端点 `POST /api/v1/companies/{companyId}/claim-drafts`（`acquisition:review`，不消费 Grant）：为存量空间/理解失败空间补齐草稿；按归一化语句幂等去重，`REVOKED` 不复活；company 行 `FOR UPDATE` 串行化。
  - 设计文档 `docs/superpowers/plans/2026-11-08-p5-user-loop.md`（P5 三项，本 PR 只含引擎侧 Claim 草稿）。
- 测试：新增 `profile-claim-drafts.spec.ts`（映射/去重/REVOKED/知识来源/空规格）与 `claim.synthesize-drafts.spec.ts`（404/生成/幂等）；`company.service.spec.ts` 增建档派生断言。
- 未做：SaaS 侧通知派生与错误文案表在 gain-saas 仓单独 PR；不从卖家资料库文档抽事实（Phase 3 冻结）；不改 ICP 硬门（产品负责人 2026-11-08 按推荐批准）。
