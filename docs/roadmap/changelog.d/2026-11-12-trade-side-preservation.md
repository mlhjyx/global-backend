---
date: 2026-11-12
title: Preserve ICP trade role in coverage-fill and model web-search queries
---

- 起因：覆盖补齐查询与模型联网搜索提示词丢失 ICP 的 `trade_side`，只在主查询里带角色，补查与联网搜索可能挖出「同国家、错角色」的公司。
- 改动：
  - `coverageFillQuery` 从 ICP 属性取 `icpTradeRole`，写入补齐查询的 `filters.trade_side`。
  - 模型联网搜索提示词的 ICP 必带字段加入 `trade_side`。
- 测试：`plan-query-sources.spec.ts` 与 `model-web-search.provider.spec.ts` 共 90 tests passed；全量 13243 passed；build 与 lint 通过。
- 未做：不改数据源实现与评分逻辑。
