---
date: 2026-11-05
title: Prefer structured sources when trimming the discovery query plan (cheap-first PR-1)
---

- 起因：Q33② 要求数据源路由「结构化源优先、public_web 兜底」。现状 planner 由模型自由选择源，超查询帽时的裁剪按 query priority 排序，public_web 副本与结构化源同权，且规划提示里 public_web 排第一行。
- 改动：
  - planner 指南加路由优先级与配额说明（结构化源优先、public_web 仅作兜底；结构化源每轮各约 ≤100 家公司、公司池补到 500；新源前 10 次运行限量试跑），并把可用源列表按源优先级排序（结构化源在前）。
  - `routePlannerQueries` 的 `PLAN_QUERY_CAP` 裁剪加入源优先级 tiebreak：超帽时先保留结构化源副本、先丢 public_web 副本；扇出语义不变。
  - 新增 `DISCOVERY_CHEAP_FIRST` 开关（off | shadow | enforce，默认 shadow）：shadow 保持旧行为，只把「按 cheap-first 将替换多少副本」写进计划 review 注记。
- 测试：新增单测覆盖开关解析（默认 shadow、未知值回落 shadow）、enforce 裁剪顺序、shadow 报告与 off 回退、prompt 优先级与配额文案；`gctl check` 通过。
- 未做：不含执行层配额（每 run 每结构化源公司帽、新源试跑限额）与归因「查询数」列——随 PR-2。
