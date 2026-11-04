---
date: 2026-11-04
title: Validate planner keyword language against the market and rewrite once before failing
---

- 起因：P2 第一步把语言层扩到 16 种，但规划器（LLM）仍可能把中文关键词写进马来语/德语查询——这类计划执行时检索必然全空，用户只看到「没结果」，看不出是语言问题。
- 改动：`generateQueryPlan` 落库前做确定性关键词语言校验：逐条查询按 `filters.country`（回落 ICP 目标市场）确定语言，关键词存在却**全部**不能用于该语言检索时触发**一次**自动重写（提示词明确要求全部 keywords 用目标市场语言书写、不得出现中文）；重写后仍不符则抛 409 `DISCOVERY_KEYWORDS_LANGUAGE_MISMATCH`，提示调整目标市场或关键词后重试。命中合规的计划只调用一次规划器（零额外成本）。
- 测试：`icp.service.spec` 新增 3 用例——语言不符触发一次重写并以重写结果落库（重写提示词含「马来语」）、重写仍不符显性失败且不落库、关键词本已合规时只调用一次规划器；全量 `@global/api` 单测。
- 未做：不做逐条关键词的自动翻译（重写交给规划器）；中文/马来端到端验收随发版按方案 §2.6-2/6 执行。
