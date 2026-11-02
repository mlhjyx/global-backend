---
date: 2026-11-03
title: Drop same-name namesakes and organisation-shaped person names in contact discovery
---

- 起因：M5 Golden Set 首轮（`docs/evidence/2026-11-03-contact-golden-set-m5.md`）误报 19.6%，集中在两类可定位机制：①社媒层把「公司名恰为姓氏」的异国同名个人当成员工（3 人）；②LinkedIn 机构页整条被当成个人入库（1 条「公司当人」）。
- 改动：
  - **同姓守卫**（`social-presence` 的 L3 标题筛选）：解析出人名后，标题去掉人名必须仍有独立的公司佐证（公司名 token 或域名词根）；公司 token 只与人名重合时丢弃。
  - **机构名守卫** `cleanPersonName` / `looksLikeOrganizationName`（`contact-extraction`，覆盖 `contact.find_decision_makers` 全部抽取消费方 + 社媒标题）：先剥离括号注记（模型常写 `Max Mustermann (Geschäftsführer)`，剥离后是真人名则保留），剩余部分带法律形式/机构词才丢弃；词表含 group/holding/company/sa/bv 等，`Co`（真实姓氏）与 `ag` 不误伤——只有全大写 `AG` 与带点 `Co.` 按公司形式处理。社媒丢弃原因计入 run diagnostics（`social_namesake_dropped` / `social_organisation_dropped`），不再是静默损失。
- 测试：社媒 provider spec 新增「同姓保留/拒绝」与机构名识别用例；相关 provider、回执消费者与联系人 stage 全组通过；全量单测见 PR。
- 部署：无迁移；随下一班车上线。
- 未做：同名异国公司（如德国泵店与美/英同名工程公司）靠字符串佐证无法区分，本轮该类 6 个误报仍在；需公司级消歧（国家/行业/雇主字段证据），记为后续。同姓守卫的代价：以家族姓氏命名的公司（如 `Pumpen Schmid GmbH`）里，若员工 LinkedIn 标题只写人名不带公司段，该候选会在 L3 被丢弃（此前会靠姓氏子串误放行、再靠档案页确证）——属「宁缺勿错」取舍，丢弃已计入 diagnostics。已入库的机构名旧行（M5 那轮的 BTS 条目）不在本 PR 清理范围内。
