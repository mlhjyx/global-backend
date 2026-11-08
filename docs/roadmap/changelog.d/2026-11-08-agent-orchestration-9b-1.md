---
date: 2026-11-08
title: Add the agent registry, decision trace table and ops kill switch (M2 step 9b-1)
---

- 起因：M2 步 9b 多 agent 编排 v0 第 1 步——先落注册表与决策轨迹地基，行为保持不变（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - 迁移 `20261108160000_agent_orchestration_v0`：新增 `agent_profile`（平台级 agent 注册表：角色提示词版本 + 技能子集 + 模型策略 + 记忆作用域 + loop 策略，FORCE RLS，app_user 仅列级 UPDATE 状态列）与 `agent_decision_trace`（append-only 决策轨迹，F2 字段组子集、无 PII，按 workspace FORCE RLS 隔离，app_user 仅 SELECT/INSERT，`(workspace, run, step_type, discriminator)` 唯一键幂等，随 run 级联删除）；同步 `docs/governance/app-user-table-privileges.json`。
  - `apps/api/src/agents/`：agent 目录（两角色 `discovery.source_scout` / `discovery.qualifier`，loop 恒单回合）、owner 幂等 seed（不覆盖 ops 启停）、DB 解析器（`AGENT_NOT_REGISTERED` / `AGENT_DISABLED` fail-closed，30s 缓存）、决策轨迹 append-only store（唯一写入口 `record`，ON CONFLICT DO NOTHING）。
  - ops 面：`GET /ops-agents`、`PATCH /ops-agents/:agentKey/status`（复用 S0 ops 鉴权 `ops:read` / `ops:write`，租户 token 403）。
  - 启动期 seed：worker（失败大声 `AGENT_CATALOG_SEED_UNAVAILABLE`）与 relay 同步执行。
- 零行为变化：本步不接线任何执行路径（角色化在 9b-2/9b-3），既有召回/评分/预算/重试语义不动。
- 测试：单测覆盖负向 1（未注册拒绝）/2（停用 fail-closed）/4（无 UPDATE/DELETE 路径，源码断言 + 方法面）/6（幂等键契约）；真库 postgres 套件（CI 多 spec job）实测 seed 幂等与不覆盖 kill switch、跨租户不可见、重放不翻行、append-only、随 run 级联删除。
- 未做：源侦察员/资格判定员角色化（9b-2/9b-3）、`GET /runs/:runId/trace` 与前端时间线（9b-4）。
