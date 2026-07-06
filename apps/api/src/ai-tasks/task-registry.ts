import { AiTaskContract } from './task-contract';

/**
 * Registry of domain AI Tasks (PRD 9.3 catalog). Each new task in the AI 获客
 * spine — market research, ICP design, lead research, lead qualification, intent
 * triage… — registers its contract here and is orchestrated by a workflow.
 */
export const AI_TASKS: Record<string, AiTaskContract> = {
  'company_understanding.extract_claims': {
    id: 'company_understanding.extract_claims',
    description: '从企业官网/文档文本中抽取带类型与置信度的企业事实（Claim）',
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
              type: { type: 'string', description: 'capability | certification | case | param | value_prop' },
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

  'company_understanding.extract_offerings': {
    id: 'company_understanding.extract_offerings',
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

  'discovery.query_plan': {
    id: 'discovery.query_plan',
    description:
      '把 ICP 翻译成多数据源可执行的查询计划（LED-005）。针对 PRD 7.4.7 的七类 Provider（trade_data / b2b_company_person / company_registry / contact_discovery / email_verification / public_intelligence / industry_data）生成有序查询：不是同时调用全部，而是按 ICP 的行业与市场特征挑选 2-4 类最相关的源。发现类源在前；contact_discovery/email_verification 属后续补全阶段，不出现在发现计划里。',
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
                description: '结构化过滤条件（industry/region/country/employee_count/hs_code 等）',
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
