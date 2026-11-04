---
date: 2026-11-04
title: Cast the run-event advisory lock result so Prisma can deserialize it
---

- 起因：#788 的 run 事件 seq 分配用 `$queryRaw` 读取 `pg_advisory_xact_lock(...)`（返回 void），首次随第十八班镜像上生产即被 Prisma 拒绝（`Failed to deserialize column of type 'void'`），所有新 discovery run 在 quickScan 阶段 10 秒内 FAILED；单测用注入的 fake tx 因此未覆盖真库路径。
- 改动：`run-events.ts` 锁查询加 `::text AS locked` 转型（与 suppression-policy-lock 既有做法一致）；新增 `run-events.postgres.spec.ts` 真库回归用例（含夹具链与清理）。
- 测试：真库用例修复前 RED（复现生产同款错误）→ 修复后 GREEN；既有 run-events 单测保持绿。
- 未做：CI 步骤接线（另开小 PR，避免本次热修触发 ci.yml 全量重门）；后续同类 `$queryRaw` void 语句按同一模式排查。
