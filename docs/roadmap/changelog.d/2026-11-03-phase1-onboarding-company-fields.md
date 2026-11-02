---
date: 2026-11-03
title: Persist onboarding seller facts on CompanyProfile and let companies be created without a website
---

- 起因：Phase 1（D16/D17）要求注册引导的公司/产品/目标市场/业务邮箱成为卖家事实 SoR；此前 `POST /companies` 必须带官网，products/targetMarkets/businessEmail 只留在 site-builder intake 的 JSON 里，ICP 与理解都消费不到。
- 改动：
  - `company_profile` 新增 `target_markets TEXT[]`、`business_email TEXT`（迁移 `20261102170000_phase1_seller_sourcing_fields`）；`offering` 新增 `source`（onboarding | understanding | manual）。
  - `POST /companies`：`website` 变可选（`website` 与 `name` 至少一个，否则 400）；新增可选 `industry/targetMarkets/products/businessEmail`；`products` 落 `Offering(source=onboarding, skipDuplicates)`；有官网才消费 Grant 并发 `CompanyProfileCreated`，无官网返回 `understanding=not_started`（不发事件、不消费 Grant）。
  - 技术报价 op `POST /companies` 请求变体与 request scope 同步扩展（exactKeys 白名单、ISO 码/数量上限校验）。
  - `CompanyDto` 增补 `targetMarkets`、`businessEmail`、`understanding`（后两者可选，避免响应侧破坏性变更）。
- 测试：company.service 新增「无官网建档不发事件不消费 Grant」「有官网照常」「产品落 Offering」「双缺 400」四例；`workspace-authority-atomicity` 回放断言同步 `understanding`；OpenAPI 已重导出。
- 未做：理解工作流本体不改为双源（资料库 Phase 2/3 接入）；`business_email` 的 PII 分类与加密方案待法务确认（PRD SD11 备注）。
