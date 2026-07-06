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
};

export function getTask(id: string): AiTaskContract | undefined {
  return AI_TASKS[id];
}
