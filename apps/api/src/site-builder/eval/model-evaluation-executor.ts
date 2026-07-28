import {
  getModelCandidateCatalogEntry,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";
import { BRAND_PROFILE_TASK } from "../agents/brand-profile";
import { modelPolicyRegistry } from "../agents/model-policy.registry";
import { checkAgainstSchema } from "../../model-gateway/schema-validate";
import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  consumeAuthorizedModelEvaluationExecutionRequest,
  ModelEvaluationCallError,
  type CapabilityProbeExecutionRequest,
  type CostSettlement,
  type ModelEvaluationCostBasis,
  type ModelEvaluationCallResult,
  type ModelEvaluationExecutionRequest,
  type ModelEvaluationUsage,
} from "./model-evaluation-harness";
import { sha256CanonicalJson } from "./eval-provenance";
import {
  assertModelEvaluationCostSafetyDispatch,
  frozenModelEvaluationPriceCents,
  isTrustedModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyAttestation,
} from "./model-evaluation-cost-safety";

export const MODEL_EVALUATION_PROTOCOL_ADMISSION_SCHEMA_VERSION =
  "site-builder-model-evaluation-protocol-admission/v1" as const;

export type ModelEvaluationProtocolAdmission =
  | "target_text_dispatch"
  | "legacy_comparator_only"
  | "blocked_deferred"
  | "blocked_requires_media_gateway"
  | "blocked_no_consumer"
  | "blocked_no_evaluation_suite";

export interface ModelEvaluationProtocolAdmissionEntry {
  protocol: ModelCandidateProtocol;
  domain: "text" | "image" | "video" | "embedding";
  admission: ModelEvaluationProtocolAdmission;
  operations: readonly string[];
  boundary: string;
}

/**
 * Evaluation-only wire admission. This registry is deliberately independent
 * from VERIFIED_GATEWAY_MODEL_TRANSPORTS and cannot affect runtime routing.
 */
export const MODEL_EVALUATION_PROTOCOL_ADMISSIONS = Object.freeze([
  {
    protocol: "openai-responses",
    domain: "text",
    admission: "target_text_dispatch",
    operations: Object.freeze(["structured_text"]),
    boundary:
      "Only an exact runnable task-pool alias/protocol pair with a canonical suite may dispatch.",
  },
  {
    protocol: "anthropic-messages",
    domain: "text",
    admission: "target_text_dispatch",
    operations: Object.freeze(["structured_text"]),
    boundary:
      "Only an exact runnable task-pool alias/protocol pair with a canonical suite may dispatch.",
  },
  {
    protocol: "openai-chat-completions",
    domain: "text",
    admission: "legacy_comparator_only",
    operations: Object.freeze(["structured_text_comparator"]),
    boundary:
      "Legacy-only aliases are available through the comparator entrypoint and can never enter target dispatch.",
  },
  {
    protocol: "google-generate-content",
    domain: "text",
    admission: "blocked_deferred",
    operations: Object.freeze(["structured_text"]),
    boundary:
      "The candidate baseline keeps the disabled Gemini text channel deferred.",
  },
  {
    protocol: "openai-images-generations",
    domain: "image",
    admission: "blocked_requires_media_gateway",
    operations: Object.freeze(["generate"]),
    boundary:
      "No MediaGateway or task-shaped image consumer exists; preview aliases remain shadow-only.",
  },
  {
    protocol: "openai-images-edits",
    domain: "image",
    admission: "blocked_requires_media_gateway",
    operations: Object.freeze(["edit", "mask"]),
    boundary:
      "Edit and mask semantics require a future MediaGateway capability contract.",
  },
  {
    protocol: "openai-videos",
    domain: "video",
    admission: "blocked_no_consumer",
    operations: Object.freeze(["create", "query", "cancel"]),
    boundary:
      "Video candidates remain deferred because no consumer or task-shaped lifecycle probe exists.",
  },
  {
    protocol: "openai-embeddings",
    domain: "embedding",
    admission: "blocked_no_evaluation_suite",
    operations: Object.freeze(["embed"]),
    boundary:
      "The unchanged private BGE route has no replacement task suite in this harness.",
  },
] as const satisfies readonly ModelEvaluationProtocolAdmissionEntry[]);

export interface OpenAIResponsesEvaluationWireRequest {
  executionId: string;
  body: {
    model: string;
    input: readonly {
      role: "system" | "user";
      content: string;
    }[];
    max_output_tokens: number;
    temperature: 0;
    text: {
      format: {
        type: "json_object";
      };
    };
    reasoning?: {
      effort: "low" | "medium" | "high";
    };
  };
  signal: AbortSignal;
}

export interface AnthropicMessagesEvaluationWireRequest {
  executionId: string;
  body: {
    model: string;
    system: string;
    messages: readonly {
      role: "user";
      content: string;
    }[];
    max_tokens: number;
    temperature: 0;
  };
  signal: AbortSignal;
}

export interface OpenAIChatCompletionsEvaluationWireRequest {
  executionId: string;
  body: {
    model: string;
    messages: readonly {
      role: "system" | "user";
      content: string;
    }[];
    max_tokens: number;
    temperature: 0;
    response_format: {
      type: "json_object";
    };
    reasoning_effort?: "low" | "medium" | "high";
  };
  signal: AbortSignal;
}

