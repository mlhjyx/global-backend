---
name: discovery-quick-judge
description: 批量粗筛（L1 快扫）：给定卖方 ICP 与一批候选公司（最多 8 家/次），逐家按「行业赛道+商业角色+目标市场」必过层与「细分参数仅加分不拒判」两层口径粗判，输出 provisional verdict（match / weak / mismatch）与一句理由；明确无关行业或竞品直判 mismatch，仅信息不足或撮合平台判 weak。
license: Proprietary
metadata:
  platform.skill-key: discovery.quick_judge
  platform.version: 1.1.0
  platform.skill-kind: model_task
  platform.tenant-default: enabled
  platform.pack-type: growth_motion
  platform.task-contract: discovery.quick_judge
  platform.task-contract-digest: eedba015d3d79ee0ef0f667df634348d2497fbe6d4b87d655e39aca5ae06a209
  platform.risk: low
  platform.human-gate: "false"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 批量候选粗筛（L1 快扫）

输入：卖方 ICP 摘要（含目标贸易角色 `icp_trade_role`）与一批候选公司（每家含名称、域名、
国家、行业、贸易角色、产品/关键词与简要证据；batch 协议中每家有 `index`）。

输出：`judgments` 数组——对每个 `index` 给出 verdict（match / weak / mismatch）与一句中文理由。

判定两层口径（provisional 粗筛，与 `buildQuickJudgePrompt` 保持同一口径）：

1. 必过层（决定 match / weak / mismatch）：重点核对① 行业赛道是否一致 ② 商业角色是否匹配目标买家（如分销商、批发商、进口商、EPC、电站/工程开发商、系统集成商、终端采购方；纯竞品制造商判 mismatch）③ 目标市场是否吻合。
2. 加分层（卖方细分产品参数/型号/工艺卖点仅作加分参考，绝不作拒判门槛）：候选官网摘要通常只写大类业务，严禁仅因未提及卖方具体技术参数就把真实行业买家降判为 weak 或 mismatch。

淘汰与分流边界：
- 明确无关行业、纯竞品制造商、非目标区域或明显无效页，一律直接判 `mismatch`（绝不要放进 `weak`）；
- 仅在行业看似相关但信息过少无法确认买家角色、或属于信息撮合平台时判 `weak` 交 L2 深判复核；
- 其余符合行业赛道、商业角色与目标市场的判 `match`。

本技能不产出最终 verdict，最终判定由 `discovery.qualify_fit` 深判与确定性聚合器决定。
