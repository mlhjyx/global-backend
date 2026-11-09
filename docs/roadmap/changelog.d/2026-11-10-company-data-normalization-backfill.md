---
date: 2026-11-10
title: Backfill country/industry normalization and phone/LinkedIn contact completion
---

- 起因：dev 库 canonical_company 的 country 里 `DE` 与 `德国` 并存（846/72 行），判定链按 ISO 读 country 导致国家门静默失效；industry 2303 行为空、非空行是自由文本；公司级电话仅 1 条（邮箱 280），LinkedIn 公司页只有 11 条——数据脏且稀。
- 改动：
  - 新增 `discovery/company-normalization.ts`：country 变体（中/英/德名、alpha-2/alpha-3）→ ISO alpha-2；NULL country 仅用登记级证据补（GLEIF 注册国、VAT 前缀）；空 industry 用 ISIC 词表（industry-map 同一匹配器）+ TED CPV/FDA 交叉表确定性推断，非空值永不覆盖。
  - `registry/industry-map.ts` 导出 `matchIsicNodesForTerms`（节点级匹配，含命中词），原 `nacePrefixesForIndustryTerms` 行为不变。
  - 新增 `scripts/backfill-company-normalization.mts`（默认 dry-run，`--apply` 落库，幂等，版本/原值条件更新；owner 跨租户连接为预期）。
  - 新增 `discovery/contact-completion.ts` + `scripts/complete-contact-channels.mts`：复用 A1/A4 Impressum 装配器与 BI-14 首页链接解析，抓取（robots 先检）→ phone/form_url 写 company_contact_channel、LinkedIn 公司页写 company_contact_point（只补不删）；邮箱不进本管线。
  - `attributes.industry_normalization` / `attributes.evidence_bundle` 加入 canonical 属性白名单（后者供后续 shadow 证据包使用）。
- 测试：单测覆盖归一函数（变体/未知值不猜/幂等）、industry 推断（词表/CPV/FDA 端口）、联系点装配（电话/LinkedIn/表单/无邮箱）与 sanitizer 白名单；dev 库真跑计数见 `docs/evidence/2026-11-10-multi-source-evidence-graph-slice.md`。
- 未做：不从域名 TLD 猜国家；未接 pipeline 热路径（CLI 回填）；LinkedIn 补全只写公司页 URL，不解析个人主页。