export interface ModelEvaluationWireResponse {
  body: unknown;
  /**
   * Optional value independently obtained by the wire client from a provider
   * billing field/header. Absence is not zero.
   */
  providerReportedCostCents?: number;
}

export interface ModelEvaluationWireClient {
  readonly credentialAttestationId?: string;
  readonly credentialSnapshotSha256?: string;
  openAIResponses(
    request: OpenAIResponsesEvaluationWireRequest,
  ): Promise<ModelEvaluationWireResponse>;
  anthropicMessages(
    request: AnthropicMessagesEvaluationWireRequest,
  ): Promise<ModelEvaluationWireResponse>;
  openAIChatCompletions(
    request: OpenAIChatCompletionsEvaluationWireRequest,
  ): Promise<ModelEvaluationWireResponse>;
}

const TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS = new WeakMap<
  object,
  Readonly<{
    credentialAttestationId: string;
    credentialSnapshotSha256: string;
  }>
>();

export function createCredentialBoundModelEvaluationWireClient(
  wireClient: ModelEvaluationWireClient,
  credential: Readonly<{
    attestationId: string;
    snapshotSha256: string;
  }>,
): ModelEvaluationWireClient {
  const openAIResponses = wireClient?.openAIResponses;
  const anthropicMessages = wireClient?.anthropicMessages;
  const openAIChatCompletions = wireClient?.openAIChatCompletions;
  if (
    !wireClient ||
    typeof openAIResponses !== "function" ||
    typeof anthropicMessages !== "function" ||
    typeof openAIChatCompletions !== "function" ||
    typeof credential?.attestationId !== "string" ||
    credential.attestationId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(credential.snapshotSha256)
  ) {
    throw new Error(
      "evaluation wire transport and credential identity are required",
    );
  }
  const bound = Object.freeze({
    credentialAttestationId: credential.attestationId,
    credentialSnapshotSha256: credential.snapshotSha256,
    openAIResponses: Object.freeze(openAIResponses.bind(wireClient)),
    anthropicMessages: Object.freeze(anthropicMessages.bind(wireClient)),
    openAIChatCompletions: Object.freeze(
      openAIChatCompletions.bind(wireClient),
    ),
  }) satisfies ModelEvaluationWireClient;
  TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS.set(
    bound,
    Object.freeze({
      credentialAttestationId: credential.attestationId,
      credentialSnapshotSha256: credential.snapshotSha256,
    }),
  );
  return bound;
}

export interface ModelEvaluationSettlementContext {
  executionId: string;
  taskId: ModelEvaluationExecutionRequest["taskId"];
  alias: string;
  protocol: ModelCandidateProtocol;
  outcome: "completed" | "failed";
  callCount: number;
  usage: ModelEvaluationSettlementUsage;
  providerReportedCostCents: readonly (number | null)[];
  error?: unknown;
}

export interface ModelEvaluationSettlementUsage extends ModelEvaluationUsage {
  complete: boolean;
}

export type ModelEvaluationSettlementResolution =
  | {
      state: "settled";
      amountCents: number;
      basis: ModelEvaluationCostBasis;
    }
  | Exclude<CostSettlement, { state: "settled" }>;

export interface ModelEvaluationSettlementResolver {
  readonly resolverId: string;
  resolve(
    context: Readonly<ModelEvaluationSettlementContext>,
  ):
    | ModelEvaluationSettlementResolution
    | Promise<ModelEvaluationSettlementResolution>;
}

export interface ModelEvaluationProtocolExecutor {
  execute<T = unknown>(
    request: ModelEvaluationExecutionRequest | CapabilityProbeExecutionRequest,
  ): Promise<ModelEvaluationCallResult<T>>;
  executeLegacyComparator<T = unknown>(
    request: ModelEvaluationExecutionRequest,
  ): Promise<ModelEvaluationCallResult<T>>;
}

type EvaluationExecutionRequest =
  ModelEvaluationExecutionRequest | CapabilityProbeExecutionRequest;

const TRUSTED_MODEL_EVALUATION_EXECUTES = new WeakMap<object, object>();
const TRUSTED_MODEL_EVALUATION_EXECUTOR_COST_SAFETY = new WeakMap<
  object,
  ModelEvaluationCostSafetyAttestation
>();
const TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS = new WeakMap<
  object,
  () => void
>();
const TRUSTED_EXECUTE_SET = WeakMap.prototype.set;
const TRUSTED_EXECUTE_GET = WeakMap.prototype.get;
const APPLY_TRUSTED_EXECUTE_INTRINSIC = Reflect.apply;
const CLAIMED_MODEL_EVALUATION_AUTHORIZATIONS = new Set<string>();

export function modelEvaluationProtocolExecutorIdentity(
  value: unknown,
): object | null {
  if (typeof value !== "function") return null;
  return (
    (APPLY_TRUSTED_EXECUTE_INTRINSIC(
      TRUSTED_EXECUTE_GET,
      TRUSTED_MODEL_EVALUATION_EXECUTES,
      [value],
    ) as object | undefined) ?? null
  );
}

