---
name: company-understanding-extract-offerings
description: 从企业官网页面文本抽取结构化的产品/服务（Offering）：名称、简述、关键属性与来源证据。仅收录文本中明确出现的属性，用于公司理解与 ICP 输入。
license: Proprietary
metadata:
  platform.skill-key: company.understanding.extract_offerings
  platform.version: 1.0.0
  platform.pack-type: growth_motion
  platform.task-contract: company_understanding.extract_offerings
  platform.task-contract-digest: c67408bbdf2b8f8e9602a6fb13fafdbc03945a1bd93dc4282ad21c719c7c6227
  platform.risk: low
  platform.human-gate: "false"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 公司产品/服务抽取

输入：公司官网（含产品/能力页）的 Markdown 文本。

输出：Offering 数组，每条包含 name、description、attributes（moq / lead_time /
materials / params / certifications，仅在文本明确出现时填写）、evidence 与 confidence。

边界：

- 禁止编造文本中不存在的属性；attributes 允许为空对象。
- evidence 必须是输入文本中的原文片段。
- 输出只进结构化知识库，不直接对外。
