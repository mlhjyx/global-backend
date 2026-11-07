// GENERATED FILE — do not edit by hand.
// Source: apps/api/src/skills/packs/content/**/pack.json + PACK.md
// Regenerate: pnpm packs:generate   Verify: pnpm packs:validate
import type { BuiltinPackRecord } from "../load-builtin-packs";

export const BUILTIN_PACKS: readonly BuiltinPackRecord[] =
[
  {
    "packKey": "compliance.eu_dual_use_screen",
    "packType": "compliance",
    "directory": "eu_dual_use_screen",
    "manifest": {
      "packKey": "compliance.eu_dual_use_screen",
      "packType": "compliance",
      "version": "1.0.0",
      "title": "欧盟双用途/出口管制复核",
      "description": "面向欧盟市场的出口管制与个人数据最小化护栏：对外材料需人工复核，研究输出不落个人联系方式。",
      "priorityClass": "compliance",
      "tags": {
        "markets": [
          "EU"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "Proprietary",
      "contentPath": "PACK.md",
      "rules": [
        {
          "id": "dual-use-export-review",
          "effect": "require_approval",
          "appliesTo": {
            "phases": [
              "create"
            ]
          },
          "rationale": "涉及双用途物项（Regulation (EU) 2021/821 附件 I）的对外材料与报价建议必须人工复核后方可使用。",
          "sources": [
            {
              "label": "Regulation (EU) 2021/821 (dual-use export controls)",
              "url": "https://eur-lex.europa.eu/eli/reg/2021/821/oj"
            }
          ]
        },
        {
          "id": "no-outreach-to-listed-parties",
          "effect": "forbid",
          "appliesTo": {
            "phases": [
              "create",
              "engage"
            ]
          },
          "condition": {
            "field": "sanctions.status",
            "op": "eq",
            "value": "potential_match"
          },
          "rationale": "制裁名单潜在命中对象不得进入任何对外触达或材料生成动作。",
          "sources": [
            {
              "label": "Platform sanctions screening policy (internal)"
            }
          ]
        },
        {
          "id": "mask-personal-contacts",
          "effect": "mask",
          "appliesTo": {
            "phases": [
              "research"
            ],
            "skills": [
              "research.account_research"
            ]
          },
          "rationale": "研究输出只保留公开职业信息；个人邮箱/电话等联系方式不得出现在研究简报中。",
          "sources": [
            {
              "label": "OWNER-DECISION personal data minimization (internal)"
            }
          ]
        }
      ],
      "sources": [
        {
          "label": "Regulation (EU) 2021/821",
          "url": "https://eur-lex.europa.eu/eli/reg/2021/821/oj",
          "retrievedAt": "2026-11-08"
        }
      ],
      "exitPlan": "S1 Golden Set 未通过、规则被法务否定或 180 天未参与任何解析则下架归档。"
    },
    "content": "# 欧盟双用途/出口管制复核（合规包）\n\n适用：面向欧盟市场的获客与报价建议（L1），以及研究类技能的输出。\n\n## 硬约束（按优先级）\n\n1. **双用途物项对外材料需人工复核**：凡涉及 Regulation (EU) 2021/821 附件 I 所列物项（含技术资料、参数表、报价建议）的对外使用，必须先经人工确认；系统只产草稿与证据，不产对外单据。\n2. **制裁潜在命中禁止触达**：`sanctions.status == potential_match` 的对象不得进入 create/engage 阶段动作；命中未清白前只能内部复核。\n3. **个人数据最小化**：研究简报只保留公开职业信息（姓名职务所在公司），不得输出个人邮箱/电话；需要联系时先走合规评审。\n\n## 证据要求\n\n- 每条结论附来源（URL 或内部记录 id）与检索日期。\n- 无法核验的维度写 \"未验证\"，不得推断。\n- 触达前必须过制裁筛查与禁联名单；本包不改变 ToolBroker 白名单与审批链，只提供策略约束。",
    "manifestDigest": "3e7f487d856bc5cc041aa2a6ee585702cd83da33b8a11f7dc24675dfe89230ec",
    "contentDigest": "e15375944cac7cecae2b55b7cc3a14271bb86baae0dcd8fd17dadd638f690a04",
    "sourceDigest": "8f88be269f00f90782e933887c9b0957b105f63332a90b99c8ded23f4095f02a"
  },
  {
    "packKey": "data_source.public_web_only",
    "packType": "data_source",
    "directory": "public_web_only",
    "manifest": {
      "packKey": "data_source.public_web_only",
      "packType": "data_source",
      "version": "1.0.0",
      "title": "公开网页与官方名录数据源边界",
      "description": "声明 S1 技能可用的数据源与用途：自托管搜索/抓取与受 source_policy 治理的官方名录；不引入付费源。",
      "priorityClass": "channel_data_content_expert",
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "Proprietary",
      "contentPath": "PACK.md",
      "rules": [
        {
          "id": "ds-searxng",
          "category": "search",
          "allowedUse": [
            "discovery",
            "research"
          ],
          "license": "self-hosted",
          "piiClass": "public_organization",
          "rateLimit": {
            "rps": 2
          },
          "approval": "none",
          "sourceId": "searxng.search"
        },
        {
          "id": "ds-crawl4ai",
          "category": "web_fetch",
          "allowedUse": [
            "research",
            "enrichment"
          ],
          "license": "self-hosted",
          "piiClass": "personal_data",
          "rateLimit": {
            "perDomainDelayMs": 2000
          },
          "approval": "none",
          "sourceId": "crawl4ai.fetch"
        },
        {
          "id": "ds-governed-directories",
          "category": "directory",
          "allowedUse": [
            "discovery"
          ],
          "license": "per-site policy",
          "piiClass": "public_organization",
          "approval": "ops",
          "sourceId": "source_policy.directories"
        }
      ],
      "sources": [
        {
          "label": "ToolBroker tool catalog (internal)",
          "retrievedAt": "2026-11-08"
        },
        {
          "label": "SearXNG documentation",
          "url": "https://docs.searxng.org/",
          "retrievedAt": "2026-11-08"
        }
      ],
      "exitPlan": "数据源策略变更（新源引入或付费源决策）时整体复审；180 天未使用则归档。"
    },
    "content": "# 公开网页与官方名录数据源边界（数据源包）\n\n本包只**声明允许的数据源与用途**；真正执行仍由 ToolBroker、`source_policy`、预算与限流强制。\n\n## 允许的数据源\n\n| 源 | 用途 | 个人数据类 | 备注 |\n| --- | --- | --- | --- |\n| searxng.search（自托管） | discovery / research | 公开组织信息 | 走平台限流；不用付费搜索 API |\n| crawl4ai.fetch（自托管） | research / enrichment | 页面可能含个人数据 | robots 与域策略强制；同域礼貌间隔 |\n| source_policy 管理的官方名录 | discovery | 公开组织信息 | 新域名必须先在 source_policy 登记并经运营批准 |\n\n## 禁止\n\n- 不在本包内新增任何源；白名单之外的源一律拒绝。\n- 不绕过 robots、不批量抓取、不做登录态抓取。\n- 付费数据源（海关/流量/信用等）不在 S1；如引入需单独决策。\n- 抓取结果中出现的个人联系方式只用于合规复核，不得进入研究输出（见合规包）。",
    "manifestDigest": "477c511e1318441c45e66e6bc8e03804ffe321bb9d713b546a02d0f6521c0d73",
    "contentDigest": "925343ac36ae9674d1c3d7052b62a375d13c56ce35eedc4ae3cc62cd045c6ae4",
    "sourceDigest": "99bc4c57041784b1e0ff28557f82d0ab38dccb1f5996c4474e33b8ac95f69790"
  },
  {
    "packKey": "growth_motion.competitive_intelligence",
    "packType": "growth_motion",
    "directory": "competitive_intelligence",
    "manifest": {
      "packKey": "growth_motion.competitive_intelligence",
      "packType": "growth_motion",
      "version": "1.0.0",
      "title": "竞争情报检查单（内容包）",
      "description": "面向获客的竞争者与赢单/输单复盘检查单；去营销化摘要，不执行、不发送。",
      "priorityClass": "growth_motion",
      "tags": {
        "motions": [
          "competitive_intelligence"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "Apache-2.0",
      "notice": "Derived summary of anthropics/knowledge-work-plugins skill competitive-intelligence (Apache-2.0, commit e050c2ec856373787143d7057663a6ebd1277df3). Rewritten in our own words; connector chat semantics and promotion removed; content only, never executed.",
      "contentPath": "PACK.md",
      "rules": [],
      "sources": [
        {
          "label": "anthropics/knowledge-work-plugins competitive-intelligence (snapshot in docs/governance/third-party-skills)",
          "url": "https://github.com/anthropics/knowledge-work-plugins",
          "retrievedAt": "2026-11-06"
        }
      ],
      "exitPlan": "Golden Set 未通过或 180 天未参与任何解析则下架归档。"
    },
    "content": "# 竞争情报检查单（内容包）\n\n用途：为某条线索/某次成单机会补充竞争格局判断；只作策略提示，不执行任何动作。\n\n## 检查单\n\n1. **对手识别**：客户可能比较的替代方案（同类制造商/分销商/平台）；只写可核实公司与产品，不臆造份额。\n2. **定位差异**：从公开资料提取对方的交付周期、认证、最小起订量；与自家产品对比，未知写 \"未验证\"。\n3. **证据链**：每个判断给来源（官网/公告/公开名录）与日期；不引用付费数据库或内部名单。\n4. **赢单/输单复盘**（有历史时）：记录客户最终选择、决定因素、我方差距；只陈述事实与客户原话。\n5. **输出边界**：不生成对外比较材料或贬损竞品的内容；对外使用前人工审阅。\n\n## 禁止\n\n- 不使用爬虫绕过访问控制的竞品资料；不抓取个人社媒。\n- 不编造份额、营收、客户名；无法核实的维度明确标注。",
    "manifestDigest": "8e2024b1516ed21efcdb36e9743370f906bd9965e2d313a59a6efcf701db244c",
    "contentDigest": "0eaa26a505fbd16150348538b749cbb43e309dac2eb700adcc63e25d38200c32",
    "sourceDigest": "465fecf022c3a1222278a4f576bb1e73a6631441c8d1ed7fa4331e725caf85c8"
  },
  {
    "packKey": "growth_motion.customer_research",
    "packType": "growth_motion",
    "directory": "customer_research",
    "manifest": {
      "packKey": "growth_motion.customer_research",
      "packType": "growth_motion",
      "version": "1.0.0",
      "title": "客户研究检查单（内容包）",
      "description": "买家公司研究与需求假设的检查单；去营销化摘要，要求来源与不确定性标注。",
      "priorityClass": "growth_motion",
      "tags": {
        "motions": [
          "customer_research"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "MIT",
      "notice": "Derived summary of coreyhaines31/marketingskills skill customer-research (MIT, commit 96798cf38736ecdba015a1d2b0521b0c8f8f41dd). Rewritten in our own words; vendor integrations, sponsor marks and paid-newsletter links removed; content only, never executed.",
      "contentPath": "PACK.md",
      "rules": [],
      "sources": [
        {
          "label": "coreyhaines31/marketingskills customer-research (snapshot in docs/governance/third-party-skills)",
          "url": "https://github.com/coreyhaines31/marketingskills",
          "retrievedAt": "2026-11-06"
        }
      ],
      "exitPlan": "Golden Set 未通过或 180 天未参与任何解析则下架归档。"
    },
    "content": "# 客户研究检查单（内容包）\n\n用途：在触达前形成对一个买家公司的最小可信画像；只作策略提示，不执行动作。\n\n## 检查单\n\n1. **公司与业务**：主营、产品线、站点/规模（仅公开来源）；同名公司不得混用。\n2. **需求假设**：结合卖家的产品与目标市场，列出 2–3 个\"可能的需求\"并标注依据；未验证的假设必须明示。\n3. **采购角色**：决策人/影响者/使用者；只写公开职业信息，不留个人联系方式。\n4. **触发信号**：扩张、上新线、招标、展会等公开信号，附来源与日期。\n5. **不确定性与缺口**：列 \"未查询 / 未验证 / 空白\" 三种状态，分别说明下一步怎么补齐。\n\n## 禁止\n\n- 不推断敏感属性（健康、宗教、政治等）。\n- 不编造营收、员工数、采购量；不用付费数据源结果冒充公开事实。",
    "manifestDigest": "d94f071b357eb91aa6748d5e9644df9455742dcca3a757eba178585663b6dff4",
    "contentDigest": "ad1cd1911bc41fd153d11fb52793cae63c3ab37daabcb349312bc821031d03ab",
    "sourceDigest": "eedf2d4401c3ed4e48fd718831030aa6ccbe1f7dda7e05c71ef61818ece56735"
  },
  {
    "packKey": "growth_motion.dach_distributor",
    "packType": "growth_motion",
    "directory": "dach_distributor",
    "manifest": {
      "packKey": "growth_motion.dach_distributor",
      "packType": "growth_motion",
      "version": "1.0.0",
      "title": "DACH 分销商获客动作包",
      "description": "面向德国/奥地利/瑞士工业分销商的获客检查单：Impressum 分销声明、在售品牌、德语检索与决策人角色。",
      "priorityClass": "growth_motion",
      "tags": {
        "markets": [
          "DE",
          "AT",
          "CH"
        ],
        "motions": [
          "distributor_discovery"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "Proprietary",
      "contentPath": "PACK.md",
      "rules": [
        {
          "id": "dach-distributor-playbook",
          "motion": "distributor_discovery",
          "stage": "qualify",
          "playbook": [
            {
              "step": "核实分销身份",
              "guidance": "读 Impressum/关于页：是否明确写着 Vertrieb/Handel/Großhandel 或列出在售第三方品牌；只有制造声明而无所售品牌时先判 weak。"
            },
            {
              "step": "确认下游买家角色",
              "guidance": "分销商采购同类产品用于转售即下游买家；撮合平台、目录站、纯服务商判 weak/mismatch。"
            },
            {
              "step": "本地化检索",
              "guidance": "关键词用德语（如 Zulieferer、Großhandel、Vertriebspartner），并限定 DE/AT/CH 区域。"
            },
            {
              "step": "决策人线索",
              "guidance": "优先 Geschäftsführer、Head of Procurement/Einkauf；只记录页面明确出现的具名人员。"
            }
          ],
          "kpis": [
            "深判通过率（match / 判定总数）",
            "分销商 ICP 的首次回复率"
          ],
          "guardrails": [
            "robots 不允许的页面不抓",
            "不对名单对象触达（见合规包）",
            "任何发送动作走人工审批（S1 不发送）"
          ]
        }
      ],
      "sources": [
        {
          "label": "Platform acquisition playbook (internal)",
          "retrievedAt": "2026-11-08"
        }
      ],
      "exitPlan": "市场优先级调整或深判通过率连续两季下降时复审；180 天未使用则归档。"
    },
    "content": "# DACH 分销商获客动作包\n\n适用：目标市场为德国/奥地利/瑞士的工业品类分销商获客（Understand → Discover → Qualify）。\n\n## 动作检查单\n\n1. **分销身份证据**（Impressum/关于页原文）：Vertrieb / Handel / Großhandel / 在售第三方品牌列表；进口商常带中国品牌。\n2. **贸易角色判定**：转售型分销/批发/进口/经销 = 下游买家；制造商 = 竞品（mismatch）；撮合平台 = weak。\n3. **德语检索**：Zulieferer、Großhandel、Vertriebspartner、Handelsvertretung；区域限定 DE/AT/CH。\n4. **决策人**：Geschäftsführer（总经理）、Einkauf（采购）、Technische Leitung（技术）；只取页面明确出现的具名人员，不猜邮箱。\n5. **触达前检查**：制裁筛查 clear、禁联名单未命中、个人数据最小化（合规包）；S1 不发送任何外部消息。\n\n## 衡量\n\n- 主指标：深判通过率（match / 判定总数），不降于基线。\n- 辅指标：分销商 ICP 的首次回复率（M3 后才有真实发送数据）。\n- 记录每步证据与来源，无法核验写 \"未验证\"。",
    "manifestDigest": "36232616961c9d2106bb4cee4722730be59f5d2e3fbe218d73f26e497966acd3",
    "contentDigest": "3ed1c1de55777674fc7677e8ca74e88812f9e44e8e22431e3801a856bb7e1c2f",
    "sourceDigest": "8e463a158a18894b9508a807fcc6a072af53731da2efe56771994bea22b8311f"
  },
  {
    "packKey": "growth_motion.pricing",
    "packType": "growth_motion",
    "directory": "pricing",
    "manifest": {
      "packKey": "growth_motion.pricing",
      "packType": "growth_motion",
      "version": "1.0.0",
      "title": "定价与报价检查单（内容包）",
      "description": "报价建议的检查单：成本可追溯、汇率显式、条款边界清晰；只作 L1 建议，不产对外单据。",
      "priorityClass": "growth_motion",
      "tags": {
        "motions": [
          "pricing"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "MIT",
      "notice": "Derived summary of coreyhaines31/marketingskills skill pricing (MIT, commit 96798cf38736ecdba015a1d2b0521b0c8f8f41dd). Rewritten in our own words; vendor integrations, sponsor marks and paid-newsletter links removed; content only, never executed.",
      "contentPath": "PACK.md",
      "rules": [],
      "sources": [
        {
          "label": "coreyhaines31/marketingskills pricing (snapshot in docs/governance/third-party-skills)",
          "url": "https://github.com/coreyhaines31/marketingskills",
          "retrievedAt": "2026-11-06"
        }
      ],
      "exitPlan": "Golden Set 未通过或 180 天未参与任何解析则下架归档。"
    },
    "content": "# 定价与报价检查单（内容包）\n\n用途：配合 `quoting.incoterms_quote`（L1）形成报价建议；只作建议与证据，不产 PI/CI/PL 等对外单据。\n\n## 检查单\n\n1. **成本可追溯**：货值、包装、内陆运费、海运/空运、保险、关税逐项列出；每一项注明来源或假设。\n2. **Incoterms 边界**：EXW/FOB/CFR/CIF/DDP 的责任与费用分界明确；所选术语与目的国一致。\n3. **汇率显式**：报价币与成本币不同时，必须提供汇率与取数日期；不查外部牌价、不猜汇率。\n4. **毛利与底线**：给出加成与最低毛利；低于底线时明确拒绝建议而不是硬算。\n5. **合规**：出口管制/制裁复核（见合规包）；报价建议不代表正式要约，对外须人工确认与法务模板。\n\n## 禁止\n\n- 不生成对外单据、不发送、不承诺交期/库存。\n- 不做税务或法律意见；DDP 关税仅按输入估算并标注假设。",
    "manifestDigest": "6e8042b7dde98f0b3f6debc6375a2273fae428e31ca7280ae437650b8351fb9b",
    "contentDigest": "02c510c80023618230061ef3e7e3956a70787b0d2a318128ce2e96b0ec820264",
    "sourceDigest": "4d3e6eaabe54e0f16214b163aae167601d41bb493a013b4c95e14b61c3d34365"
  },
  {
    "packKey": "industry.metal_fabrication",
    "packType": "industry",
    "directory": "metal_fabrication",
    "manifest": {
      "packKey": "industry.metal_fabrication",
      "packType": "industry",
      "version": "1.0.0",
      "title": "金属加工行业词表与买家角色",
      "description": "金属加工/钣金/机加工行业的分类码、术语与买家角色，用于检索词归一与买家公司属性理解。",
      "priorityClass": "industry",
      "tags": {
        "industries": [
          "metal_fabrication"
        ],
        "markets": [
          "DE",
          "AT",
          "CH",
          "CN"
        ]
      },
      "owner": "产品负责人 + 平台工程（本工作区）",
      "license": "Proprietary",
      "contentPath": "PACK.md",
      "rules": [
        {
          "id": "metal-fabrication-taxonomy",
          "taxonomy": {
            "scheme": "ISIC Rev.4",
            "codes": [
              "C25",
              "C28"
            ]
          },
          "buyerRoles": [
            "Geschäftsführer / Managing Director",
            "Head of Production / Fertigungsleitung",
            "Procurement / Einkauf",
            "Technical Director / Technische Leitung"
          ],
          "terminology": [
            "Lohnfertigung",
            "Blechbearbeitung",
            "CNC-Fräsen",
            "Laserschneiden",
            "Schweißen",
            "Metallverarbeitung"
          ],
          "regulations": [
            {
              "jurisdiction": "DE",
              "note": "Impressum 法定要求（§5 DDG）——抽取决策人优先来源。"
            }
          ]
        }
      ],
      "sources": [
        {
          "label": "UN ISIC Rev.4 classification",
          "url": "https://unstats.un.org/unsd/classifications/Econ/isic",
          "retrievedAt": "2026-11-08"
        }
      ],
      "exitPlan": "行业覆盖调整时并入新行业包；180 天未参与任何解析则归档。"
    },
    "content": "# 金属加工行业词表与买家角色\n\n适用：金属加工、钣金、机加工品类的卖家获客（检索词归一、买家公司理解、买家角色匹配）。\n\n## 分类与术语\n\n- ISIC Rev.4：C25（金属制品）、C28（机械设备）。\n- 德语核心术语：Lohnfertigung（来料加工）、Blechbearbeitung（钣金加工）、CNC-Fräsen（数控铣削）、Laserschneiden（激光切割）、Schweißen（焊接）、Metallverarbeitung（金属加工）。\n\n## 买家角色\n\n1. Geschäftsführer / Managing Director（总经理，决策人）\n2. Head of Production / Fertigungsleitung（生产技术负责人）\n3. Procurement / Einkauf（采购）\n4. Technical Director / Technische Leitung（技术负责人）\n\n## 合规提示\n\n- 德国 Impressum 依法列明负责人，是决策人抽取的首选公开来源；只记录页面明确出现的信息。\n- 行业术语用于检索与判定，不臆造公司属性；无法核验写 \"未验证\"。",
    "manifestDigest": "68f1f900734efa403e1454c10c8898b418244873c840bb8ba824a8527ab90b85",
    "contentDigest": "f97d0682a52960d234a0dac60bf9c8c58aaf639fb1f3f3202dfc95b119616114",
    "sourceDigest": "713293842b3d4feaa719dd4016e8e97b0c3e69e0a6f55068730e89609ff36e6e"
  }
];
