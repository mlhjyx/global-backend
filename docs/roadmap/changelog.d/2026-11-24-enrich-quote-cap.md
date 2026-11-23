---
date: 2026-11-24
title: 联系补强报价按 finder 与 verifier 保守计价
---

- 起因：contact.enrich 的 quote envelope 只返回表示最小值 1 µUSD，付费 finder/验真适配器直连供应商却未计价，真实 Grant 的 CapBudget 无法支付 Hunter 等调用。
- 改动：quote body 与 request scope 绑定 contactCount/maxProviders/maxProbe；envelope 按已配置 finder/verifier 的最坏单次价格向上取整到 policy cents，finder 受每公司 10 次帽、verifier 受每地址 maxProbe 约束；未配置 provider 不计价，边界越界 fail-closed；execute 侧 safety service 把同一组边界送入 scope。无迁移、无 app_user 权限变更。g16 基线登记新边 execution-budget -> enrichment（计价需读 provider 配置解析器与上限常量）。
- 测试：envelope/scope/quote controller/OAS/quote service/safety service 定向 vitest 93/93；@global/api build 与 lint 通过；OpenAPI 由 code-first 重新导出。
- 未做：未真实调用供应商或付费；provider 的 DB kill switch 尚未传入纯 envelope，配置了 key 但 DB DISABLED 的 provider 会被保守计价；全量测试交 CI。
