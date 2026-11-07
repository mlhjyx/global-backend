// GENERATED FILE — do not edit by hand.
// Source: apps/api/src/skills/builtin/**/SKILL.md
// Regenerate: pnpm skills:generate   Verify: pnpm skills:validate
import type { BuiltinSkillRecord } from "../load-builtin-skills";

export const BUILTIN_SKILLS: readonly BuiltinSkillRecord[] =
[
  {
    "skillKey": "company.understanding.extract",
    "directory": "company-understanding-extract",
    "packTypeDirectory": "growth_motion",
    "manifest": {
      "name": "company-understanding-extract",
      "description": "从企业官网/资料库页面文本抽取带类型与置信度的企业事实（Claim）。只抽文本中明确存在的信息并附原文证据，用于公司理解阶段的知识入库。",
      "license": "Proprietary",
      "allowedTools": [
        "crawl4ai.fetch"
      ],
      "metadata": {
        "platform.skill-key": "company.understanding.extract",
        "platform.version": "1.0.0",
        "platform.pack-type": "growth_motion",
        "platform.task-contract": "company_understanding.extract_claims",
        "platform.task-contract-digest": "a60b03f1ff293a4acb35daf80be7313c1fbcfd03cef069a4e7511adfd77d2e0c",
        "platform.risk": "medium",
        "platform.human-gate": "true",
        "platform.budget-cents": "20",
        "platform.owner": "OWN-BUYER-BE"
      },
      "platform": {
        "skillKey": "company.understanding.extract",
        "version": "1.0.0",
        "packType": "growth_motion",
        "taskContractId": "company_understanding.extract_claims",
        "taskContractDigest": "a60b03f1ff293a4acb35daf80be7313c1fbcfd03cef069a4e7511adfd77d2e0c",
        "risk": "medium",
        "humanGate": true,
        "budgetCents": 20,
        "owner": "OWN-BUYER-BE"
      }
    },
    "body": "# 公司事实抽取\n\n输入：公司官网/资料库页面的 Markdown 文本（已由抓取层受治理获取）。\n\n输出：Claim 数组，每条包含 type（capability / certification / case / param / moq /\nlead_time / market / company_fact / value_prop / forbidden_expression_candidate）、\nstatement、evidence（逐字来自输入的原文片段）与 confidence（0–1）。\n\n边界：\n\n- 只抽取输入文本中明确存在的信息，不得编造、不得从画像或常识补全。\n- 证据片段必须能在输入文本中逐字命中，否则该条 Claim 视为无效。\n- 发现营销性/绝对化表述时输出 `forbidden_expression_candidate`，交给品牌审核。\n- 输出进入 NEEDS_REVIEW，人工审批后才可作为对外事实使用。",
    "sourceDigest": "371b37054754a02aa9e7eb2812ad1088ecf52b7a5b315bf5ca49dc6f22be00d7"
  },
  {
    "skillKey": "company.understanding.extract_offerings",
    "directory": "company-understanding-extract-offerings",
    "packTypeDirectory": "growth_motion",
    "manifest": {
      "name": "company-understanding-extract-offerings",
      "description": "从企业官网页面文本抽取结构化的产品/服务（Offering）：名称、简述、关键属性与来源证据。仅收录文本中明确出现的属性，用于公司理解与 ICP 输入。",
      "license": "Proprietary",
      "allowedTools": [],
      "metadata": {
        "platform.skill-key": "company.understanding.extract_offerings",
        "platform.version": "1.0.0",
        "platform.pack-type": "growth_motion",
        "platform.task-contract": "company_understanding.extract_offerings",
        "platform.task-contract-digest": "c67408bbdf2b8f8e9602a6fb13fafdbc03945a1bd93dc4282ad21c719c7c6227",
        "platform.risk": "low",
        "platform.human-gate": "false",
        "platform.budget-cents": "20",
        "platform.owner": "OWN-BUYER-BE"
      },
      "platform": {
        "skillKey": "company.understanding.extract_offerings",
        "version": "1.0.0",
        "packType": "growth_motion",
        "taskContractId": "company_understanding.extract_offerings",
        "taskContractDigest": "c67408bbdf2b8f8e9602a6fb13fafdbc03945a1bd93dc4282ad21c719c7c6227",
        "risk": "low",
        "humanGate": false,
        "budgetCents": 20,
        "owner": "OWN-BUYER-BE"
      }
    },
    "body": "# 公司产品/服务抽取\n\n输入：公司官网（含产品/能力页）的 Markdown 文本。\n\n输出：Offering 数组，每条包含 name、description、attributes（moq / lead_time /\nmaterials / params / certifications，仅在文本明确出现时填写）、evidence 与 confidence。\n\n边界：\n\n- 禁止编造文本中不存在的属性；attributes 允许为空对象。\n- evidence 必须是输入文本中的原文片段。\n- 输出只进结构化知识库，不直接对外。",
    "sourceDigest": "42f9583f23e0950815418257e900601a2611d05f381a0580687c8328b095c634"
  },
  {
    "skillKey": "discovery.qualify_fit",
    "directory": "discovery-qualify-fit",
    "packTypeDirectory": "growth_motion",
    "manifest": {
      "name": "discovery-qualify-fit",
      "description": "给定卖方 ICP 与一家候选公司，按材质/角色/工艺/商业模式四门判定其是否为真实目标客户（match / weak / mismatch），只依据给定信息并给出具体理由。",
      "license": "Proprietary",
      "allowedTools": [],
      "metadata": {
        "platform.skill-key": "discovery.qualify_fit",
        "platform.version": "1.0.0",
        "platform.pack-type": "growth_motion",
        "platform.task-contract": "discovery.qualify_fit",
        "platform.task-contract-digest": "2d907019d3457d30af3158bc4ae8a8026b11c436725800fdbd676013d47158c0",
        "platform.risk": "low",
        "platform.human-gate": "false",
        "platform.budget-cents": "20",
        "platform.owner": "OWN-BUYER-BE"
      },
      "platform": {
        "skillKey": "discovery.qualify_fit",
        "version": "1.0.0",
        "packType": "growth_motion",
        "taskContractId": "discovery.qualify_fit",
        "taskContractDigest": "2d907019d3457d30af3158bc4ae8a8026b11c436725800fdbd676013d47158c0",
        "risk": "low",
        "humanGate": false,
        "budgetCents": 20,
        "owner": "OWN-BUYER-BE"
      }
    },
    "body": "# 候选公司资格判定\n\n输入：卖方 ICP 摘要（含目标贸易角色 `icp_trade_role`）与一家候选公司（名称、域名、\n国家、行业、产品/关键词、官网画像 website_profile）。\n\n输出：verdict（match / weak / mismatch）、四门结论（material_gate / role_gate /\nprocess_gate / business_model_gate）与具体理由数组。\n\n判定顺序：\n\n1. 材质门——候选的加工材质是否与 ICP 目标一致；ICP 未要求材质时视为通过。\n2. 角色门——候选是下游买家还是同类产品制造商（竞品判 mismatch）。\n3. 工艺子集门——候选是否真正从事 ICP 核心工艺，仅相邻工艺判 weak。\n4. 商业模式门——分销商 ICP 下，转售型分销/批发/进口/经销判 pass，撮合平台判 weak。\n\n任一硬门失败判 mismatch；边缘/相邻判 weak；全部通过判 match。只依据给定信息，\n理由必须具体。模型拒答不是证据不足，按 fail-safe 转人工复核（weak），绝不自动拒绝。",
    "sourceDigest": "ccb318ee9bc6993782346628d7daed857bc1039cf1396c0daa9121c427c0925a"
  }
];
