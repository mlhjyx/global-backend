---
date: 2026-11-05
title: Materialize channel crawl records (companies + contacts) into a platform record pool
---

- 起因：P4-P4c 交付时抓取记录只在内存里计数（`recordsFound`），活动返回即丢弃——没有物化就没有可投影/可使用的源，运营台也看不到抓到的公司。
- 改动：新增平台级 `source_channel_record`（无 RLS）：公司级字段（name/website/country/industry/products/keywords）+ 联系人字段（contactName/contactTitle/email/phone），按 `(channel_id, dedupe_key)` 跨轮 upsert（`companyIdentity` 的 `d:`/`n:` 键）、`first_seen_at`/`last_seen_at`/`content_hash` 记录观测与变更。物化在 run 活动内部完成（记录不进 Temporal 历史），物化失败抛 nonRetryable `CHANNEL_MATERIALIZATION_FAILED`（不重试、不计入页面失败率）；`recordsMaterialized` 从恒 0 变真实计数并贯通 finalize→`source_channel_run`。`source_channel_run` 新增 `crawl_run_id` 唯一列（finalize 幂等）。爬虫字段白名单扩展联系人四字段，**仅详情页模式可配**（`detail.enabled` + `list.itemUrlSelector`，否则 400）——堵住列表页回退时字段选择器整页匹配、同一值复制给整页条目的缺陷。新增 `GET /source-channels/:id/records`（ops:read）供选择器校验与联系使用。
- 合规：联系人字段按 **OWNER-DECISION-2026-11-05** 明文存储，列级加密、Q25 访问审计、保留期与 Art.17 擦除面延后到后续任务（防线保留：字段不进日志/事件历史、仅 ops 可见、白名单封闭）。迁移注释与 schema 均标注 `PII_PENDING_ENCRYPTION`。
- 测试：见 PR（配置防线、爬虫详情页/列表页双守卫、记录键与折叠、活动物化成功/失败、权限契约、迁移静态契约、disposable 库 upsert 幂等）。
- 未做：租户投影（公司池/Lead 物化与抑制/制裁门）；联系人字段的加密/审计/保留期/擦除（延后任务）；页面正文持久化（沿用 crawl4ai durable artifact 24h TTL）。