export function isTrustedModelEvaluationProtocolExecute(
  value: unknown,
): value is ModelEvaluationProtocolExecutor["execute"] {
  return modelEvaluationProtocolExecutorIdentity(value) !== null;
}

export function modelEvaluationProtocolExecutorCostSafety(
  value: unknown,
): ModelEvaluationCostSafetyAttestation | null {
  const identity = modelEvaluationProtocolExecutorIdentity(value);
  return identity === null
    ? null
    : (TRUSTED_MODEL_EVALUATION_EXECUTOR_COST_SAFETY.get(identity) ?? null);
}

export function freezeModelEvaluationProtocolExecutor(value: unknown): boolean {
  const identity = modelEvaluationProtocolExecutorIdentity(value);
  const freeze = identity
    ? TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS.get(identity)
    : undefined;
  if (!freeze) return false;
  freeze();
  return true;
}

type TextEvaluationProtocol =
  "openai-responses" | "anthropic-messages" | "openai-chat-completions";

interface NormalizedTextResponse {
  artifactState: "complete" | "empty" | "truncated";
  rawText: string | null;
  reportedModel?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  callCount: number;
  complete: boolean;
}

const SETTLED_BASES = new Set([
  "provider_reported",
  "frozen_pricing_snapshot",
  "verified_billing_export",
]);
const UNKNOWN_REASONS = new Set([
  "provider_ack_unknown",
  "diagnostic_hard_stop",
  "invalid_settlement",
]);
const SETTLEMENT_RESOLVER_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,511}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

function canonicalSettlement(
  value: unknown,
  dispatched: boolean,
  resolverId: string,
  context?: ModelEvaluationSettlementContext,
  costSafety?: ModelEvaluationCostSafetyAttestation,
): CostSettlement {
  if (!isRecord(value)) {
    return { state: "unknown", reason: "invalid_settlement" };
  }
  const providerReportedAmount =
    context &&
    context.callCount > 0 &&
    context.providerReportedCostCents.length === context.callCount &&
    context.providerReportedCostCents.every(
      (amount): amount is number => amount !== null,
    )
      ? context.providerReportedCostCents.reduce(
          (sum, amount) => sum + amount,
          0,
        )
      : null;
  const completeUsage =
    context !== undefined &&
    context.callCount > 0 &&
    context.usage.complete &&
    context.usage.callCount === context.callCount &&
    context.usage.source ===
      (context.callCount === 1 ? "provider_reported" : "adapter_aggregated") &&
    Number.isSafeInteger(context.usage.inputTokens) &&
    context.usage.inputTokens >= 0 &&
    Number.isSafeInteger(context.usage.outputTokens) &&
    context.usage.outputTokens >= 0;
  const frozenPricingAmount =
    completeUsage && context && costSafety
      ? frozenModelEvaluationPriceCents(costSafety, {
          alias: context.alias,
          protocol: context.protocol,
          inputTokens: context.usage.inputTokens,
          outputTokens: context.usage.outputTokens,
        })
      : null;
  if (
    value.state === "settled" &&
    exactKeys(value, ["state", "amountCents", "basis"]) &&
    typeof value.amountCents === "number" &&
    Number.isFinite(value.amountCents) &&
    value.amountCents >= 0 &&
    typeof value.basis === "string" &&
    SETTLED_BASES.has(value.basis) &&
    (value.basis !== "provider_reported" ||
      (providerReportedAmount !== null &&
        Math.abs(providerReportedAmount - value.amountCents) <= 1e-9)) &&
    (value.basis !== "frozen_pricing_snapshot" ||
      (frozenPricingAmount !== null &&
        Math.abs(frozenPricingAmount - value.amountCents) <= 1e-9))
  ) {
    return {
      state: "settled",
      amountCents: value.amountCents,
      basis: `${value.basis}@${resolverId}` as Extract<
        CostSettlement,
        { state: "settled" }
      >["basis"],
    };
  }
  if (
    value.state === "unknown" &&
    exactKeys(value, ["state", "reason"]) &&
    typeof value.reason === "string" &&
    UNKNOWN_REASONS.has(value.reason)
  ) {
    return {
      state: "unknown",
      reason: value.reason as Extract<
        CostSettlement,
        { state: "unknown" }
      >["reason"],
    };
  }
  if (
    !dispatched &&
    value.state === "not_incurred" &&
    exactKeys(value, ["state", "reason"]) &&
    value.reason === "rejected_before_dispatch"
  ) {
    return {
      state: "not_incurred",
      reason: "rejected_before_dispatch",
    };
  }
  if (
    dispatched &&
    value.state === "not_incurred" &&
    exactKeys(value, ["state", "reason"]) &&
    value.reason === "provider_attested_not_incurred" &&
    context?.outcome === "failed" &&
    context.callCount === 1 &&
    context.providerReportedCostCents.length === 1 &&
    context.providerReportedCostCents[0] === null
  ) {
    return {
      state: "not_incurred",
      reason: "provider_attested_not_incurred",
    };
  }
  return { state: "unknown", reason: "invalid_settlement" };
}

function preDispatchError(code: string): ModelEvaluationCallError {
  return new ModelEvaluationCallError(code, {
    state: "not_incurred",
    reason: "rejected_before_dispatch",
  });
}

