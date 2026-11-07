---
name: discovery-qualify-fit
description: 给定卖方 ICP 与一家候选公司，按材质/角色/工艺/商业模式四门判定其是否为真实目标客户（match / weak / mismatch），只依据给定信息并给出具体理由。
license: Proprietary
metadata:
  platform.skill-key: discovery.qualify_fit
  platform.version: 1.0.0
  platform.pack-type: growth_motion
  platform.task-contract: discovery.qualify_fit
  platform.task-contract-digest: 2d907019d3457d30af3158bc4ae8a8026b11c436725800fdbd676013d47158c0
  platform.risk: low
  platform.human-gate: "false"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 候选公司资格判定

输入：卖方 ICP 摘要（含目标贸易角色 `icp_trade_role`）与一家候选公司（名称、域名、
国家、行业、产品/关键词、官网画像 website_profile）。

输出：verdict（match / weak / mismatch）、四门结论（material_gate / role_gate /
process_gate / business_model_gate）与具体理由数组。

判定顺序：

1. 材质门——候选的加工材质是否与 ICP 目标一致；ICP 未要求材质时视为通过。
2. 角色门——候选是下游买家还是同类产品制造商（竞品判 mismatch）。
3. 工艺子集门——候选是否真正从事 ICP 核心工艺，仅相邻工艺判 weak。
4. 商业模式门——分销商 ICP 下，转售型分销/批发/进口/经销判 pass，撮合平台判 weak。

任一硬门失败判 mismatch；边缘/相邻判 weak；全部通过判 match。只依据给定信息，
理由必须具体。模型拒答不是证据不足，按 fail-safe 转人工复核（weak），绝不自动拒绝。
