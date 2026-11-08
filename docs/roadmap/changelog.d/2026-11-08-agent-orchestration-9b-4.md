---
date: 2026-11-08
title: Serve the run decision trace to tenants and render the process timeline (M2 step 9b-4)
---

- 起因：M2 步 9b 第 4 步——把决策轨迹接到租户与前端：引擎新增 run 轨迹只读端点，gain-saas run 详情内嵌「过程」只读时间线（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - 引擎：`GET /api/v1/runs/:runId/trace`（`acquisition:read`；键集分页 limit 默认 100/上限 200；跨租户 404；返回 step/agent/decision/chosen/rejected/evidence/cost/createdAt）；轨迹 store 增加租户只读列表路径（仍无 UPDATE/DELETE）；接口门户说明表同步。
  - gain-saas：run 详情新增「过程」只读时间线（选源/跳过原因、批量判定与被否候选），经独立租户模块调用引擎（不新增 BFF 注册表条目）。
- 零行为变化：只读端点与前端展示；不改任何执行路径。
- 测试：控制器鉴权拓扑 + cursor 编解码单测；真库（CI PostgreSQL job）跨租户 404 与分页；门户完整性 spec 通过；engine OpenAPI 重新导出。
- 未做：E2E-9b 全链（真实 mini-run → trace 可读 → ops 停用资格判定员 → run 以 AGENT_DISABLED 失败且无模型调用 → 恢复）在发车后的部署镜像上执行，需产品负责人的发车指令。
