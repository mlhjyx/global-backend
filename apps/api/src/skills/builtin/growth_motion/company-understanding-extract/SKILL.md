---
name: company-understanding-extract
description: 从企业官网/资料库页面文本抽取带类型与置信度的企业事实（Claim）。只抽文本中明确存在的信息并附原文证据，用于公司理解阶段的知识入库。
license: Proprietary
allowed-tools: crawl4ai.fetch
metadata:
  platform.skill-key: company.understanding.extract
  platform.version: 1.1.0
  platform.skill-kind: model_task
  platform.tenant-default: enabled
  platform.pack-type: growth_motion
  platform.task-contract: company_understanding.extract_claims
  platform.task-contract-digest: a60b03f1ff293a4acb35daf80be7313c1fbcfd03cef069a4e7511adfd77d2e0c
  platform.risk: medium
  platform.human-gate: "true"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 公司事实抽取

输入：公司官网/资料库页面的 Markdown 文本（已由抓取层受治理获取）。

输出：Claim 数组，每条包含 type（capability / certification / case / param / moq /
lead_time / market / company_fact / value_prop / forbidden_expression_candidate）、
statement、evidence（逐字来自输入的原文片段）与 confidence（0–1）。

边界：

- 只抽取输入文本中明确存在的信息，不得编造、不得从画像或常识补全。
- 证据片段必须能在输入文本中逐字命中，否则该条 Claim 视为无效。
- 发现营销性/绝对化表述时输出 `forbidden_expression_candidate`，交给品牌审核。
- 输出进入 NEEDS_REVIEW，人工审批后才可作为对外事实使用。
