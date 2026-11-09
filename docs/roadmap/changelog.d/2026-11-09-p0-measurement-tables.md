---
date: 2026-11-09
title: Add the measurement core tables — metric definition, observation and daily/weekly rollups (ch01 PR-02, held for a schema window)
---

- 起因：ch01 PR-02 要求把指标字典、观测与日/周聚合落成数据库表，作为度量工作流（PR-03）与 API（PR-04）的地基；本次只做四表迁移与权限，不接线任何运行时。
- 改动：
  - 迁移 `20261109160000_measurement_core_v1`：`metric_definition`（平台工件，唯一 `(metric_id, version)`，状态/层级/版本 CHECK）、`metric_observation`（append-only，`workspace_id IS NULL` = 平台级，身份唯一键含 computation_hash）、`metric_rollup_daily` / `metric_rollup_weekly`（物化聚合，主键含 stratum_key）。RLS：observation 按 `workspace_id`；rollup 两表按 `stratum->>'workspace_id'` 表达式 + 表达式索引；平台行对租户不可见。权限：字典只读；observation 仅 SELECT/INSERT；rollup 可 SELECT/INSERT/UPDATE（upsert），DELETE 一律拒绝。
  - Prisma datamodel 四模型同步（`packages/db/prisma/schema.prisma`），与迁移逐列对齐；有意差异：Prisma 不支持 Json 进主键/唯一键，改用并列的 `stratum_key`（排序键规范化 JSON 文本，应用层写入）；数值列 NUMERIC(20,6) ↔ Decimal(20,6)。
  - 权限清单 `docs/governance/app-user-table-privileges.json` 增四表；`app-user-table-privileges.postgres.spec.ts` 增「measurement core tables」负向块（RLS 隔离、跨 workspace 与平台行拒绝、append-only、rollup upsert/拒删、字典只读）。
  - Copy 固定源回执重签（schema.prisma 属 Copy 绑定文件；仅哈希位移，资格状态保持 main 既有的 STALE_HOLD）。
- 测试：一次性 pgvector Postgres 容器全量回放 200+ 迁移通过（含本迁移）；RLS/权限探针实测（自己的 workspace 可见、他人 0 行；平台行与跨租户写入被 RLS 拒；observation UPDATE/DELETE 与 rollup DELETE 被 42501 拒；rollup upsert 生效；字典 INSERT 拒、SELECT 允许）。
- 未做：不接线工作流/API/事件（PR-03/04）；不部署不发车；**本 PR 按协调要求在「schema 窗口」通知前不合并**（届时按当时 main 重签 Copy 回执再合）。
