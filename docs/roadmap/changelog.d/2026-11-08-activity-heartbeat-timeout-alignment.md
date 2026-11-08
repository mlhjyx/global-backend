---
date: 2026-11-08
title: Align understanding activity timeouts and propagate cancellation into model calls
---

- 起因：审计 PERF-02（P1/P2 混合）——understanding 模型活动时限（3 分钟）短于网关模型请求上限（300s），活动先超时、HTTP 请求仍在跑，重试会再发一次付费调用；模型/抓取活动无心跳；活动取消不传播到模型请求。
- 改动：模型活动 3m→6m、抓取活动 3m→5m 并加 `heartbeatTimeout=2m`；`crawlPages`/`extractClaims`/`extractOfferings` 包 30s 周期心跳；`activityCancellationSignal()` 把活动取消信号传进两个抽取调用的网关输入（`GenerateStructuredInput.signal`）。配合 B2：超时重试撞到上一条 RESERVED 时以 remnant 分类只尝试一次，不再重复付费调用。
- 测试：新增源文本断言（超时/心跳常量、signal 传入、心跳包装），既有 understanding workflow/activities spec 全绿；全量零容器单测与治理门禁全绿。
- 未做：ToolBroker `ToolContext` 无 signal 字段，取消传播到**全部工具适配器**属后续小步（随 B12 PERF 群评估）；活动时限的全局审计未做（本 PR 修审计点名的 understanding 路径）。