function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  try {
    return sha256CanonicalJson(left) === sha256CanonicalJson(right);
  } catch {
    return false;
  }
}

function assertCanonicalRequest(
  request: EvaluationExecutionRequest,
  mode: "target" | "legacy_comparator",
): TextEvaluationProtocol {
  if (!request || typeof request !== "object") {
    throw preDispatchError("evaluation_request_invalid");
  }
  if (
    typeof request.executionId !== "string" ||
    !EXECUTION_ID.test(request.executionId)
  ) {
    throw preDispatchError("evaluation_execution_id_invalid");
  }
  let plan;
  try {
    plan = buildTaskEvaluationPlan(request.taskId);
  } catch {
    throw preDispatchError("task_not_in_candidate_baseline");
  }
  if (
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    !plan.evaluationSuite
  ) {
    throw preDispatchError("task_has_no_canonical_evaluation_suite");
  }
  if (request.profile !== plan.profile) {
    throw preDispatchError("evaluation_profile_mismatch");
  }

  let catalog;
  try {
    catalog = getModelCandidateCatalogEntry(request.alias);
  } catch {
    throw preDispatchError("candidate_alias_unknown");
  }
  if (!catalog.expectedProtocols.includes(request.expectedProtocol)) {
    throw preDispatchError("candidate_protocol_mismatch");
  }

  let selectedProtocol: TextEvaluationProtocol;
  if (mode === "target") {
    const candidate = plan.candidates.find(
      (entry) =>
        entry.alias === request.alias &&
        entry.expectedProtocol === request.expectedProtocol,
    );
    if (
      !candidate ||
      catalog.status !== "runnable" ||
      catalog.domain !== "text"
    ) {
      throw preDispatchError(
        catalog.status === "preview"
          ? "candidate_preview_shadow_only"
          : catalog.status === "deferred"
            ? "candidate_deferred"
            : catalog.status === "legacy-only"
              ? "candidate_legacy_only"
              : catalog.domain !== "text"
                ? "candidate_requires_media_or_embedding_boundary"
                : "candidate_not_in_task_pool",
      );
    }
    if (
      "probeKind" in request &&
      (request.probeKind !== "canonical_task_shaped_capability" ||
        candidate.preflight !== "capability_probe")
    ) {
      throw preDispatchError("capability_probe_not_admitted");
    }
    if (
      candidate.expectedProtocol !== "openai-responses" &&
      candidate.expectedProtocol !== "anthropic-messages"
    ) {
      throw preDispatchError("target_protocol_not_admitted");
    }
    selectedProtocol = candidate.expectedProtocol;
  } else {
    const legacyRoute = modelPolicyRegistry.getLegacyTaskPolicy(
      request.taskId,
    ).route;
    if (
      catalog.status !== "legacy-only" ||
      catalog.domain !== "text" ||
      request.expectedProtocol !== "openai-chat-completions" ||
      ![legacyRoute.primary, ...legacyRoute.fallbacks].includes(request.alias)
    ) {
      throw preDispatchError("legacy_comparator_not_admitted");
    }
    selectedProtocol = "openai-chat-completions";
  }

  const canonicalCase = buildCanonicalModelEvaluationCase(
    plan,
    request.fixtureId,
  );
  if (
    request.maxTokens !== plan.envelope.maxTokens ||
    request.runtimeDeadlineMs !== plan.envelope.runtimeDeadlineMs ||
    request.hardStopMs !== plan.envelope.hardStopMs ||
    request.perCallCostCapCents !== plan.envelope.perCallCostCapCents ||
    request.reasoningEffort !== plan.envelope.reasoningEffort ||
    request.repairTaskOutput !== plan.evaluationSuite.repairTaskOutput ||
    !canonicalJsonEqual(
      request.outputSchema,
      BRAND_PROFILE_TASK.outputSchema,
    ) ||
    !canonicalJsonEqual(request.caseContract, canonicalCase.contract) ||
    !canonicalJsonEqual(request.casePayload, canonicalCase.payload)
  ) {
    throw preDispatchError("evaluation_request_not_canonical");
  }
  if (
    !request.signal ||
    typeof request.signal.aborted !== "boolean" ||
    typeof request.signal.addEventListener !== "function"
  ) {
    throw preDispatchError("evaluation_abort_signal_invalid");
  }
  if (request.signal.aborted) {
    throw preDispatchError("aborted_before_dispatch");
  }
  if (
    !("probeKind" in request) &&
    (!Number.isInteger(request.attempt) ||
      request.attempt < 1 ||
      request.attempt > plan.evaluationSuite.repeats)
  ) {
    throw preDispatchError("evaluation_attempt_invalid");
  }
  return selectedProtocol;
}

function structuredSystemPrompt(
  outputSchema: Readonly<Record<string, unknown>>,
): string {
  return `${BRAND_PROFILE_TASK.system ?? ""}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(outputSchema)}`;
}

