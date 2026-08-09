export type JsonSchema = Readonly<Record<string, unknown>>;

export type ModelProtocol =
  | "openai_responses"
  | "openai_chat_completions"
  | "anthropic_messages"
  | "google_native";
export type ReasoningLevel = "none" | "low" | "medium" | "high" | "max";

export interface ModelResponseShape {
  readonly schemaVersion: "native-model-response-shape/2026-08-09-v1";
  readonly topLevelKeys: readonly string[];
  readonly contentBlockTypes: readonly string[];
  readonly usageKeys: readonly string[];
  readonly validationPaths: readonly string[];
}

const MAX_MODEL_RESPONSE_SHAPE_ITEMS = 32;
const SAFE_MODEL_RESPONSE_TOP_LEVEL_KEYS = new Set([
  "background",
  "choices",
  "container",
  "content",
  "context_management",
  "created",
  "created_at",
  "error",
  "id",
  "incomplete_details",
  "instructions",
  "max_output_tokens",
  "metadata",
  "model",
  "object",
  "output",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt_cache_key",
  "reasoning",
  "role",
  "safety_identifier",
  "service_tier",
  "status",
  "stop_details",
  "stop_reason",
  "stop_sequence",
  "store",
  "system_fingerprint",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
  "type",
  "usage",
  "user",
]);
const SAFE_MODEL_RESPONSE_CONTENT_BLOCK_TYPES = new Set([
  "advisor_tool_result",
  "bash_code_execution_tool_result",
  "code_execution_tool_result",
  "compaction",
  "fallback",
  "function_call",
  "mcp_tool_result",
  "mcp_tool_use",
  "message",
  "output_text",
  "reasoning",
  "redacted_thinking",
  "server_tool_use",
  "text",
  "text_editor_code_execution_tool_result",
  "thinking",
  "tool_call",
  "tool_search_tool_result",
  "tool_use",
  "web_fetch_tool_result",
  "web_search_tool_result",
]);
const SAFE_MODEL_RESPONSE_USAGE_KEYS = new Set([
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "completion_tokens",
  "completion_tokens_details",
  "input_tokens",
  "input_tokens_details",
  "iterations",
  "output_tokens",
  "output_tokens_details",
  "prompt_tokens",
  "prompt_tokens_details",
  "total_tokens",
]);
const SAFE_MODEL_RESPONSE_VALIDATION_PATH_SEGMENTS = new Set([
  ...SAFE_MODEL_RESPONSE_TOP_LEVEL_KEYS,
  ...SAFE_MODEL_RESPONSE_USAGE_KEYS,
  "caller",
  "citations",
  "data",
  "input",
  "name",
  "signature",
]);
const MODEL_RESPONSE_SHAPE_KEYS = Object.freeze([
  "contentBlockTypes",
  "schemaVersion",
  "topLevelKeys",
  "usageKeys",
  "validationPaths",
]);

function responseRecord(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeResponseKeys(
  value: Record<string, unknown> | undefined,
  allowlist: ReadonlySet<string>,
): readonly string[] {
  return Object.freeze(
    Object.keys(value ?? {})
      .filter((key) => allowlist.has(key))
      .sort()
      .slice(0, MAX_MODEL_RESPONSE_SHAPE_ITEMS),
  );
}

function responseValidationIssues(error: unknown): readonly unknown[] {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    const currentRecord = responseRecord(current);
    if (Array.isArray(currentRecord?.issues)) return currentRecord.issues;
    current = currentRecord?.cause;
  }
  return [];
}

function safeResponseValidationPath(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    return undefined;
  }
  let path = "";
  for (const segment of value) {
    if (Number.isSafeInteger(segment) && Number(segment) >= 0) {
      path += `[${segment}]`;
      continue;
    }
    if (
      typeof segment !== "string" ||
      !SAFE_MODEL_RESPONSE_VALIDATION_PATH_SEGMENTS.has(segment)
    ) {
      return undefined;
    }
    path += path.length === 0 ? segment : `.${segment}`;
  }
  return path.length <= 128 ? path : undefined;
}

