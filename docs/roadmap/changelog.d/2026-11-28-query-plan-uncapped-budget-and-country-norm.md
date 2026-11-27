---
date: 2026-11-28
pr:
title: 修复去帽模式每源查询预算被除以 1000 算成 1 条导致多国被裁、补充按国轮询保底与 ISO2 国家码规范化
---

- 起因：现网同时开启 `DISCOVERY_UNCAPPED=on`（`MAX_DISCOVERY_PROVIDER_RECORDS=1000`、`trialMaxRuns=1000000`）与旧静态公司帽（`400`/`50`）时，`sourceQueryBudgets` 用 `floor(cap / 1000)` 换算，把所有数据源的每轮查询预算错误压到 1 条，导致 10 国买家画像生成的 24 组查询被砍掉 16 组只剩德国和英国；且模型写的英文国家全称与补齐查询的 ISO2 码混排。
- 改动：`plan-query-sources.ts` 改用 25 家/查询的名义口径换算公司帽，零成本本地源（`registry_frame`/`channel_catalog`）免受试跑帽缩水，去帽多国场景按目标国家数保底；`routePlannerQueries` 触发单源裁剪时改为按国家轮询保底；新增 `normalizePlanQueryCountries` 并在 `icp.service.ts` 规划入库前统一规范化 `filters.country` 为两位 ISO 码，同时提示多国分散规划。
- 测试：`plan-query-sources.spec.ts`、`icp.service.spec.ts`、`pnpm --filter @global/api build` 及全量治理快门通过。
- 未做：不改动旧历史已入库的 `discovery_query_plan` 行（由前端地区名兼容映射兜底展示），后续新建或重新生成的寻源方案生效。
