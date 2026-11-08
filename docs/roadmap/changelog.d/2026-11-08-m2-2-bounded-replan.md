---
date: 2026-11-08
title: Bound campaign-planning replans to two rounds with a cost cap and NEEDS_HUMAN
---

- 起因：M2.2 第 1 步（设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md`，D-M2.2-a/b 已批准）——规划器在受控边界内迭代：校验不通过时最多自动重规划 2 轮，人工拒绝后可带理由重生成；超界转人工而不是无限烧钱。
- 改动：
  - `campaign.plan` 契约（向后兼容扩展）：`decisionPolicy.maxReplans` 由恒 0 放宽为 `{0,1,2}`，语义为「提示给出的重规划预算原样回声」；SKILL.md 升 1.1.0 并重钉契约摘要与渲染快照；技能评测新增「重规划预算回声」用例。
  - `campaignPlanningWorkflow` 改为**有界循环**：首轮（或人工拒绝后的重生成，携带 `previousPlan` + 500 字内理由）+ 至多 `maxReplans` 轮校验反馈重规划；每轮独立模型调用与 usage 记账；轮次耗尽仍不合法 → job `NEEDS_HUMAN`（附 `issues` 与逐轮 `replanHistory`），交付成功时把 `replanHistory` 一并交给 gain-saas 落轨迹。
  - 内部端点 `POST /api/internal/campaign-plans/draft` 接受 `maxReplans`/`previousPlan`/`replanReason`（严格校验、64KB 上限）；job 级成本上限 = 轮数 × 单轮契约上限，轮数由 env `CAMPAIGN_PLAN_JOB_COST_CAP_CENTS`（默认单轮 ×3）压低下界。
  - 活动层校验失败不再自行终结 job（返回 issues 由工作流裁决）；控制面回调新增 `state: NEEDS_HUMAN` 与 `replanHistory` 字段（gain-saas 侧接受同名字段后生效）。
- 测试：单测 234 例相关全绿（循环：issues→重规划→交付带历史；轮次耗尽 NEEDS_HUMAN；人工拒绝 round 0 上下文；maxReplans 越界在活动前拒绝；语义硬门要求 maxReplans 等于提示预算）；投影界/执行权威清单复验通过。
- 未做：gain-saas 侧 `NEEDS_HUMAN` 状态、回调字段接受与拒绝触发的自动重生成（下一 PR）；真模型回归（golden `campaign:golden --live`，等 M2.1 金丝雀接线）。