function safeResponseShapeList(
  value: unknown,
  allow: (entry: string) => boolean,
): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_MODEL_RESPONSE_SHAPE_ITEMS) {
    return undefined;
  }
  if (
    value.some((entry) => typeof entry !== "string" || !allow(entry)) ||
    new Set(value).size !== value.length
  ) {
    return undefined;
  }
  const copy = [...(value as string[])];
  const sorted = [...copy].sort();
  if (copy.some((entry, index) => entry !== sorted[index])) return undefined;
  return Object.freeze(copy);
}

function persistedValidationPathIsSafe(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 128 ||
    !/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*|\[(?:0|[1-9][0-9]*)\]){0,7}$/u.test(
      path,
    )
  ) {
    return false;
  }
  const names = [...path.matchAll(/[a-z_][a-z0-9_]*/gu)].map(([name]) => name);
  const indexes = [...path.matchAll(/\[([0-9]+)\]/gu)].map(([, index]) =>
    Number(index),
  );
  return (
    names.every((name) =>
      SAFE_MODEL_RESPONSE_VALIDATION_PATH_SEGMENTS.has(name),
    ) && indexes.every((index) => Number.isSafeInteger(index))
  );
}

export function normalizeModelResponseShape(
  value: unknown,
): ModelResponseShape | undefined {
  const shape = responseRecord(value);
  if (
    shape == null ||
    shape.schemaVersion !== "native-model-response-shape/2026-08-09-v1" ||
    Object.keys(shape).sort().join("\u0000") !==
      MODEL_RESPONSE_SHAPE_KEYS.join("\u0000")
  ) {
    return undefined;
  }
  const topLevelKeys = safeResponseShapeList(shape.topLevelKeys, (entry) =>
    SAFE_MODEL_RESPONSE_TOP_LEVEL_KEYS.has(entry),
  );
  const contentBlockTypes = safeResponseShapeList(
    shape.contentBlockTypes,
    (entry) => SAFE_MODEL_RESPONSE_CONTENT_BLOCK_TYPES.has(entry),
  );
  const usageKeys = safeResponseShapeList(shape.usageKeys, (entry) =>
    SAFE_MODEL_RESPONSE_USAGE_KEYS.has(entry),
  );
  const validationPaths = safeResponseShapeList(
    shape.validationPaths,
    persistedValidationPathIsSafe,
  );
  if (
    topLevelKeys == null ||
    contentBlockTypes == null ||
    usageKeys == null ||
    validationPaths == null
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: "native-model-response-shape/2026-08-09-v1" as const,
    topLevelKeys,
    contentBlockTypes,
    usageKeys,
    validationPaths,
  });
}

export function createRedactedModelResponseShape(
  body: unknown,
  validationError: unknown,
): ModelResponseShape | undefined {
  const topLevel = responseRecord(body);
  if (topLevel == null) return undefined;
  const content = Array.isArray(topLevel.content) ? topLevel.content : [];
  return normalizeModelResponseShape({
    schemaVersion: "native-model-response-shape/2026-08-09-v1",
    topLevelKeys: safeResponseKeys(
      topLevel,
      SAFE_MODEL_RESPONSE_TOP_LEVEL_KEYS,
    ),
    contentBlockTypes: [
      ...new Set(
        content
          .map((block) => responseRecord(block)?.type)
          .filter(
            (type): type is string =>
              typeof type === "string" &&
              SAFE_MODEL_RESPONSE_CONTENT_BLOCK_TYPES.has(type),
          ),
      ),
    ]
      .sort()
      .slice(0, MAX_MODEL_RESPONSE_SHAPE_ITEMS),
    usageKeys: safeResponseKeys(
      responseRecord(topLevel.usage),
      SAFE_MODEL_RESPONSE_USAGE_KEYS,
    ),
    validationPaths: [
      ...new Set(
        responseValidationIssues(validationError)
          .map((issue) =>
            safeResponseValidationPath(responseRecord(issue)?.path),
          )
          .filter((path): path is string => path != null),
      ),
    ]
      .sort()
      .slice(0, MAX_MODEL_RESPONSE_SHAPE_ITEMS),
  });
}

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
  exactReportedModel?: boolean;
  forbidWarnings?: boolean;
  settlementRequired?: boolean;
}

