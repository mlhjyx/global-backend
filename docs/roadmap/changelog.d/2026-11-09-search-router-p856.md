---
date: 2026-11-09
title: Add the offline search router contract and the wikidata_p856 candidate route; A decision brief
---

- 起因：ch03 §3.14.3 的搜索 provider 抽象（T3-11）与 §3.12.2 的 wikidata_p856 候选路（T3-12 余）是域名解析链路的离线可推进部分；同时把 A（local_query 血缘）收紧成一页决策简报供用户拍板（并入本 PR，不单开 docs PR）。
- 改动：
  - `apps/api/src/registry/domain/search-router.ts`：`SearchRouter.searchAll`（多路并行、单路失败隔离、URL 去重并集、`degradedFrom`、每路延迟预算）与 `searchPreferred`（成本顺序回退、全不可用显式 `allUnavailable`）；`UsageLedgerDraft`（purpose=DISCOVERY_DOMAIN_RESOLVE）成本账本草案；`ProviderHealthTracker` 按 §3.14.3 阈值（连续 20 失败/超 4 天无成功 → warn；7 天 30 失败 → disabled 自动跳过）。真实 HTTP/密钥属在线部分。
  - `domain-resolver.ts`：新增 `wikidata_p856` 路（rank 2）与 `WikidataP856Provider` 契约——按名称找实体、标签相似 ≥0.85 才取 P856（最多查 3 个），与其他路并集排序、失败隔离；`NOT_FOUND` 的 `NO_PROVIDERS` 判定包含 wikidata。
  - 文档：`docs/superpowers/plans/2026-11-09-registry-frame-local-lineage-decision-brief.md`（一页简报：A vs 现状 vs B、影响面/工作量/回滚/风险、推荐与不做的后果）。
- 测试：`search-router.spec`（并行失败隔离与去重并集、延迟预算、串行回退链、全不可用、健康阈值 warn/disabled/healthy、构造校验）；`domain-resolver.spec` 增 wikidata 用例（同域合并进 search 旁证、标签不符/无官网丢弃、provider 失败隔离、`NO_HITS` 口径）；domain 组 4 文件 51 项全绿；build/lint 通过。
- 未做：Brave/Serper/Mojeek 真实适配器与 ToolBroker 注册（在线，需密钥）；搜索重叠估计进记分卡（依赖真实 receipt）；不碰 Copy 文件、无迁移、未发车。