function repairPrompt(prompt: string, kind: string, reason: string): string {
  return `${prompt}\n\n上一次输出未通过${kind}校验，错误：\n${reason}\n请只修正被拒字段，不得新增、猜测或放宽任何事实；重新只输出同时通过 JSON Schema 和任务硬门的合法 JSON。`;
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function nonEmptyReportedModel(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function responseUsage(
  inputTokens: unknown,
  outputTokens: unknown,
): NormalizedTextResponse["usage"] {
  const input = nonNegativeInteger(inputTokens);
  const output = nonNegativeInteger(outputTokens);
  return input !== null && output !== null
    ? { inputTokens: input, outputTokens: output }
    : null;
}

function normalizedText(
  rawText: string,
  reportedModel: string | undefined,
  usage: NormalizedTextResponse["usage"],
  truncated: boolean,
): NormalizedTextResponse {
  if (truncated) {
    return {
      artifactState: "truncated",
      rawText: null,
      reportedModel,
      usage,
    };
  }
  if (!rawText.trim()) {
    return {
      artifactState: "empty",
      rawText: null,
      reportedModel,
      usage,
    };
  }
  return {
    artifactState: "complete",
    rawText,
    reportedModel,
    usage,
  };
}

function normalizeOpenAIResponses(body: unknown): NormalizedTextResponse {
  if (!isRecord(body)) {
    throw new Error("openai_responses_body_invalid");
  }
  const usage = isRecord(body.usage)
    ? responseUsage(body.usage.input_tokens, body.usage.output_tokens)
    : null;
  const reportedModel = nonEmptyReportedModel(body.model);
  if (body.status === "incomplete") {
    return normalizedText("", reportedModel, usage, true);
  }
  if (body.status !== "completed") {
    throw new Error("openai_responses_status_invalid");
  }
  const nested: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (
          isRecord(content) &&
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          nested.push(content.text);
        }
      }
    }
  }
  const rawText =
    nested.join("") ||
    (typeof body.output_text === "string" ? body.output_text : "");
  return normalizedText(rawText, reportedModel, usage, false);
}

