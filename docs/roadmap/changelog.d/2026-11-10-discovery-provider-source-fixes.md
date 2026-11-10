---
date: 2026-11-10
title: 修复验证 run 的三处源失败：public_web 空检索串、web_search 确认截断、TED/openFDA 投影拒绝
---

- 起因：2026-11-10 的验证 run 97a4fa1b 以 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH` 整体失败，TED / model_web_search / public_web 三源零产出。逐层定位：
  - 覆盖补齐把 ICP 原始主画像（市场词「意大利（IT）」、中文行业词「太阳能光伏」）抄进 public_web 查询：`targetCountries` 不剥「（IT）」尾注 → 国家识别落空、语言回退 en → 中文词被检索语言过滤整体剥离 → `searches.length===0` → provider 抛 `ApplicationFailure.nonRetryable(DISCOVERY_MARKET_UNSUPPORTED)` → 治理血缘计划构建器把「provider reject」判成血缘失配，整轮 run 失败；
  - `discovery.web_search_candidates` 结构确认在 8_192 输出预算下被 deepseek-flash 推理吃满（finish=length、content 为空）→ `STRUCTURED_OUTPUT_EMPTY_TRUNCATED` → 确认环节整段作废、0 条记录；
  - ted.provider 请求 `maxRecords=max(limit,50)`（去帽后 250），超过持久投影 `ted-search/v1` 的 awards 上限 32（另受 120 KiB 聚合门约束）→ `TOOL_DURABLE_RESULT_PROJECTION_REJECTED`，TED 恒 0 条；openFDA 同型（请求 250 vs establishments 上限 50，本 ICP 未触发）。
- 改动：
  - `apps/api/src/discovery/search-localization.ts`：新增 `stripMarketQualifier`，`targetCountries` 逐词剥掉「（IT）」类尾注后再匹配国家与语言；`searchLanguagesForMarkets` 复用同一剥离。
  - `apps/api/src/discovery/plan-query-sources.ts`：覆盖补齐的 firstTarget 先剥尾注（registry_frame ISO2 解析随之恢复）；补齐查询借用本轮已规划查询里市场语言可用的关键词（≤3、去重），不再只带 ICP 原词——中文行业词交给只认市场语言的源（public_web）只会得到空检索串。
  - `apps/api/src/discovery/providers/public-web.provider.ts`：空检索串改为 fail-safe 空结果 + 有效空血缘（与 ted / model_web_search 同约定，AGENTS.md §5 单源失败不阻断其余源），`DISCOVERY_MARKET_UNSUPPORTED` 错误码留在日志。
  - `apps/api/src/discovery/providers/ted.provider.ts`、`openfda.provider.ts`：请求量钳进持久投影契约（TED awards ≤32、openFDA establishments ≤50）。
  - `apps/api/src/ai-tasks/task-registry.ts`：`discovery.web_search_candidates` 输出预算 8_192 → 16_000（与 icp.design / discovery.query_plan 同档）。
- 测试：plan-query-sources / search-localization / public-web-search-first / task-registry / ted / openfda / source-result-projections 7 个 spec 264 项通过；gctl check 全绿（含零容器单测）。
- 未做：上调持久投影契约（TED/openFDA 每查询更多记录）属平台级改动（120 KiB 聚合门与 schema 上限要一起动），另行评审；signal-query 的 TED/openFDA 默认 maxRecords（100/200）超出同一契约，signal 恢复启用前需先对齐。
