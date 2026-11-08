---
date: 2026-11-08
title: Align understanding activity timeouts and propagate cancellation into model calls
---

- 起因：审计 PERF-02（P1/P2 混合）——understanding 模型活动时限（3 分钟）短于网关模型请求上限（300s），活动先超时、HTTP 请求仍在跑，重试会再发一次付费调用；模型/抓取活动无心跳；活动取消不传播到模型请求。
- 改动：模型活动 3m→**15m**（一次结构化回答可能串初答 + schema 修复两条 provider 调用，2×300s 上限 + 余量，与 discovery 的 15m 口径一致）、抓取活动 3m→5m，均加 `heartbeatTimeout=2m`；`crawlWebsite`/`crawlPages`/`extractClaims`/`extractOfferings`/`extractAndPersistProfile` **全部**包 30s 周期心跳（否则 heartbeatTimeout 会把无心跳活动的预算压到 2 分钟）；三处模型调用都传 `activityCancellationSignal()`（`GenerateStructuredInput.signal` 贯通到 HTTP fetch 的 AbortSignal.any）。重复付费的防线是「活动时限 ≥ 线上最坏路径 + 取消真正掐断请求」——注意重试会以 attempt 编号生成**新的**账本操作键，B2 的 remnant 快速失败只覆盖同一 attempt 内的重执行，不能当作跨 attempt 的护身符。
- 测试：新增源文本断言（超时/心跳常量、signal 传入、心跳包装），既有 understanding workflow/activities spec 全绿；全量零容器单测与治理门禁全绿。
- 未做：ToolBroker `ToolContext` 无 signal 字段，取消传播到**全部工具适配器**属后续小步（随 B12 PERF 群评估）；活动时限的全局审计未做（本 PR 修审计点名的 understanding 路径）。
