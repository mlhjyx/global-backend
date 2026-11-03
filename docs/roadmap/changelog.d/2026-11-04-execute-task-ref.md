---
date: 2026-11-04
pr:
title: Accept an optional Run 2.0 taskRef when executing a discovery query plan
---

- 起因：Run 2.0 把「挖掘任务（AcquisitionTask/TaskRun，gain-saas）」前移为 run 的发起方，引擎需要在执行记录上携带任务归因（完整设计 §6.1/§7、M0②）。
- 改动：`POST /query-plans/:planId/execute` 接受可选 `{taskRef: {taskId, taskRunId}}`，写入 `discovery_run.task_ref` 并随 `DiscoveryRunRequested` 命令负载传递；不传时请求/数据形状与之前完全一致；形状不合法在任何预算 Grant 消耗前返回 400 `TASK_REF_INVALID`。OpenAPI 已重新生成（纯新增 requestBody）。
- 测试：新增 executePlan taskRef 单测（存储/省略/拒绝三条），既有 controller 与 authority 原子性套件通过；contracts spectral lint 无 error。
- 未做：gain-saas 侧 Task/TaskRun 与 `taskRef` 发送（另一 PR）；webhook 事件中的任务归因。
