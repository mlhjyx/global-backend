---
date: 2026-11-10
title: Deterministic source coverage fill for query plans and Wikidata subclass closure
---

- 起因：2026-11-10 真实 run 实测两个缺陷——①查询规划器漏排可用源：14 条查询只覆盖 5 个源，`model_web_search`（模型联网搜索）一条查询都没排到；提示词只有「结构化源优先、public_web 兜底」的口头引导，没有任何强制覆盖校验。②Wikidata 发现源只按 `P452` 精确行业标签匹配，公司行业常登记为目标行业的子类，命中很稀。
- 改动：
  - `icp.service.generateQueryPlan` 在 TED/FDA 冷路径注入之后、存库之前新增确定性后处理 `withSourceCoverage`（`apps/api/src/discovery/plan-query-sources.ts`）：对「已启用 + 声明公司血缘 + 在 `PLANNER_SOURCE_GUIDE` 可规划集合内」却未出现在任何查询 `filters.source_hint` 的源，按 ICP 主画像（首个目标国 + 行业词）合成一条兜底查询（`keywords: []`、`priority` 末位、rationale「覆盖补齐」），并遵守 `MAX_DISCOVERY_PLAN_QUERIES` 封口。
  - 排除项：TED/openFDA（冷路径注入负责）、`trade_fair`（无匹配展会时勿盲补，2026-11-02 全空查询教训）、`registry_frame`（仅当首个目标国已有 PARSED 快照的注册库装载时补，装载状态未知时补并在 rationale 标注「注册库未装载」warning）。
  - `adapters/wikidata.ts` 行业匹配改为两段式：先跑现有 `P452` 精确匹配（快路径），零命中时回退 `?industry wdt:P279* ?root` 子类闭包查询一次，提升 Wikidata 命中率。
- 测试：`plan-query-sources.spec.ts` 新增 9 个覆盖补齐用例（缺源补查询、已覆盖不重复、trade_fair/ted/openfda 不盲补、registry_frame 装载/未装载/未知/无 ISO2 四分支、无国家行业时省略过滤、首目标国取值、封口与满额不动）；`adapters/wikidata.spec.ts` 新增 2 个 SPARQL 形态断言（精确快路径命中时零闭包调用；零命中时闭包查询含 `P279*` 且保留国家/官网约束）；`icp.service.spec.ts` 更新两处受影响断言并新增装载态接线用例。
- 未做：Wikidata 闭包扩展（P279）结果未加去重排序之外的处理；registry_frame 的覆盖面仍按首个目标国判定，多市场 ICP 不逐国补；查询计划 UI 无「覆盖补齐」专属呈现（依赖既有 rationale 展示）。
