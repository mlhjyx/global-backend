---
date: 2026-11-21
pr:
title: Preserve proof validity and company contact navigation in delivery
---

- 起因：厂家证明的明确到期未进入交付期限；普通 HTTP 正文提取又丢失实际公司导航链接，使旧空观察持续复用。
- 改动：当前最新厂家字段经同租户/主体的只读 proof 表与既有 codec 核对后限制 GET、accept delivery/快照和周报期限；过期不续鲜，无厂家保持旧语义。同响应导航由固定工具 producer 复用原五类严格 URL/归属规则、静态标签和歧义判定，在 Readability 前观察并放入最终消费窗口，未新增出网。内部导航 cache recipe 与 legacy 键隔离，旧无回调与两条 MFR exact 路径保持；company_contact/v2 沿原版本条件正常补采，不改 TTL/准入/评分/个人 basis。
- 测试：TTL 先复现一天被扩为半年后的 RED，399 项相关测试含 3 项真实 PG 通过；导航与社会链接负观察先 RED 后 GREEN，253 项相关 HTTP/工具/安全/MFR/持久 reader 回归、15 项定向 contact 活动及 11 项真实 PG writer/backfill 通过。覆盖旧/新 304、base/redirect、不可注入 producer、合法 URI 上限/重复/个人路径拒绝、v1→v2 补采与当前空缓存、正常抑制/RLS/UNVERIFIED。
- 未做：未触业务/生产 DB 或来源配置，未增加公开 API/字段/迁移/收费 finder，未发起真实 Provider/模型调用、业务运行或部署；未来 main 整合及其额外迁移/制品采用另行验证。
