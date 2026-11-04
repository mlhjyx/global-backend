---
date: 2026-11-04
pr:
title: Add the Run 2.0 domain model (company jobs, run events, channel sightings, pool freshness)
---

- 起因：完整设计（2026-11-04）把寻源 run 重构为「任务 → 快扫 → 公司级深挖流水线」，需要先落 expand-only 的域模型（M0①），后续 PR 才写入。
- 改动：
  - 新表 `discovery_company_job`（每家 × 每 run 的状态机，stage 有 CHECK）、`run_event`（append-only 进度事件，seq 唯一）、`company_channel_sighting`（渠道来源证据；channel_id 暂不设外键，M1 接 source_channel）。
  - `discovery_run` 增 `task_ref`/`phases`/`mode`；`canonical_company` 增 `last_seen_at`/`last_checked_at`/`profile_hash`；`lead` 增 `fit_input_hash`。全部可空或带默认，旧行与旧读取路径不受影响。
  - 三张新表租户 RLS；`run_event` 与 `company_channel_sighting` 仅 SELECT/INSERT（append-only）。
- 测试：新增迁移静态契约单测（表/列/CHECK/RLS/权限清单）；`prisma validate` 通过；全量单测随 CI。
- 未做：写入路径与编排（M0②–⑥）；`run_event` 90 天保留期清理；source_channel 外键（M1）。