export interface ReasoningPolicy {
  allowed: readonly ReasoningLevel[];
  default: ReasoningLevel;
  reserveTokens: number;
}

export interface CachePolicy {
  mode: "disabled" | "exact" | "build-run-replay";
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
  executionMode: "deterministic" | "generative";
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
  "policy" | "schema" | "facts" | "brand" | "examples" | "request" | "repair";

export interface ContextSegment {
  kind: ContextSegmentKind;
  sourceRef: string;
  sourceDigest: string;
  sensitivity: "public" | "workspace" | "restricted";
  cacheClass: "stable-prefix" | "request-local" | "never-cache";
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
  settlementObservation: "none" | "response" | "gateway_log";
  probe: {
    version: string;
    observedAt: string;
    result: "passed" | "failed" | "unknown";
  };
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
  settlement: "known" | "unknown";
  validated: boolean;
}

export interface ExactResultCache {
  get<Output>(
    identity: ExactResultCacheIdentity,
  ): Promise<ExactResultCacheEntry<Output> | undefined>;
  put<Output>(
    identity: ExactResultCacheIdentity,
    entry: ExactResultCacheEntry<Output>,
  ): Promise<void>;
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

export interface ModelValidationFinding {
  code: string;
  path: string;
}

export interface ModelContentRepairCompilerInput<Input, Output> {
  originalPlan: ModelExecutionPlan<Input, Output>;
  currentPlan: ModelExecutionPlan<Input, Output>;
  priorOutput: Output;
  findings: readonly ModelValidationFinding[];
  binding: RepairBinding;
  repairAttempt: number;
}

/**
 * Task-specific compiler for a closed content repair. The Runtime validates
 * every returned identity and digest before a second physical dispatch.
 */
export interface ModelContentRepairCompiler<Input, Output> {
  findings(error: unknown): readonly ModelValidationFinding[];
  compile(
    input: ModelContentRepairCompilerInput<Input, Output>,
  ): ModelExecutionPlan<Input, Output>;
}

export interface ModelExecutionPlan<Input, Output> {
  executionId: string;
  fallbackIndex?: number;
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
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  usageComplete?: boolean;
  requestId?: string;
  settlement: "known" | "unknown";
  settlementUnknownReason?: string;
  settlementProof?: unknown;
  responseShape?: ModelResponseShape;
  warnings?: readonly string[];
}

export interface ModelTransport<Input = unknown, Output = unknown> {
  dispatch(
    plan: ModelExecutionPlan<Input, Output>,
  ): Promise<ModelObservation<Output>>;
}

export interface ModelPostWireGuardInput<Input, Output> {
  plan: ModelExecutionPlan<Input, Output>;
  observation?: ModelObservation<Output>;
  dispatchError?: unknown;
}

export type ModelPostWireGuard<Input, Output> = (
  input: ModelPostWireGuardInput<Input, Output>,
) => void | Promise<void>;

export interface ModelRepairPlannedGuardInput<Input, Output> {
  originalPlan: ModelExecutionPlan<Input, Output>;
  repairPlan: ModelExecutionPlan<Input, Output>;
  binding: RepairBinding;
  findings: readonly ModelValidationFinding[];
}

export type ModelRepairPlannedGuard<Input, Output> = (
  input: ModelRepairPlannedGuardInput<Input, Output>,
) => void | Promise<void>;

export interface ModelCompletionGuardInput<Input, Output> {
  plan: ModelExecutionPlan<Input, Output>;
  result: ModelExecutionResult<Output>;
  wireCount: number;
  outputDigest: string;
}

export type ModelCompletionGuard<Input, Output> = (
  input: ModelCompletionGuardInput<Input, Output>,
) => void | Promise<void>;

export type ModelExecutionState =
  | "planned"
  | "admitted"
  | "dispatched"
  | "observed"
  | "validated"
  | "repaired"
  | "settled"
  | "completed"
  | "frozen";

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
  reasoning: ReasoningLevel;
  fallbackIndex: number;
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
