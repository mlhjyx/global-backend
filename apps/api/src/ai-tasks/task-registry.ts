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
            required: ['type', 'statement', 'confidence'],
            properties: {
              type: { type: 'string', description: 'capability | certification | case | param | value_prop' },
              statement: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    },
    // 业务需求：抽取偏中文语境 + 性价比 → DeepSeek。
    // 在中转站里可把 'deepseek-chat' 配成带 fallback 的模型组（挂了自动切火山/GPT）。
    model: 'deepseek-chat',
    risk: 'medium',
    humanGate: true, // Claims land as NEEDS_REVIEW; approval before outbound use.
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
    model: 'deepseek-chat',
    risk: 'medium',
    humanGate: true, // ICP 生成后为 HYPOTHESIS，回测/人工确认后才 ACTIVE。
  },
};

export function getTask(id: string): AiTaskContract | undefined {
  return AI_TASKS[id];
}
