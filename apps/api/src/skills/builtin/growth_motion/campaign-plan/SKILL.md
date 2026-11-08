---
name: campaign-plan
description: 受限 Campaign 规划器（propose-only）：只读取输入并产出 CampaignPlan v0 计划 JSON，不执行、不抓取、不写任何业务表，零工具调用；计划须经人工批准。
license: Proprietary
metadata:
  platform.skill-key: campaign.plan
  platform.version: 1.0.0
  platform.skill-kind: model_task
  platform.tenant-default: enabled
  platform.pack-type: growth_motion
  platform.task-contract: campaign.plan
  platform.task-contract-digest: "17211934ed7d7d8295fe4b22a54901a21e455cce9ba8be12a29d4dc974e7afe0"
  platform.risk: medium
  platform.human-gate: "true"
  platform.budget-cents: "60"
  platform.owner: OWN-BUYER-BE
---

# Campaign 规划

输入：只读提示（JSON），包含本次 Campaign 的目标、可用 ICP 及其 id（名称/状态/目标市场/
已验证规则摘要）、卖家已批准事实（Offering/Claim，均来自人工审批后的事实 SoR）、公司池
聚合统计（按国家/行业的计数，无明细 PII）、记忆简报（带出处）与预算/受众上限提示。

输出：CampaignPlan v0（`campaign-plan/v0`）——目标与成功度量、受众（ICP id 列表 + 每个 ICP
的候选规模上限）、动作序列（v0 仅 `discovery`）、预算上限（微美元，可选）、审批要求
（恒为 true）与决策策略（`maxReplans` 恒 0）。

边界：

- 只做计划，不执行任何动作；不调用任何工具（`allowed-tools` 为空）。
- `audience.icpIds` 只能从提示列出的 ICP id 中原样选取；`motions[].icpIds` 必须是
  `audience.icpIds` 的子集。
- 不得编造 ICP id、公司、预算或事实；不确定时缩小规模或省略可选字段。
- 输出只是草稿（revision DRAFT）：人工批准后才签发执行授权；影子期即使批准也不执行。
