---
date: 2026-11-02
title: Stop the planner from writing trade_fair queries no registered fair can serve
---

- 起因：`trade_fair` provider 只能跑注册表（`TRADE_FAIRS`）里已登记的展会——目前只有 EuroBLECH 2026（钣金/金属加工），`selectFairs()` 用 ICP 行业词/关键词匹配模板 topics，无命中就静默返回零记录。生命科学类 ICP 的 trade_fair 查询因此必然空跑：run `3212f6f3` 的 8 条此类查询全部零结果、无报错、无成本（`3ad22469` 的方案里也有 3 条）。
- 改动：`plan-query-sources.ts` 新增 `icpMatchesRegisteredFairs()`（与 provider 同一 `selectFairs()` 判定）与 `plannerVisibleSources()`；`generateQueryPlan` 用它们从「可用数据源」提示词中剔除无展会可跑的 trade_fair（`hasPlannableSource` 与 `plannerSourcePrompt` 改用 planner 可见列表）。路由校验仍用完整 `enabledSources`：模型若仍写 trade_fair 查询，不会按 SOURCE_DISABLED 移出（它会照常执行、只是空跑），也不改变已有计划的语义。
- 测试：`plan-query-sources.spec.ts` 新增 4 例（命中/不命中/可见性过滤/单独 trade_fair 不可规划）；`icp.service.spec.ts` 新增 3 例（金属 ICP 提示词含 trade_fair、生命科学 ICP 不含、trade_fair 为唯一启用源且无展会时 409 不花钱）。两文件 120 例全绿。
- 未做：不扩展会注册表（内容+ToS 工作量另议）；不改 provider 的空结果口径；不改 backlog/评分路径。
