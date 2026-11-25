---
date: 2026-11-25
pr: 1098
title: Full-source L0-L3 discovery fusion with Brave Search, trade-fair catalog, multi-city Places, channel_catalog, BigQuery inline SA, and RRF
---

- 起因：已有 `BRAVE_SEARCH_API_KEY`、全球 20 个展会目录种子、本地已审渠道库 `source_channel_record`、多城市 Google Places 与容器内 BigQuery 专利凭据尚未全部接通在线发现链路，导致找客召回与共识排序偏弱。
- 改动：注册 `brave.search` 工具（31 工具执行权威清单）并接入 `public_web` / `directory` / `model_web_search` 与多引擎 RRF 共识排序；为 `directory` 补齐 IT/ES/PT/FR/NL/PL/TR 名录意图词并自动注入匹配的全球 20 展会参展商检索；为 `public_web` 增加 Google Places 多城市工业枢纽网格查询；新增零出网 `channel_catalog` 本地已审渠道库适配器（12 发现适配器）及 Raw 校验；支持 `GOOGLE_PATENTS_SA_JSON_B64` / 内联 JSON 鉴权并新增集团同源域名校验工具 `corporate-group-domains.ts`。
- 测试：运行搜索工具、多语言展会名录、RRF 融合、集团域校验、`channel_catalog`、BigQuery 凭据、预算包络、注册表与全量治理测试，以及 `build` / `lint` / `docs:verify` 全部通过。
- 未做：决策委员会编排、Step 0 邮箱格式推断、D3 政策接线与正式 `GET /api/v1/reports/battle-csv` 端点留待紧随其后的 PR 1.4-C。
