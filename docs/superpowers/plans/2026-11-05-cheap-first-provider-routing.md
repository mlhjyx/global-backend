# Q33② cheap-first 数据源路由 · 落地设计文档（2026-11-05）

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-11-05 批准开工（会话「批准开工」，决策点 D-a~D-e 按推荐值）；依据 Q33 决策（结构化源优先、public_web 兜底；结构化源每轮各 ≤100 家、public_web 补到 500；新源前 10 次运行限额试跑）、PRD v3.0 §7.4/第 9 部分、2026-11-05 联网研究（见 §7）。
> 任务启动门（计划 §0.6）：本文件已过门 ① 设计文档 ② 闭环设计 ③ 联网研究 → 产品负责人已过目批准 → 进入 TDD（PR-1 规划层 → PR-2 执行层）。

## 1. 背景与目标

寻源 run 的公司来源混合：结构化开放源（wikidata/openstreetmap/directory/trade_fair/ted/openfda）与 public_web（SearXNG + LLM 抽取 + 抓取）。现状 planner 把「选哪些源」交给模型自由发挥，public_web 容易承担过多查询，成本与时长都花在最贵的路径上。

目标（Q33②）：**结构化源优先、public_web 兜底**；结构化源每轮各 ≤100 家公司；public_web 把总池补到 500；新源前 10 次运行限额试跑。

验收（DoD）：
1. 结构化源占比 > 0（归因漏斗）；
2. public_web 查询数下降（同 ICP、同规模前后对比）；
3. 同集合召回不降（golden mini-run 3–5 家 + 影子对比）；
4. 无预算/合规回归（cost_cents 不升、制裁/抑制门不变）。

## 2. 现状与触点（已核对，2026-11-05）

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| Planner 提示 | `apps/api/src/icp/icp.service.ts:656`（构建）、`discovery/plan-query-sources.ts:49`（PLANNER_SOURCE_GUIDE）、`:175`（plannerSourcePrompt） | 列出可用源与用法，无优先级/配额指令；`public_web` 排在第一行 |
| 路由扇出与裁剪 | `plan-query-sources.ts:307`（routePlannerQueries） | 每条查询按 `source_class` 扇出到该类的全部可运行源；超 `MAX_QUERY_PLANNER_QUERIES=64` 时按 query priority 裁剪（无源优先级 tiebreak） |
| 冷路径 | `plan-query-sources.ts:46`（SYSTEM_PLANNED_SOURCE_KEYS） | ted/openfda 由系统按 ICP 确定性生成，模型不写 |
| 查询执行 | `temporal/discovery.activities.ts:1002`（routeCompanyDiscovery）、`:1007`（narrowBySourceHints → adapters） | 执行时按 source_hint 解析适配器；无 per-run 配额检查 |
| 回执与统计 | `discovery.activities.ts`（executeQuery 回执） | 回执按 `source_class` 聚合（providers 仅名字列表），无 per-provider 公司计数 |
| run 结构 | `temporal/discovery.workflow.ts:344`（池不足 20 才搜索兜底）、`discovery/run2/quick-scan.ts:14`（QUICK_SCAN_POOL_LIMIT=500） | Run 2.0 优先消费公司池，池候选 <20 才走搜索；池上限 500 |
| 源上限 | `discovery/execution-envelope.ts` | 每查询每源 ≤25 条记录；计划查询 ≤66；无 per-run per-source 公司帽 |
| 源启停 | `data_provider.status`（seed 见 `provider.registry.ts:181+`） | seed 默认：public_web/wikidata/openstreetmap/gleif/directory/trade_fair/ted/openfda/digital_footprint/structured_harvest ENABLED；website_profile/company_contact DISABLED；以运行库为准 |
| 归因漏斗 | gain-saas `apps/server/src/ops/ops.service.ts:595`（providerAttribution） | 按 provider 统计 raw_records/companies/in_pipeline/quick/deep_positive/recommended + cost_cents；无「查询数」列 |
| 物化归因表 | `discovery_query_operation_attempt` / `discovery_query_attempt_item` / `discovery_company_materialization_outcome`（Prisma schema） | 每 run/query/provider/record 可数；per-run per-provider 公司数可派生 |

