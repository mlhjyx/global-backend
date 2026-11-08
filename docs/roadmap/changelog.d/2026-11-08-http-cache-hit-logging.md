---
date: 2026-11-08
title: Log PR-B page-cache state so hit rate is observable on real runs
---

- 起因：PR-B 设计 §4.5 承诺 `[http-cache] url=… state=…` 结构化日志；实现只带 provenance，而 artifact 绑定路径只持久化 artifact 引用、不保存 provenance，导致 304 命中率在真机 run 上不可聚合。主计划 §3.5b 的「归因看板抓取层页签：304 命中率」指标依赖此日志。
- 改动：`fetchPageHttpFirst` 在缓存 miss（写入路径）与 conditional-304（复用路径）各打一行 `[http-cache] state=<miss|conditional-304> url=<前 200 字符>`；未启用缓存时不打。
- 测试：`http-first-fetch.spec.ts` 断言两条日志行的确切内容。
- 未做：归因看板「抓取层」页签本身（Q33 PR-1 排期）；日志聚合器不在本 PR。
