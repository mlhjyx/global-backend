---
date: 2026-11-08
title: Add the D-MA-7 memory layer v0 (episodic and semantic tables)
---

- 起因：M2.1 规划器要求「先有记忆与归因」；D-MA-7（2026-11-08 批准）要求在 M1.5/M2 之间先落最小记忆层，设计见 `docs/superpowers/plans/2026-11-08-memory-layer-v0.md`（APPROVED）。
- 改动：
  - 新增 additive 迁移：`mem_run_episode`（append-only，run 完成/结果回填两时点）与 `mem_knowledge_stat`（Beta-Binomial 统计，只追加版本，写权只给 `memory_semantic_writer`），含 RLS、`app_user` 权限与 `outbox_event(event_type, occurred_at)` 索引。
  - 新增 `MemoryModule`：outbox 消费者（默认关闭，`MEMORY_LAYER_V0_ENABLED`）把 `DiscoveryRunCompleted` / `LeadsScored` 幂等写成 episode；`MemoryQueryService` 提供 SQL 检索与 ≤2k token、带出处的 memory brief。
  - 未改 discovery activities/workflows、ai-trace、预算账本、gain-saas 与 skill runtime 文件。
- 测试：契约/消费者/检索单测；真库 RLS 与 `app_user` 权限负向测试（含 semantic 写入被拒）；事件重放幂等测试；`docs:verify` 与 `gctl check --fast`。
- 未做：自动调策略、探索流量、Thompson 采样、semantic 生产写入、公共 HTTP API、历史 run 回填（均留 M2.2 或后续）。