## 3. 承重假设（可证伪）

1. 对目标 ICP，结构化源能产出「可用公司」的一个非零子集，且其单位成本（抓取/LLM）显著低于 public_web；若不成立（结构化源产出率过低），public_web 兜底 + 上限放开规则保证召回不变，验收 3 先红。
2. public_web 的「贵」主要不在 API 调用（costPerCallCents=0），而在抓取与 LLM 抽取；因此「cheap-first」以**减少 public_web 查询数/抓取量**为杠杆，而非单价差。
3. per-run 公司帽可以在**执行前**用已物化计数判断（同一 run 内单调增长），不需要跨 run 状态。

## 4. 设计（三层机制 + 观测；全部 env 可调、可一键回退）

### 4.1 L1 Planner 指南（提示层，纯建议）

- `PLANNER_SOURCE_GUIDE` 重排并加一行优先级说明：**wikidata/openstreetmap（零爬取公司库）→ directory/trade_fair（列表页）→ ted/openfda（系统按 ICP 码生成）→ public_web（仅兜底：结构化源覆盖不到的行业/地区/角色）**。
- 在 `plannerSourcePrompt` 追加配额说明：结构化源「每轮各约 ≤100 家公司」、总池目标 500；public_web 查询建议不超过 `ceil(未覆盖细分 × 2)`（措辞，非硬约束）；提醒模型 `source_hint` 必须取表中同一行。
- 不改模型输出 schema；`SYSTEM_PLANNED_SOURCE_KEYS` 不变。

### 4.2 L2 确定性裁剪顺序（规划层，可回退）

- `routePlannerQueries` 的 `PLAN_QUERY_CAP` 裁剪排序从「query priority」改为「query priority → **源优先级**（结构化源先保留，public_web 副本最后保留）→ 原序号」，**不改变扇出语义**（召回不降；只是超帽时先丢 public_web 副本）。
- 新增 `SOURCE_ROUTE_PRIORITY: Record<providerKey, number>`（public_web=90；结构化源 10–40；未列出的缺省 50），单测锁顺序。
- 可选开关：`DISCOVERY_CHEAP_FIRST_PLAN=enforce|off`（off 恢复旧排序）。

### 4.3 L3 运行时配额（执行层，硬约束）

- 执行点：`discovery.activities.ts` 的 `executeQuery`——在 `narrowBySourceHints` 得到 adapters 后、调用适配器前：
  - 对每个 adapter 查**本轮已物化公司数**：`count(DISTINCT 公司) FROM discovery_company_materialization_outcome WHERE workspace_id AND run_id AND provider_key = X`（含本查询前已完成的查询；同 run 内一次性读取，按 provider 缓存于本次活动内，最多 7 个源）。
  - 结构化源达到 `cap`（默认 100，env `DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`）→ 跳过该 adapter：**不调用 provider**，该查询照常落零回执（物化准入要求每查询有回执），跳过原因计入 run stats `perSource.capSkipped`，并在 run_event 记一条注记。
  - public_web 不设 per-source cap（兜底），但受**run 总池上限 500**（沿用 `QUICK_SCAN_POOL_LIMIT`；若物化总量 ≥500，则跳过所有新查询的公司物化，run 记 `POOL_CAP_REACHED`）——实现时按现有物化/池路径确认落点。
- 试跑限额（新源）：`data_provider.config` JSON（无迁移）读取 `{"trial":{"maxRuns":10,"maxCompaniesPerRun":20}}`；运行时统计该 provider 历史出现过的 distinct run 数（用同一张物化表按 workspace+provider 派生），不足 `maxRuns` 时把 cap 降到 `maxCompaniesPerRun`。统计结果按 provider 进程内缓存（每次活动 ≤7 次查询）。
- 负向：未登记/未启用/无血缘的源仍被既有 gate 拦下（不变）；跨租户由 RLS 保证（计数查询走 withWorkspace）。

### 4.4 配置与回退

