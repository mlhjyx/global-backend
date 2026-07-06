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
      '基于卖方企业的已确认事实(Claim)，设计理想客户画像(ICP)：目标公司属性、痛点、采购触发信号、排除条件、价值主张、目标市场，以及买家委员会角色。',
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
      },
    },
    // ICP 设计是低频、策略推理任务 → 用更强的 pro。
    model: 'deepseek-v4-pro',
    risk: 'medium',
    humanGate: true, // ICP 生成后为 HYPOTHESIS，回测/人工确认后才 ACTIVE。
  },
};

export function getTask(id: string): AiTaskContract | undefined {
  return AI_TASKS[id];
}
