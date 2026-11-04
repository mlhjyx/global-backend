---
date: 2026-11-04
title: Extend search localization to ms/id/vi/th/ja/ko/pt/tr and report stripped terms
---

- 起因：P2（方案 §2.3）——语言层此前只有 de/en/fr/it/es/nl/pl/zh。产品负责人的马来西亚档案（target_markets={MY}）即使 ICP 目标市场正确，检索仍会回落到 en 并把马来语关键词当外语处理；被剥离的关键词也无留痕，规划器语言错误无从发现。
- 改动：
  - `SearchLanguage` 扩为 16 种：新增 ms/id/vi/th/ja/ko/pt/tr；COUNTRIES 增 MY/ID/VN/TH/JP/KR/PT/TR（各带中文/英文/ISO 别名与本地语言名）；两类角色词补全八语言（如 ms: pemborong/peniaga/pengedar、ja: 販売代理店/卸売業者/ディーラー、tr: distribütör/toptancı/bayi）；planner 语言名表同步。
  - 按语言的检索词脚本规则（P2 §2.3）：zh 保留含汉字的词并剥离纯拉丁词；ja 保留汉字/假名词；ko 保留谚文词；其余语言维持剔除 CJK。新增 `partitionSearchTerms` 返回「可用词 + 被剥离词」，`searchableTerms` 保持旧签名。
  - 执行侧：`public_web` 发现时把被剥离的词记一行日志（截断 5 个），作为规划器关键词语言错误的直接证据。
- 测试：`search-localization.spec` 新增八语言解析 / 角色词 / 脚本过滤与剥离报告用例（zh 语义按方案收紧）；`public-web-search-first.spec` 新增马来西亚马来语经销商串与日本日语串；既有德语/中文回归不变；全量 `@global/api` 单测。
- 未做：规划器关键词语言校验与一次自动重写（P2 第二步，随后单独 PR）；马来西亚/中文市场的端到端验收由发版后按方案 §2.6-2/6 执行。