| env | 默认 | 说明 |
| --- | --- | --- |
| `DISCOVERY_CHEAP_FIRST` | `shadow`（首轮）→ `enforce` | off=完全恢复现状；shadow=只计算与记录「将会跳过/裁剪什么」，不实际跳过（用于一轮对比） |
| `DISCOVERY_STRUCTURED_SOURCE_RUN_CAP` | `100` | 结构化源每轮每源公司帽 |
| `DISCOVERY_RUN_POOL_CAP` | `500` | run 总池帽（兜底层） |
| `DISCOVERY_TRIAL_MAX_RUNS` / `DISCOVERY_TRIAL_MAX_COMPANIES` | `10` / `20` | 新源试跑限额（可被 data_provider.config 覆盖） |

回退：`DISCOVERY_CHEAP_FIRST=off` 一键恢复（纯代码路径）；无 schema 迁移；镜像回滚可用上一 digest。

### 4.5 观测

- run stats 增 `perSource.capSkipped` 与 `trialApplied`（按 provider），沿用既有 run stats 结构；run_event 注记一次（不新增公共事件）。
- gain-saas 归因查询（`ops.service.ts:595`）增 `queries` 列：`count(DISTINCT query_key)`（来自 `discovery_query_operation_attempt` 或回执表），支撑「public_web 查询数下降」验收；不改前端（ops 表格自动多一列或后续小改）。

## 5. 闭环设计（§0.6 ②）

- **SoR**：计划/查询/回执/物化归因在引擎（run 内）；provider 启停与配置在 `data_provider`（平台表）；归因展示在 gain-saas ops（只读）。
- **事件**：不新增公共事件；run stats 与 run_event 注记承载观测；`DiscoveryRunCompleted` 载荷不变（成本补口是步 3，不在本步）。
- **Tool Contract**：provider 仍经 ToolBroker（不新增工具）；本步只改 planner/执行路由，不涉及对外能力面。
- **闭环位置**：Discover 阶段（结构化源 → 物化 → 预筛 → 快判 → 深判）；上游是 ICP/计划，下游是资格与公司池。
- **端到端演示**：同 ICP golden mini-run（3–5 家）跑两次（shadow 一轮 → enforce 一轮），对比归因漏斗：结构化源占比、public_web 查询数、召回（同集合）、cost_cents。
- **负向测试**：cap 达界跳过并留痕；env=off 恢复扇出；未启用源仍拒；跨租户不可见；trial 计数只增不减（同 run 重放不重复计）。

## 6. 测试与 TDD 步骤（先红后绿）

1. `routePlannerQueries` 源优先级裁剪：新增单测（超帽时 public_web 副本先被丢）→ RED → 实现 → GREEN。
2. `plannerSourcePrompt` 快照：优先级/配额文案断言。
3. `executeQuery` 配额：新单测注入 100 家已物化 → 适配器不被调用、零回执、stats 计入 `capSkipped`（mock prisma/providers）。
4. 试跑限额：config 读取与 distinct run 计数（mock）→ 前 10 次降帽。
5. 真库（可选，postgres spec）：物化计数 SQL 正确性（against `discovery_company_materialization_outcome`）。
6. env=off 回归：既有扇出用例全绿。
7. 归因 `queries` 列：gain-saas 单测（SQL 快照/结果映射）。

## 7. 联网研究结论（§0.6 ③；2026-11-05）

- **waterfall 排序原则**：按「每增量命中的有效成本 = 价格 ÷ 增量命中率」排序并短路（You.com《Waterfall Enrichment: Architecture and Math》）；3–4 个源后收益递减，需用本细分 200 条样本验序，不能照搬供应商基准。
- **开源实践**：`enrichment-kit`（GitHub，开源 Clay 替代）自动按有效成本排序 5 源，30 天缓存带来约 40% 节省；`pipe0` 警示「纯 cheapest-first 可能损覆盖」——与我们的 public_web 兜底 + golden set 门一致。
- **借/集/建/避**：借「按增量成本排序 + 短路 + 样本验序」原则；**自建**（我们已有 planner/回执/归因，不引入外部 waterfall 库）；集（无）；避（直接套用第三方定价排序——我们的结构化源边际成本≈0，排序依据是抓取/LLM 消耗与覆盖）。

链接：
- https://you.com/resources/waterfall-enrichment
- https://github.com/masteranime/enrichment-kit
- https://github.com/pipe-0/pipe0 （best-waterfall-enrichment-tools）
- https://cufinder.io/blog/how-to-set-up-waterfall-enrichment/

