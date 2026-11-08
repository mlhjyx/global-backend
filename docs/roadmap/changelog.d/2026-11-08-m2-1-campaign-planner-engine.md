---
date: 2026-11-08
title: Add the restricted campaign planner skill, workflow and campaign.plan budget purpose
---

- 起因：M2.1（计划 v1.5 步 9，设计 `docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md`，D-MA-3/D-M2.1-a~e 已获批）需要引擎侧的受限 Campaign 规划器：只读输入、只产计划、不执行任何动作（影子期结构上不执行），计划经回调交给 gain-saas 做唯一权威的 plan_hash 与审批。
- 改动：
  - 新增 AI Task `campaign.plan`（零工具、humanGate、推理档模型，输出 CampaignPlan v0 JSON，与 gain-saas M2.0 契约逐字段一致）与技能包 `apps/api/src/skills/builtin/growth_motion/campaign-plan/SKILL.md`（model_task，绑定契约摘要）。
  - 新增 `createCampaignPlanningActivities`（只读装配 ICP / 卖家已批准事实 / 公司池聚合计数 / 记忆 brief；经 S0 技能运行时调用；语义硬门 + 一次修复；回调 gain-saas 或失败回写 job）与 `campaignPlanningWorkflow`（装配 → 规划 → 交付，失败回写 `FAILED` + 闭集错误码；负向 4：技能停用 → `SKILL_PLATFORM_DISABLED` 且零模型调用）。
  - 新增引擎内部端点 `POST /api/v1/internal/campaign-plans/draft`（`x-service-token` fail-closed 服务身份 + 一次性 execution-budget Grant），独立 `CampaignPlanModule` 注册。
  - execution-budget 新增 purpose `campaign.plan` / subject `campaign` 与 quote 变体 `POST /campaigns/:campaignId/plan-drafts`（请求哈希绑定 jobId）；`durable-result-strategies.json` 与 `scripts/execution-authority-policy.mjs`、domain-ack 绑定同步登记 `campaign.plan`（`campaign-plan/v1` typed projection；载荷内 `schemaVersion` 仍是 gain-saas 契约的 `campaign-plan/v0`）。
- 测试：新增 workflow 编排单测（顺序、失败回写、非法输入）、活动单测（负向 4 零模型调用、语义越界 → `CAMPAIGN_PLAN_INVALID` + issues、回调 422/网络失败分类）、内部端点/守卫单测（503/401/请求闭合/Grant 失败不启动）、预算 purpose/subject 用例；投影注册表与 domain-ack 计数用例扩展。
- 未做：gain-saas 侧 job 表/三端点/回调幂等与审批 UI（M2.1-2/3）、端到端联调（M2.1-4）；部署需在 worker/API env 配置 `CAMPAIGN_CONTROL_PLANE_URL`、`CAMPAIGN_INTERNAL_SERVICE_TOKEN`、`CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN`（与 gain-saas 对侧一致），并在 gain-saas 签发 `campaign.plan` Grant 后才可触发。
- 部署：新增 purpose 属加法；未配置新 env 时内部端点 fail-closed 503、回调活动 nonRetryable `CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED`，不影响既有链路。回滚：不触发即无行为；表/数据无引擎侧迁移。
