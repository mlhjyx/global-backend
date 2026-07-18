import type { ModelExecutionTrace } from '@global/contracts';

/** Context threaded into every model call — for routing, tenancy, cost, trace. */
export interface AiContext {
  /** 必须是真实 workspace uuid（ai_trace/usage_ledger @db.Uuid 列；伪值=记账静默失败）。 */
  workspaceId: string;
  userId?: string;
  /** 预算归账键（BudgetLedger reserve-then-settle 按 runId ?? workspaceId 归账）。 */
  runId?: string;
  correlationId?: string;
  /** Optional Site Builder policy evidence; copied to every gateway trace row. */
  modelPolicy?: ModelExecutionTrace;
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
  /** reasoning 模型的思考预算（OpenAI 兼容 reasoning_effort）。copy 类任务 🔴 必配 low（02 §6）。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Per-call ceiling from the resolved task policy; takes precedence over legacy registry defaults. */
  maxCostCents?: number;
  /** 调用方超时/取消信号，透传到底层 fetch——超时即真 abort，不留后台弃单继续烧钱。 */
  signal?: AbortSignal;
}

export interface GenerateStructuredInput {
  task: string;
  prompt: string;
  system?: string;
  model?: string;
  schema: Record<string, unknown>; // JSON Schema the output must satisfy
  /**
   * Optional task-level deterministic output gate. The router executes it after
   * schema validation/repair but before recording an OK trace, so a rejected
   * artifact remains an observable, billable failed attempt.
   */
  validateOutput?: (data: unknown) => void;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Per-call ceiling from the resolved task policy; takes precedence over legacy registry defaults. */
  maxCostCents?: number;
  /** 调用方超时/取消信号，透传到底层 fetch（含网关内修复重试的两次调用）。 */
  signal?: AbortSignal;
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
