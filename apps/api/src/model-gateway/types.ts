/** Context threaded into every model call — for routing, tenancy, cost, trace. */
export interface AiContext {
  /** 必须是真实 workspace uuid（ai_trace/usage_ledger @db.Uuid 列；伪值=记账静默失败）。 */
  workspaceId: string;
  userId?: string;
  /** 预算归账键（BudgetLedger reserve-then-settle 按 runId ?? workspaceId 归账）。 */
  runId?: string;
  correlationId?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ModelResult<T> {
  data: T;
  provider: string; // which provider served it
  model: string;
  usage?: ModelUsage;
  /** 本次结果实际发生的模型调用数（generateStructured 校验-修复重试=2；缺省视为 1）——
   *  供**无 usage 上报**时按调用数结算预算，防修复调用被少记（否则退还预留的另一半，硬上界形同虚设）。 */
  callCount?: number;
}

export interface GenerateTextInput {
  task: string; // task id (trace/routing key), e.g. 'company_understanding.extract_claims'
  prompt: string;
  system?: string;
  model?: string; // model name for the 中转站 to resolve; omit → provider default
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateStructuredInput {
  task: string;
  prompt: string;
  system?: string;
  model?: string;
  schema: Record<string, unknown>; // JSON Schema the output must satisfy
  maxTokens?: number;
}

export interface EmbedInput {
  task: string;
  input: string[];
}

export type ModelOp = 'generateText' | 'generateStructured' | 'embed';

export interface HealthStatus {
  healthy: boolean;
  detail?: string;
}
