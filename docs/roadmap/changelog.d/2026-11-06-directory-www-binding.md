---
date: 2026-11-06
title: Accept directory records mined from www-hosted listing pages
---

- 起因：中文检索修复（#826）发车后真实 run（3875b96e）directory 成功抓到名录页并抽取 41 条公司记录，但全部 `PROVIDER_PAYLOAD_SCHEMA_INVALID` 被拒、run 以 `ExecutionControlError`（stage=query）失败。复现确认：`validProviderBindings` 对 directory 要求 `provenance.sourceUrl` 的 host 与 `attributes.source_directory` 全等，而后者由 `normalizeDomain` 生成（去 `www.`）；凡名录页托管在 www 主机（本轮 cmpe360.com）记录全灭。
- 改动：directory 绑定分支对 host 做同一规范化（小写、去 `www.`）再比较；跨站 sourceUrl 仍被拒绝（伪造来源不会放行）。
- 测试：`provider-raw-boundary.integration.spec` 新增两条——www 名录页记录 ACCEPTED、sourceUrl 指向他站仍 REJECTED。
- 未做：不改其它 provider 的 host 全等比较（wikidata/openstreetmap/ted/openfda 的 host 断言含 `www.` 字面量，行为不变）。