function normalizeAnthropicMessages(body: unknown): NormalizedTextResponse {
  if (!isRecord(body)) {
    throw new Error("anthropic_messages_body_invalid");
  }
  const usage = isRecord(body.usage)
    ? responseUsage(body.usage.input_tokens, body.usage.output_tokens)
    : null;
  const reportedModel = nonEmptyReportedModel(body.model);
  if (
    body.stop_reason === "max_tokens" ||
    body.stop_reason === "model_context_window_exceeded"
  ) {
    return normalizedText("", reportedModel, usage, true);
  }
  if (body.stop_reason !== "end_turn") {
    throw new Error("anthropic_messages_stop_reason_invalid");
  }
  const parts: string[] = [];
  if (Array.isArray(body.content)) {
    for (const content of body.content) {
      if (
        isRecord(content) &&
        content.type === "text" &&
        typeof content.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return normalizedText(parts.join(""), reportedModel, usage, false);
}

function normalizeOpenAIChatCompletions(body: unknown): NormalizedTextResponse {
  if (!isRecord(body)) {
    throw new Error("openai_chat_body_invalid");
  }
  const usage = isRecord(body.usage)
    ? responseUsage(body.usage.prompt_tokens, body.usage.completion_tokens)
    : null;
  const reportedModel = nonEmptyReportedModel(body.model);
  const first = Array.isArray(body.choices) ? body.choices[0] : undefined;
  if (!isRecord(first)) {
    throw new Error("openai_chat_choice_missing");
  }
  if (first.finish_reason === "length") {
    return normalizedText("", reportedModel, usage, true);
  }
  if (first.finish_reason !== "stop") {
    throw new Error("openai_chat_finish_reason_invalid");
  }
  const message = isRecord(first.message) ? first.message : null;
  const rawText =
    message && typeof message.content === "string" ? message.content : "";
  return normalizedText(rawText, reportedModel, usage, false);
}

function artifactFromText(rawText: string): unknown {
  const payload = stripJsonFence(rawText);
  try {
    return JSON.parse(payload);
  } catch {
    return rawText;
  }
}

function validationFailure(
  request: EvaluationExecutionRequest,
  artifact: unknown,
): { kind: "JSON Schema" | "任务确定性硬门"; reason: string } | null {
  const schema = checkAgainstSchema(request.outputSchema, artifact);
  if (!schema.valid) {
    return {
      kind: "JSON Schema",
      reason: (schema.errors ?? []).join("\n") || "schema_invalid",
    };
  }
  try {
    BRAND_PROFILE_TASK.validateOutput?.(
      request.casePayload.taskInput,
      artifact as never,
    );
    return null;
  } catch (error) {
    return {
      kind: "任务确定性硬门",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function addUsage(
  accumulator: UsageAccumulator,
  usage: NormalizedTextResponse["usage"],
): void {
  accumulator.callCount += 1;
  if (!usage) {
    accumulator.complete = false;
    return;
  }
  const inputTokens = accumulator.inputTokens + usage.inputTokens;
  const outputTokens = accumulator.outputTokens + usage.outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens)
  ) {
    accumulator.complete = false;
    return;
  }
  accumulator.inputTokens = inputTokens;
  accumulator.outputTokens = outputTokens;
}

function settlementUsage(
  accumulator: UsageAccumulator,
): ModelEvaluationSettlementUsage {
  return {
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    callCount: accumulator.callCount,
    source:
      accumulator.callCount === 1 ? "provider_reported" : "adapter_aggregated",
    complete: accumulator.complete,
  };
}

function evaluationUsage(
  accumulator: UsageAccumulator,
): ModelEvaluationUsage | null {
  if (!accumulator.complete || accumulator.callCount < 1) return null;
  const { complete: _complete, ...usage } = settlementUsage(accumulator);
  return usage;
}

async function safeResolveSettlement(
  resolver: ModelEvaluationSettlementResolver,
  context: ModelEvaluationSettlementContext,
  costSafety: ModelEvaluationCostSafetyAttestation,
): Promise<CostSettlement> {
  try {
    const resolverContext = Object.freeze({
      ...context,
      usage: Object.freeze({ ...context.usage }),
      providerReportedCostCents: Object.freeze([
        ...context.providerReportedCostCents,
      ]),
    });
    return canonicalSettlement(
      await resolver.resolve(resolverContext),
      true,
      resolver.resolverId,
      resolverContext,
      costSafety,
    );
  } catch {
    return { state: "unknown", reason: "invalid_settlement" };
  }
}

function responseCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function createModelEvaluationProtocolExecutor(deps: {
  wireClient: ModelEvaluationWireClient;
  settlementResolver: ModelEvaluationSettlementResolver;
  costSafety: ModelEvaluationCostSafetyAttestation;
}): ModelEvaluationProtocolExecutor {
  const wireReceiver = deps?.wireClient;
  const openAIResponses = wireReceiver?.openAIResponses;
  const anthropicMessages = wireReceiver?.anthropicMessages;
  const openAIChatCompletions = wireReceiver?.openAIChatCompletions;
  const resolverReceiver = deps?.settlementResolver;
  const resolverId = resolverReceiver?.resolverId;
  const resolverResolve = resolverReceiver?.resolve;
  const costSafety = deps?.costSafety;
  const credentialAttestationId = wireReceiver?.credentialAttestationId;
  const credentialSnapshotSha256 = wireReceiver?.credentialSnapshotSha256;
  const trustedWireCredential =
    wireReceiver && typeof wireReceiver === "object"
      ? TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS.get(wireReceiver)
      : undefined;
  if (
    !wireReceiver ||
    typeof openAIResponses !== "function" ||
    typeof anthropicMessages !== "function" ||
    typeof openAIChatCompletions !== "function" ||
    !resolverReceiver ||
    !SETTLEMENT_RESOLVER_ID.test(resolverId ?? "") ||
    typeof resolverResolve !== "function" ||
    !isTrustedModelEvaluationCostSafetyAttestation(costSafety) ||
    costSafety.pricing.resolverId !== resolverId ||
    trustedWireCredential?.credentialAttestationId !==
      credentialAttestationId ||
    trustedWireCredential?.credentialSnapshotSha256 !==
      credentialSnapshotSha256 ||
    credentialAttestationId !== costSafety.credential.attestationId ||
    credentialSnapshotSha256 !== costSafety.credential.snapshotSha256 ||
    CLAIMED_MODEL_EVALUATION_AUTHORIZATIONS.has(
      costSafety.authorization.authorizationId,
    )
  ) {
    throw new Error(
      "evaluation wire client and auditable settlement resolver are required; trusted cost safety must match",
    );
  }
  const wireClient = Object.freeze({
    credentialAttestationId,
    credentialSnapshotSha256,
    openAIResponses: Object.freeze(openAIResponses.bind(wireReceiver)),
    anthropicMessages: Object.freeze(anthropicMessages.bind(wireReceiver)),
    openAIChatCompletions: Object.freeze(
      openAIChatCompletions.bind(wireReceiver),
    ),
  }) satisfies ModelEvaluationWireClient;
  Object.freeze(resolverReceiver);
  const capturedResolve = Object.freeze(resolverResolve.bind(resolverReceiver));
  const settlementResolver = Object.freeze({
    resolverId,
    resolve: capturedResolve,
  }) satisfies ModelEvaluationSettlementResolver;
  let reservedDispatchExecutions = 0;
  let reservedWireCalls = 0;
  let committedCampaignCents = 0;
  let reservedCampaignUpperBoundCents = 0;
  let campaignFrozen = false;

  const executeWithMode = async <T>(
    request: EvaluationExecutionRequest,
    mode: "target" | "legacy_comparator",
  ): Promise<ModelEvaluationCallResult<T>> => {
    if (!consumeAuthorizedModelEvaluationExecutionRequest(request)) {
      throw preDispatchError("evaluation_dispatch_not_authorized");
    }
    const protocol = assertCanonicalRequest(request, mode);
    const usage: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      complete: true,
    };
    const providerReportedCostCents: (number | null)[] = [];
    const system = structuredSystemPrompt(request.outputSchema);
    const maximumWireCalls = request.repairTaskOutput ? 2 : 1;
    const campaignReservationCents =
      request.perCallCostCapCents * maximumWireCalls;
    let campaignReservationActive = false;
    const closeCampaignReservation = (settlement: CostSettlement): void => {
      if (!campaignReservationActive) return;
      reservedCampaignUpperBoundCents -= campaignReservationCents;
      campaignReservationActive = false;
      if (settlement.state === "settled") {
        committedCampaignCents += settlement.amountCents;
        if (committedCampaignCents > costSafety.limits.campaignBudgetCents) {
          campaignFrozen = true;
        }
      } else if (settlement.state === "unknown") {
        campaignFrozen = true;
      }
    };
    try {
      assertModelEvaluationCostSafetyDispatch(costSafety, {
        mode,
        alias: request.alias,
        protocol,
        maxOutputTokens: request.maxTokens,
        promptUtf8Bytes:
          Buffer.byteLength(system, "utf8") +
          Buffer.byteLength(request.casePayload.prompt, "utf8"),
        maximumWireCalls,
        perCallCostCapCents: request.perCallCostCapCents,
      });
      if (
        reservedDispatchExecutions + 1 >
          costSafety.limits.maxDispatchExecutions ||
        reservedWireCalls + maximumWireCalls > costSafety.limits.maxWireCalls ||
        campaignFrozen ||
        committedCampaignCents +
          reservedCampaignUpperBoundCents +
          campaignReservationCents >
          costSafety.limits.campaignBudgetCents
      ) {
        throw new Error("model evaluation campaign call cap exhausted");
      }
    } catch {
      throw preDispatchError("evaluation_cost_safety_rejected");
    }
    reservedDispatchExecutions += 1;
    reservedWireCalls += maximumWireCalls;
    reservedCampaignUpperBoundCents += campaignReservationCents;
    campaignReservationActive = true;

    const dispatch = async (
      prompt: string,
    ): Promise<NormalizedTextResponse> => {
      try {
        assertModelEvaluationCostSafetyDispatch(costSafety, {
          mode,
          alias: request.alias,
          protocol,
          maxOutputTokens: request.maxTokens,
          promptUtf8Bytes:
            Buffer.byteLength(system, "utf8") +
            Buffer.byteLength(prompt, "utf8"),
          maximumWireCalls: 1,
          perCallCostCapCents: request.perCallCostCapCents,
        });
      } catch {
        if (usage.callCount === 0) {
          const rejected = {
            state: "not_incurred",
            reason: "rejected_before_dispatch",
          } as const;
          closeCampaignReservation(rejected);
          throw new ModelEvaluationCallError(
            "evaluation_cost_safety_rejected",
            rejected,
          );
        }
        const settlement = await safeResolveSettlement(
          settlementResolver,
          {
            executionId: request.executionId,
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: settlementUsage(usage),
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error: new Error("evaluation_prompt_cost_safety_rejected"),
          },
          costSafety,
        );
        closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          "evaluation_cost_safety_rejected",
          settlement,
        );
      }
      if (campaignFrozen || request.signal.aborted) {
        if (usage.callCount === 0) {
          const rejected = {
            state: "not_incurred",
            reason: "rejected_before_dispatch",
          } as const;
          closeCampaignReservation(rejected);
          throw new ModelEvaluationCallError(
            request.signal.aborted
              ? "evaluation_aborted"
              : "evaluation_cost_safety_rejected",
            rejected,
          );
        }
        const error = new Error(
          request.signal.aborted
            ? "evaluation_aborted_before_wire_dispatch"
            : "evaluation_campaign_frozen_before_wire_dispatch",
        );
        const settlement = await safeResolveSettlement(
          settlementResolver,
          {
            executionId: request.executionId,
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: settlementUsage(usage),
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error,
          },
          costSafety,
        );
        closeCampaignReservation(settlement);
        campaignFrozen = true;
        throw new ModelEvaluationCallError(
          request.signal.aborted
            ? "evaluation_aborted"
            : "evaluation_cost_safety_rejected",
          settlement,
        );
      }
      let response: ModelEvaluationWireResponse;
      try {
        switch (protocol) {
          case "openai-responses":
            response = await wireClient.openAIResponses({
              executionId: request.executionId,
              body: {
                model: request.alias,
                input: Object.freeze([
                  { role: "system", content: system },
                  { role: "user", content: prompt },
                ]),
                max_output_tokens: request.maxTokens,
                temperature: 0,
                text: { format: { type: "json_object" } },
                ...(request.reasoningEffort
                  ? { reasoning: { effort: request.reasoningEffort } }
                  : {}),
              },
              signal: request.signal,
            });
            break;
          case "anthropic-messages":
            response = await wireClient.anthropicMessages({
              executionId: request.executionId,
              body: {
                model: request.alias,
                system,
                messages: Object.freeze([{ role: "user", content: prompt }]),
                max_tokens: request.maxTokens,
                temperature: 0,
              },
              signal: request.signal,
            });
            break;
          case "openai-chat-completions":
            response = await wireClient.openAIChatCompletions({
              executionId: request.executionId,
              body: {
                model: request.alias,
                messages: Object.freeze([
                  { role: "system", content: system },
                  { role: "user", content: prompt },
                ]),
                max_tokens: request.maxTokens,
                temperature: 0,
                response_format: { type: "json_object" },
                ...(request.reasoningEffort
                  ? { reasoning_effort: request.reasoningEffort }
                  : {}),
              },
              signal: request.signal,
            });
            break;
        }
      } catch (error) {
        usage.callCount += 1;
        usage.complete = false;
        providerReportedCostCents.push(null);
        const settlement = await safeResolveSettlement(
          settlementResolver,
          {
            executionId: request.executionId,
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: settlementUsage(usage),
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error,
          },
          costSafety,
        );
        closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          request.signal.aborted ? "evaluation_aborted" : "provider_error",
          settlement,
        );
      }

      let normalized: NormalizedTextResponse;
      let costObservationRecorded = false;
      try {
        if (!isRecord(response) || !("body" in response)) {
          throw new Error("evaluation_wire_response_invalid");
        }
        providerReportedCostCents.push(
          responseCost(response.providerReportedCostCents),
        );
        costObservationRecorded = true;
        normalized =
          protocol === "openai-responses"
            ? normalizeOpenAIResponses(response.body)
            : protocol === "anthropic-messages"
              ? normalizeAnthropicMessages(response.body)
              : normalizeOpenAIChatCompletions(response.body);
      } catch (error) {
        if (!costObservationRecorded) {
          providerReportedCostCents.push(null);
        }
        usage.callCount += 1;
        usage.complete = false;
        const settlement = await safeResolveSettlement(
          settlementResolver,
          {
            executionId: request.executionId,
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: settlementUsage(usage),
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error,
          },
          costSafety,
        );
        closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          "provider_response_invalid",
          settlement,
        );
      }
      if (
        normalized.usage &&
        (normalized.usage.outputTokens > request.maxTokens ||
          normalized.usage.outputTokens >
            costSafety.limits.maxOutputTokensPerCall)
      ) {
        addUsage(usage, normalized.usage);
        const settlement = await safeResolveSettlement(
          settlementResolver,
          {
            executionId: request.executionId,
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: settlementUsage(usage),
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error: new Error("evaluation_output_token_limit_exceeded"),
          },
          costSafety,
        );
        closeCampaignReservation(settlement);
        campaignFrozen = true;
        throw new ModelEvaluationCallError(
          "evaluation_output_token_limit_exceeded",
          settlement,
        );
      }
      addUsage(usage, normalized.usage);
      return normalized;
    };

    let normalized = await dispatch(request.casePayload.prompt);
    let artifact =
      normalized.artifactState === "complete" && normalized.rawText !== null
        ? artifactFromText(normalized.rawText)
        : undefined;
    const identityProven = normalized.reportedModel === request.alias;
    if (identityProven && artifact !== undefined && request.repairTaskOutput) {
      const failure = validationFailure(request, artifact);
      if (failure) {
        normalized = await dispatch(
          repairPrompt(
            request.casePayload.prompt,
            failure.kind,
            failure.reason,
          ),
        );
        artifact =
          normalized.artifactState === "complete" && normalized.rawText !== null
            ? artifactFromText(normalized.rawText)
            : undefined;
      }
    }

    const resolvedUsage = evaluationUsage(usage);
    const settlement = await safeResolveSettlement(
      settlementResolver,
      {
        executionId: request.executionId,
        taskId: request.taskId,
        alias: request.alias,
        protocol,
        outcome: "completed",
        callCount: usage.callCount,
        usage: settlementUsage(usage),
        providerReportedCostCents: Object.freeze([
          ...providerReportedCostCents,
        ]),
      },
      costSafety,
    );
    closeCampaignReservation(settlement);
    if (!resolvedUsage) {
      throw new ModelEvaluationCallError("usage_unavailable", settlement);
    }

    const reportedModel = normalized.reportedModel;
    const result: ModelEvaluationCallResult<unknown> = {
      artifactState: normalized.artifactState,
      ...(artifact !== undefined
        ? {
            artifact,
            artifactSha256: sha256CanonicalJson(artifact),
          }
        : {}),
      actualProtocol: protocol,
      requestedModel: request.alias,
      ...(reportedModel ? { reportedModel } : {}),
      resolvedModel: reportedModel ?? request.alias,
      modelResolutionSource: reportedModel
        ? "upstream_response"
        : "requested_fallback",
      usage: resolvedUsage,
      costSettlement: settlement,
    };
    return result as ModelEvaluationCallResult<T>;
  };

  const execute = Object.freeze(
    <T>(
      request:
        ModelEvaluationExecutionRequest | CapabilityProbeExecutionRequest,
    ) => executeWithMode<T>(request, "target"),
  );
  const executorIdentity = Object.freeze({});
  CLAIMED_MODEL_EVALUATION_AUTHORIZATIONS.add(
    costSafety.authorization.authorizationId,
  );
  TRUSTED_MODEL_EVALUATION_EXECUTOR_COST_SAFETY.set(
    executorIdentity,
    costSafety,
  );
  TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS.set(executorIdentity, () => {
    campaignFrozen = true;
  });
  APPLY_TRUSTED_EXECUTE_INTRINSIC(
    TRUSTED_EXECUTE_SET,
    TRUSTED_MODEL_EVALUATION_EXECUTES,
    [execute, executorIdentity],
  );
  const executeLegacyComparator = Object.freeze(
    <T>(request: ModelEvaluationExecutionRequest) =>
      executeWithMode<T>(request, "legacy_comparator"),
  );
  return Object.freeze({
    execute,
    executeLegacyComparator,
  });
}
