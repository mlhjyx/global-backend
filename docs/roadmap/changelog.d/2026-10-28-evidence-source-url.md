---
date: 2026-10-28
title: Keep the evidence source URL and let a refetch extend a field's freshness
---

- 起因：交付闭环设计 §8（L1 余项）——富集写入时 `provenance.sourceUrl` 已在手却被丢掉，物化证据也丢掉了 `raw_source_record` 的来源 URL；有效期按「每分级最早抓取」计算，重抓不会延长，与「证据是最新的」相矛盾。
- 改动：迁移 `20261028120000_field_evidence_source_url` 给 `field_evidence` 加可空 `source_url`（https、≤2048 的 CHECK，不回填）；富集提交把 provenance URL 与原始抓取时间写到每条证据行；物化证据联 `raw_source_record` 补 URL 并把 `fetched_at` 改用原始记录的抓取时间；读模型（`LeadPackage`/`LeadQualified` 证据链接）优先用行上的 `source_url`，历史行回退 raw 联表；`valid_until` 改为**每个字段取最新抓取、字段之间取最早失效**（decide / package / 周报三处同口径）。
- 测试：迁移静态契约、`fieldEvidenceProvenance` 单元（https/长度/空值）、富集提交写 URL 与拒收非 https、包读模型 URL 优先级与每字段有效期、decide 快照的「同字段重抓延长 / 不同字段取最早」、周报 `_max` 聚合；全量零容器单测与 `gctl check --fast`。
- 未做：历史证据行不回填（设计如此，读时回退 raw 联表）；线索级成本分摊与开发信草稿（L5）另行安排。
