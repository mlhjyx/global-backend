---
date: 2026-11-28
pr:
title: "修复 L2 决策人邮箱验真双正漏斗、领英 URL 透传、熔断器内存兜底与 Prospeo 并发节流"
---

- 起因：现网寻源 `601983b1` 产出 294 位联系人但 `contact_point` 中 `VALID` 邮箱为 `0` 条——1）Prospeo（`only_verified_email: true`）命中并已 SMTP 核验后，Emailable 再次独立返回 `valid (score=100, not_catch_all)`，但编排层未传递独立 finder 票，导致强行继续调用已欠费/失效的 ZeroBounce 并把 12 条 `VALID` 邮箱全部打回 `UNKNOWN`；2）`enrich-company-contacts` 未把联系人已有的领英 `/in/` URL 传给 Prospeo，大幅压低命中率；3）`PrismaCircuitBreakerStore` 在只读 `app_user` 下更新 `data_provider` 静默失败且按公司重建，导致 Hunter 连续 65 次 `429` 从未熔断、Prospeo 跨公司并发无节流撞出 15 次 `429`。
- 改动：1）在 `enrich-contact-email.ts` 中仅对 Prospeo `email_status=VERIFIED` 或 Hunter `verification_status=valid && acceptAll=false` 的商业命中传入 1 张独立 `priorVotes`，并在 `verification-waterfall.ts` 主验完成后若已满足双正规则直接收敛 `VALID`（`Step 0` 推导与非核验命中仍严格要求双验证器，`accept_all` 与 `INVALID` 优先级不变）；2）在 `loadCompanyEnrichmentMeta` 中读取联系人既有领英 `/in/` URL 并透传给 `enrichContactEmail`；3）为 `PrismaCircuitBreakerStore` 增加进程内内存镜像合并，并在 `contact-enrichment-bypass-executor.ts` 中跨公司复用 finder/circuit 实例且默认启用 `PROSPEO_MIN_INTERVAL_MS=600`。
- 测试：补充 `verification-waterfall.spec.ts`、`circuit-breaker.spec.ts` 单测，并跑通 `enrichment` 全套单测、`@global/api` 构建、ESLint 与仓库推送前治理快门。
- 未做：ZeroBounce 欠费与 Hunter 额度耗尽需由账号侧充值或停用，且未修改数据库表结构；上线后将在现网实测新一轮寻源 `VALID` 邮箱转化率。