## 8. 迁移与回滚

无 schema 迁移（`data_provider.config` JSON 存试跑配置）。回滚 = env off / 上一镜像 digest。上线顺序建议：
1. PR-1（规划层：L1 提示 + L2 排序 + 观测字段，`DISCOVERY_CHEAP_FIRST=shadow` 默认）→ 一轮 shadow golden mini-run 对比；
2. PR-2（执行层：L3 配额 + 试跑 + 归因 `queries` 列）→ enforce；
两步都可独立回退；部署需「发车」。

## 9. 风险与开放问题

| 风险 | 处置 |
| --- | --- |
| 结构化源覆盖不足 → 召回下降 | public_web 兜底不受 per-source cap；影子一轮先在日志里看「将会被跳过/被丢副本」的量；召回门不过则回退 |
| per-run 计数查询开销 | 每活动一次批量读（按 run 分组 count），索引走 `(workspace_id, run_id, provider_key)`；若慢，v2 加 `provider_run_stats` 汇总表 |
| 试跑计数口径 | 用物化表 distinct run 派生（只增不减）；重放不重复计；同时可被 ops 手动清零（SQL） |
| 「500 池」与 quick-scan 的既有语义 | 现有 `QUICK_SCAN_POOL_LIMIT=500` 是消费上限；本设计的「总池帽」落点需在实现时与物化/池路径对齐（见 §4.3 注） |
| planner 提示变长影响输出质量 | 提示只加两段；用 3–5 家 golden mini-run 对比计划质量（查询数/源分布） |

## 10. 决策点（请产品负责人确认）

- **D-a 配额数值**：结构化源每轮各 ≤100 家、总池 500 —— 是否按 Q33 原值执行？（推荐：是）
- **D-b public_web 查询上限**：不设独立查询帽，只受总池 500 约束（推荐：是；避免误伤召回）
- **D-c 试跑限额**：前 10 次运行 × 每次 ≤20 家（推荐：是）
- **D-d 上线方式**：先 shadow 一轮 golden mini-run 再 enforce（推荐：是）
- **D-e PR 拆分**：规划层（PR-1）与执行层（PR-2）分两步（推荐：是）

## 11. 实现裁定（2026-11-05，PR-2 落地时）

- **裁定：每源公司帽以「每源每轮查询预算」等价落地，不在查询时逐家计数。** 原因：物化（`discovery_company_materialization_outcome`）发生在查询阶段之后，查询期无法用已物化公司数做闸门；而查询收据是严格键契约（`discovery-query-receipt/v1`，加字段需升 v2 并改工作流），为一次配额引入公开契约变更不划算。
- **等价关系**：每查询每源记录上限 `MAX_DISCOVERY_PROVIDER_RECORDS = 25`。结构化源预算 = `floor(DISCOVERY_STRUCTURED_SOURCE_RUN_CAP / 25)`（默认 100 → 4 条查询 ≈ ≤100 条原始公司记录，去重后 ≤100 家，满足 Q33 上限）；试跑源预算 = `max(1, floor(DISCOVERY_TRIAL_MAX_COMPANIES / 25))`（默认 20 → 1 条 ≈ ≤25 条）；`public_web` 兜底源不设查询预算，其总量由既有公司池上限（`QUICK_SCAN_POOL_LIMIT = 500`）约束。
- **试跑判定**：`trialSourceProviders` 按工作空间统计 `raw_source_record` 的 distinct run 数，`< DISCOVERY_TRIAL_MAX_RUNS`（默认 10）视为试跑期；查询失败按「无试跑源」降级，不阻塞规划。
- **观测**：shadow 模式下，计划 review 注记同时给出「将替换副本数」与「将按预算移出查询数」；enforce 模式下预算移出计入 `dropped.SOURCE_QUERY_BUDGET`（计划落库，可审计）。
- **未改变**：收据契约、工作流/活动接口、`data_provider` 启停门、血缘闸门均未动；回退仍为 `DISCOVERY_CHEAP_FIRST=off`。
- **后续（PR-3 候选）**：gain-saas 归因页增加「查询数」列；若需要严格的「按家数」实时闸门，再评估收据 v2 或物化期闸门。
