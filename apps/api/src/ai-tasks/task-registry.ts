import { AiTaskContract } from './task-contract';

/**
 * Registry of domain AI Tasks (PRD 9.3 catalog). Each new task in the AI 获客
 * spine — market research, ICP design, lead research, lead qualification, intent
 * triage… — registers its contract here and is orchestrated by a workflow.
 */
export const AI_TASKS: Record<string, AiTaskContract> = {
  'company_understanding.extract_claims': {
    id: 'company_understanding.extract_claims',
    allowedTools: [], // 纯生成：只读给定文本，工具（抓取）由确定性 Provider 调用
    maxCostCents: 20,
    timeoutMs: 180000,
    description:
      '从企业官网/文档文本中抽取带类型与置信度的企业事实（Claim）。覆盖 KNW-002 全范围：能力、认证、案例、参数、MOQ、交期、市场、企业基本面；发现营销性/绝对化表述时输出 forbidden_expression_candidate 供品牌审核。只抽文本中明确存在的信息。',
    outputSchema: {
      type: 'object',
      required: ['claims'],
      properties: {
        claims: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type', 'statement', 'evidence', 'confidence'],
            properties: {
              type: {
                type: 'string',
                description:
                  'capability | certification | case | param | moq | lead_time | market | company_fact | value_prop | forbidden_expression_candidate',
              },
              statement: { type: 'string' },
              evidence: { type: 'string', description: '来源文本中支持该结论的原文片段（用于溯源，必须来自给定文本）' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    },
    // 抽取是高频、结构化任务 → 用快而省的 flash（中转站里可配成带 fallback 的模型组）。
    model: 'deepseek-v4-flash',
    risk: 'medium',
    humanGate: true, // Claims land as NEEDS_REVIEW; approval before outbound use.
  },

  'company_understanding.extract_profile': {
    id: 'company_understanding.extract_profile',
    allowedTools: [],
    maxCostCents: 10,
    timeoutMs: 120000,
    description:
      '从企业官网首页文本提炼企业画像：行业归类与一段话简介（中文，仅基于给定文本，不得编造规模/年份等未出现的信息）。',
    outputSchema: {
      type: 'object',
      required: ['industry', 'summary'],
      properties: {
        industry: { type: 'string', description: '主行业，如「精密金属加工设备制造」' },
        summary: { type: 'string', description: '80-150 字中文简介' },
      },
    },
    model: 'deepseek-v4-flash',
    risk: 'low',
    humanGate: false, // 画像随 Claim 审批可被人工修正
  },

  'company_understanding.extract_offerings': {
    id: 'company_understanding.extract_offerings',
    allowedTools: [],
    maxCostCents: 20,
    timeoutMs: 180000,
    description:
      '从企业官网页面文本中抽取结构化的产品/服务（Offering）：名称、简述、关键属性（MOQ/交期/参数/认证/材料等，仅当文本中明确出现时才填），并附来源原文片段。禁止编造文本中不存在的属性。',
    outputSchema: {
      type: 'object',
      required: ['offerings'],
      properties: {
        offerings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'description', 'evidence', 'confidence'],
            properties: {
              name: { type: 'string', description: '产品/服务名（保留原文语言）' },
              description: { type: 'string', description: '一句话简述' },
              attributes: {
                type: 'object',
                description: '仅收录文本中明确出现的属性，如 moq/lead_time/materials/params/certifications',
              },
              evidence: { type: 'string', description: '来源文本中支持该产品存在的原文片段' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    },
    // 与 Claim 抽取同为高频结构化任务 → flash。
    model: 'deepseek-v4-flash',
    risk: 'low', // 只进结构化知识库，不直接对外
    humanGate: false,
  },

  'icp.design': {
    id: 'icp.design',
    allowedTools: [],
    maxCostCents: 40,
    timeoutMs: 180000,
    description:
      '基于卖方企业的已确认事实(Claim)，设计理想客户画像(ICP)：目标公司属性、痛点、采购触发信号、排除条件、价值主张、目标市场、买家委员会角色，以及机器可评估的验证规则(qualification_rules)。规则的 field 使用规范属性名：industry/sub_industry/region/country/employee_count/revenue/certifications/keywords/tech/business_model/end_markets。',
    outputSchema: {
      type: 'object',
      required: [
        'name',
        'company_attributes',
        'pain_points',
        'trigger_signals',
        'exclusions',
        'value_props',
        'target_markets',
        'personas',
        'buying_committee',
        'qualification_rules',
      ],
      properties: {
        name: { type: 'string', description: 'ICP 名称，如「欧洲中型汽车零部件制造商」' },
        company_attributes: { type: 'object', description: '目标公司属性：行业/规模/地区/技术等' },
        pain_points: { type: 'array', items: { type: 'string' } },
        trigger_signals: { type: 'array', items: { type: 'string' }, description: '采购触发信号' },
        exclusions: { type: 'array', items: { type: 'string' }, description: '排除条件' },
        value_props: { type: 'array', items: { type: 'string' } },
        target_markets: { type: 'array', items: { type: 'string' } },
        personas: {
          type: 'array',
          items: {
            type: 'object',
            required: ['title', 'goals', 'pain_points'],
            properties: {
              title: { type: 'string' },
              goals: { type: 'array', items: { type: 'string' } },
              pain_points: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        buying_committee: {
          type: 'array',
          items: {
            type: 'object',
            required: ['role', 'title', 'concerns'],
            properties: {
              role: {
                type: 'string',
                description: 'decision_maker | influencer | user | technical | finance | procurement',
              },
              title: { type: 'string' },
              concerns: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        qualification_rules: {
          type: 'array',
          description:
            '机器可评估的验证规则（LED-003）。每条规则针对一个候选公司属性做确定性判断；EXCLUSION 优先于一切正向评分。',
          items: {
            type: 'object',
            required: ['kind', 'field', 'operator', 'value', 'rationale'],
            properties: {
              kind: { type: 'string', description: 'MUST_HAVE | NICE_TO_HAVE | EXCLUSION' },
              field: {
                type: 'string',
                description:
                  '规范属性名：industry/sub_industry/region/country/employee_count/revenue/certifications/keywords/tech/business_model/end_markets',
              },
              operator: {
                type: 'string',
                description: 'eq | neq | in | not_in | contains | not_contains | gte | lte | matches',
              },
              value: { description: '操作数：标量或数组' },
              weight: { type: 'number', description: 'NICE_TO_HAVE 权重，默认 1' },
              rationale: { type: 'string', description: '该规则依据哪条企业事实/推理，保持推断透明' },
            },
          },
        },
      },
    },
    // ICP 设计是低频、策略推理任务 → 用更强的 pro。
    model: 'deepseek-v4-pro',
    risk: 'medium',
    humanGate: true, // ICP 生成后为 HYPOTHESIS，回测/人工确认后才 ACTIVE。
  },

  'discovery.extract_company': {
    id: 'discovery.extract_company',
    allowedTools: [], // 判站+抽取只读已抓文本；搜索/抓取由 PublicWebDiscoveryProvider 经 Broker 调用
    maxCostCents: 15,
    timeoutMs: 180000,
    description:
      '判断给定网页是否为一家真实企业的官网，若是则抽取结构化企业属性。只允许使用网页文本中明确出现的信息，禁止编造或从画像上下文照抄。若不是企业官网（是目录/百科/新闻/市场平台/博客），is_company_site 置 false。',
    outputSchema: {
      type: 'object',
      required: ['is_company_site'],
      properties: {
        is_company_site: { type: 'boolean', description: '该页面是否为某家企业自己的官网' },
        name: { type: 'string', description: '企业名称（原文语言）' },
        country: { type: 'string', description: '国家/地区（能从文本判断时）' },
        industry: { type: 'string', description: '行业（英文小写，如 metal fabrication）' },
        employee_count: { type: ['number', 'null'], description: '员工数（仅当文本明确出现）' },
        products: { type: 'array', items: { type: 'string' }, description: '主要产品/服务' },
        keywords: { type: 'array', items: { type: 'string' }, description: '能力/技术关键词' },
        evidence: { type: 'string', description: '支持判断的原文片段' },
        confidence: { type: 'number' },
      },
    },
    // 判站 + 抽取是高频任务，用户在中转站已接入 Gemini → 用 gemini-2.5-flash（快、长上下文、便宜）。
    model: 'gemini-2.5-flash',
    risk: 'low',
    humanGate: false,
  },

  'discovery.qualify_fit': {
    id: 'discovery.qualify_fit',
    allowedTools: [],
    maxCostCents: 20,
    timeoutMs: 180000,
    description:
      '给定卖方 ICP 与一家候选公司，判断它是否为该卖方的真实目标客户。必须通过四个门：\n1) 材质门：候选的加工材质是否与 ICP 目标一致（如金属 vs 塑料/织物/粉体）——注意 "RF welding"（射频热合塑料）≠ 金属焊接，"toll processing/筛分" 处理粉末≠金属工件加工。\n2) 角色门：候选是设备/产品的下游买家，还是与卖方同类的设备制造商（竞品）？竞品判 mismatch。\n3) 工艺子集门：候选是否真正从事 ICP 核心工艺，还是仅相邻工艺（如纯机加/磨削而无激光/钣金/折弯/焊接）。\n4) 商业模式门：候选是自有产线的制造商，还是聚合第三方供应商的采购中介平台？中介平台判 weak。\n任一硬门失败判 mismatch；边缘/相邻判 weak；全部通过判 match。只依据给定信息，理由需具体。',
    outputSchema: {
      type: 'object',
      required: ['verdict', 'material_gate', 'role_gate', 'process_gate', 'business_model_gate', 'reasons'],
      properties: {
        verdict: { type: 'string', description: 'match | weak | mismatch' },
        material_gate: { type: 'string', description: 'pass | fail | unclear + 一句依据' },
        role_gate: { type: 'string', description: 'pass(下游买家) | fail(竞品) | unclear' },
        process_gate: { type: 'string', description: 'pass(核心工艺) | weak(相邻工艺) | fail | unclear' },
        business_model_gate: { type: 'string', description: 'pass(自有产线) | weak(中介平台) | unclear' },
        reasons: { type: 'array', items: { type: 'string' }, description: '具体判定依据' },
      },
    },
    // 资格判别要准（评测显示 flash 召回过宽）→ 用 pro。
    model: 'gemini-2.5-pro',
    risk: 'low',
    humanGate: false,
  },

  'discovery.query_plan': {
    id: 'discovery.query_plan',
    allowedTools: [],
    maxCostCents: 40,
    timeoutMs: 180000,
    description:
      '把 ICP 翻译成多数据源可执行的查询计划（LED-005）。针对 PRD 7.4.7 的七类 source_class 生成有序查询：按 ICP 行业与市场特征挑选最相关的源，发现类在前（contact/email 验证属后续补全，不出现在此）。\n当前每个 source_class 下真实可用的子源（可用 filters.source_hint 精确路由，省略=该类全跑）：\n- public_intelligence → public_web（SearXNG 官网挖掘，关键词驱动）\n- company_registry → wikidata（结构化：按行业+国家零爬取查公司+官网+员工数）\n- industry_data → openstreetmap（地理：按工业标签+地区枚举工厂）、public_web\n结构化源需要规范的 filters：industry（行业词，中/英均可，如「金属加工」/"metal fabrication"）、country 或 region（如「德国」/"Germany"/"Baden-Württemberg"）。这些词会经规范词表映射到 Wikidata QID / OSM 标签。keywords 用于 public_web 全文搜索。',
    outputSchema: {
      type: 'object',
      required: ['queries', 'estimated_volume'],
      properties: {
        queries: {
          type: 'array',
          items: {
            type: 'object',
            required: ['source_class', 'filters', 'keywords', 'rationale', 'priority'],
            properties: {
              source_class: {
                type: 'string',
                description:
                  'trade_data | b2b_company_person | company_registry | public_intelligence | industry_data',
              },
              filters: {
                type: 'object',
                description:
                  '结构化过滤条件。发现类必备 industry + country/region（规范词表可映射的行业/国家词）；可选 source_hint（public_web|wikidata|openstreetmap）精确路由；可选 area_name/hs_code/cpv 等。',
              },
              keywords: { type: 'array', items: { type: 'string' }, description: '检索关键词（含本地语言变体）' },
              rationale: { type: 'string', description: '为什么选这个源、这些条件' },
              priority: { type: 'number', description: '执行顺序，1 最先（低成本源在前，PRD 7.4.8）' },
            },
          },
        },
        estimated_volume: { type: 'number', description: '预计候选公司量级' },
      },
    },
    // 计划生成是低频推理任务 → pro。
    model: 'deepseek-v4-pro',
    risk: 'low', // 只产出计划，执行前还有成本 Dry Run 与人工确认
    humanGate: true,
  },
};

export function getTask(id: string): AiTaskContract | undefined {
  return AI_TASKS[id];
}
