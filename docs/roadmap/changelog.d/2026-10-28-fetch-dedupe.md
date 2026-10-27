---
date: 2026-10-28
pr:
title: Skip a company this run already accepted before calling the model again
---

- 起因：一次 run 的计划里有 10–21 条查询，同一批站点会在多条查询里反复出现（run 7d70d81d 的 87 条记录里有 28 条、32% 是同一 URL 的重复，其中内容漂移的部分被隔离为 `PROCESSING_KEY_DRIFT`）。重复的不只是抓取：`public_web` 的发现阶段按域名逐家调用模型判站，重复域名等于重复花模型调用，产出的记录随后还被摄取层丢弃。
- 改动：`executeQuery` 在 fan-out 前读出本 run 已 ACCEPTED 的 `external_id`（按路由到的 provider 过滤、去重），作为 `knownExternalIds` 随 `DiscoveryOptions` 传给适配器；`public_web` 在搜索之后、调用模型之前跳过这些域名。其他适配器忽略该选项（注册类源是廉价查询，无需跳过）。`DiscoveryOptions` 新增字段是加法，适配器签名不变。
- 测试：`public-web-search-first.spec.ts` 新增用例——已知域名不触发模型调用、结果只含新域名；`raw-source-activities.spec.ts` 的 executeQuery 持久化用例断言适配器收到 `knownExternalIds`（含 run 里已接受的域名），并确认摄取计数不受影响。
- 未做：跨 run 的去重不做（不同 run 换了操作键、也允许重新判站）；同一 run 内「同域名不同 URL」仍按域名去重、不细分路径。
