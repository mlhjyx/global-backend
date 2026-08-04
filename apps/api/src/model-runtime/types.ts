export type JsonSchema = Readonly<Record<string, unknown>>;

export type ModelProtocol =
  | 'openai_responses'
  | 'openai_chat_completions'
  | 'anthropic_messages'
  | 'google_native';
export type ReasoningLevel = 'none' | 'low' | 'medium' | 'high' | 'max';

export interface ContextPolicy {
  version: string;
  allowedSourceRefs: readonly string[];
}

export interface CapabilityRequirements {
  protocols?: readonly ModelProtocol[];
  structuredOutput?: boolean;
  structuredOutputDialect?: string;
  minimumContextWindow?: number;
  minimumOutputTokens?: number;
  reasoning?: ReasoningLevel;
  nativeCache?: boolean;
  tools?: boolean;
  vision?: boolean;
  reportsUsage?: boolean;
  reportsModel?: boolean;
  reportsRequestId?: boolean;
  settlementRequired?: boolean;
}

export interface ReasoningPolicy {
  allowed: readonly ReasoningLevel[];
  default: ReasoningLevel;
  reserveTokens: number;
}

export interface CachePolicy {
  mode: 'disabled' | 'exact' | 'build-run-replay';
}

export interface RetryPolicy {
  transportMaxAttempts: number;
  contentRepairMaxAttempts: number;
  transportBackoff?: {
    baseDelayMs: number;
    maximumDelayMs: number;
    jitterRatio: number;
  };
}

export interface TaskModelContract<Input, Output> {
  taskId: string;
  version: string;
  executionMode: 'deterministic' | 'generative';
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  contextPolicy: ContextPolicy;
  capabilityRequirements: CapabilityRequirements;
  reasoningPolicy: ReasoningPolicy;
  cachePolicy: CachePolicy;
  retryPolicy: RetryPolicy;
  validateOutput(input: Input, output: Output): void;
}

export type ContextSegmentKind =
  | 'policy'
  | 'schema'
  | 'facts'
  | 'brand'
  | 'examples'
  | 'request'
  | 'repair';

export interface ContextSegment {
  kind: ContextSegmentKind;
  sourceRef: string;
  sourceDigest: string;
  sensitivity: 'public' | 'workspace' | 'restricted';
  cacheClass: 'stable-prefix' | 'request-local' | 'never-cache';
  estimatedTokens: number;
  relevance?: number;
  content: unknown;
}

export interface ContextEnvelope {
  workspaceId: string;
  policyVersion: string;
  segments: readonly ContextSegment[];
  estimatedTokens: number;
  outputReserve: number;
  reasoningReserve: number;
  droppedSourceRefs: readonly string[];
  digest: string;
}

export interface ModelCapabilityProfile {
  alias: string;
  protocol: ModelProtocol;
  contextWindow: number;
  maximumOutputTokens: number;
  tokenizer: string;
  structuredOutput: { supported: boolean; dialects: readonly string[] };
  reasoningLevels: readonly ReasoningLevel[];
  nativeCache: { mechanism: string; proven: boolean } | null;
  tools: boolean;
  vision: boolean;
  image: boolean;
  streaming: boolean;
  reportsUsage: boolean;
  reportsModel: boolean;
  reportsRequestId: boolean;
  settlementObservation: 'none' | 'response' | 'gateway_log';
  probe: { version: string; observedAt: string; result: 'passed' | 'failed' | 'unknown' };
}

export interface ExactResultCacheIdentity {
  workspaceId: string;
  buildRunId: string;
  taskId: string;
  taskContractVersion: string;
  promptVersion: string;
  schemaDigest: string;
  inputDigest: string;
  contextDigest: string;
  promptDigest: string;
  resolvedAlias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  sampling: Readonly<Record<string, number | string | boolean>>;
  locale: string;
  priorOutputDigest?: string;
  findingsDigest?: string;
}

export interface ExactResultCacheEntry<Output = unknown> {
  output: Output;
  settlement: 'known' | 'unknown';
  validated: boolean;
}

export interface ExactResultCache {
  get<Output>(identity: ExactResultCacheIdentity): Promise<ExactResultCacheEntry<Output> | undefined>;
  put<Output>(identity: ExactResultCacheIdentity, entry: ExactResultCacheEntry<Output>): Promise<void>;
  putRepair<Output>(
    originalIdentity: ExactResultCacheIdentity,
    repairIdentity: ExactResultCacheIdentity,
    entry: ExactResultCacheEntry<Output>,
  ): Promise<void>;
}

export interface RepairBinding {
  priorOutputDigest: string;
  findingsDigest: string;
  originalInputDigest: string;
  originalContextDigest: string;
}

export interface ModelExecutionPlan<Input, Output> {
  executionId: string;
  workspaceId: string;
  buildRunId: string;
  contract: TaskModelContract<Input, Output>;
  input: Input;
  inputDigest: string;
  context: ContextEnvelope;
  contextDigest: string;
  promptVersion: string;
  schemaDigest: string;
  requestedAlias: string;
  resolvedAlias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  sampling: Readonly<Record<string, number | string | boolean>>;
  locale: string;
  prompt: Readonly<Record<string, unknown>>;
  repair?: RepairBinding;
  deterministicExecutor?: (input: Input) => Output | Promise<Output>;
}

export interface ModelObservation<Output> {
  output: Output;
  requestedAlias: string;
  resolvedAlias: string;
  reportedModel?: string;
  protocol: ModelProtocol;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  requestId?: string;
  settlement: 'known' | 'unknown';
}

export interface ModelTransport<Input = unknown, Output = unknown> {
  dispatch(plan: ModelExecutionPlan<Input, Output>): Promise<ModelObservation<Output>>;
}

export type ModelExecutionState =
  | 'planned'
  | 'admitted'
  | 'dispatched'
  | 'observed'
  | 'validated'
  | 'repaired'
  | 'settled'
  | 'completed'
  | 'frozen';

export interface RuntimeTelemetryEvent {
  executionId: string;
  state: ModelExecutionState;
  taskId: string;
  taskVersion: string;
  workspaceId: string;
  contextDigest: string;
  requestedAlias: string;
  resolvedAlias: string;
  protocol: ModelProtocol;
  detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface RuntimeTelemetry {
  emit(event: RuntimeTelemetryEvent): void | Promise<void>;
}

export interface ModelExecutionResult<Output> {
  output: Output;
  observation?: ModelObservation<Output>;
  states: readonly ModelExecutionState[];
  transportAttempts: number;
  repairAttempts: number;
  cacheHit: boolean;
}
