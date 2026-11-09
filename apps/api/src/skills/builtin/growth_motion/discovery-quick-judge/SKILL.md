---
name: discovery-quick-judge
description: 批量粗筛（L1 快扫）：给定卖方 ICP 与一批候选公司（最多 8 家/次），逐家按材质/角色/工艺/商业模式四门粗判是否为真实目标客户，输出 provisional verdict（match / weak / mismatch）与一句理由；边缘情况一律 weak 交深判复核。
license: Proprietary
metadata:
  platform.skill-key: discovery.quick_judge
  platform.version: 1.0.0
  platform.skill-kind: model_task
  platform.tenant-default: enabled
  platform.pack-type: growth_motion
  platform.task-contract: discovery.quick_judge
  platform.task-contract-digest: b1198ea1842add48f380617cca483695d9e3bb8127373afb8bb6d6175ee3e2f3
  platform.risk: low
  platform.human-gate: "false"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 批量候选粗筛（L1 快扫）

输入：卖方 ICP 摘要（含目标贸易角色 `icp_trade_role`）与一批候选公司（每家含名称、域名、
国家、行业、产品/关键词；batch 协议中每家有 `index`）。

输出：`judgments` 数组——对每个 `index` 给出 verdict（match / weak / mismatch）与一句中文理由。

判定顺序（与单家深判同一口径，但属粗筛）：

1. 材质门——候选的加工材质是否与 ICP 目标一致；ICP 未要求材质时视为通过。
2. 角色门——候选是下游买家还是同类产品制造商（竞品判 mismatch）；分销商 ICP 下，
   采购并转售的分销/批发/进口/经销判通过。
3. 工艺子集门——候选是否真正从事 ICP 核心工艺，仅相邻工艺判 weak。
4. 商业模式门——转售型分销判通过，信息撮合平台判 weak。

这是 provisional 粗筛：证据不足或边缘情况一律判 weak 交 L2 深判复核，绝不猜测；
本技能不产出最终 verdict，最终判定由 `discovery.qualify_fit` 深判与确定性聚合器决定。
