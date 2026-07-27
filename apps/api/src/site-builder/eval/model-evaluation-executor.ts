import {
  getModelCandidateCatalogEntry,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";
import { BRAND_PROFILE_TASK } from "../agents/brand-profile";
import { checkAgainstSchema } from "../../model-gateway/schema-validate";
import {
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
  ModelEvaluationCallError,
  type CapabilityProbeExecutionRequest,
  type CostSettlement,
  type ModelEvaluationCallResult,
  type ModelEvaluationExecutionRequest,
  type ModelEvaluationUsage,
} from "./model-evaluation-harness";
import { sha256CanonicalJson } from "./eval-provenance";

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

export interface ModelEvaluationSettlementContext {
  taskId: ModelEvaluationExecutionRequest["taskId"];
  alias: string;
  protocol: ModelCandidateProtocol;
  outcome: "completed" | "failed";
  callCount: number;
  usage: ModelEvaluationUsage | null;
  providerReportedCostCents: readonly (number | null)[];
  error?: unknown;
}

export interface ModelEvaluationSettlementResolver {
  readonly resolverId: string;
  resolve(
    context: Readonly<ModelEvaluationSettlementContext>,
  ): CostSettlement | Promise<CostSettlement>;
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
  context?: ModelEvaluationSettlementContext,
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
        Math.abs(providerReportedAmount - value.amountCents) <= 1e-9))
  ) {
    return {
      state: "settled",
      amountCents: value.amountCents,
      basis: value.basis as Extract<
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
    value.reason === "provider_attested_not_incurred"
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
  } else if (
    catalog.status !== "legacy-only" ||
    catalog.domain !== "text" ||
    request.expectedProtocol !== "openai-chat-completions"
  ) {
    throw preDispatchError("legacy_comparator_not_admitted");
  } else {
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

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0
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
  const reportedModel = optionalTrimmedString(body.model);
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
  const reportedModel = optionalTrimmedString(body.model);
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
  const reportedModel = optionalTrimmedString(body.model);
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
  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
}

function evaluationUsage(
  accumulator: UsageAccumulator,
): ModelEvaluationUsage | null {
  if (!accumulator.complete || accumulator.callCount < 1) return null;
  return {
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    callCount: accumulator.callCount,
    source:
      accumulator.callCount === 1 ? "provider_reported" : "adapter_aggregated",
  };
}

async function safeResolveSettlement(
  resolver: ModelEvaluationSettlementResolver,
  context: ModelEvaluationSettlementContext,
): Promise<CostSettlement> {
  try {
    return canonicalSettlement(
      await resolver.resolve(Object.freeze({ ...context })),
      true,
      context,
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
}): ModelEvaluationProtocolExecutor {
  if (!deps?.wireClient || !deps.settlementResolver?.resolverId) {
    throw new Error(
      "evaluation wire client and auditable settlement resolver are required",
    );
  }

  const executeWithMode = async <T>(
    request: EvaluationExecutionRequest,
    mode: "target" | "legacy_comparator",
  ): Promise<ModelEvaluationCallResult<T>> => {
    const protocol = assertCanonicalRequest(request, mode);
    const usage: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      complete: true,
    };
    const providerReportedCostCents: (number | null)[] = [];
    const system = structuredSystemPrompt(request.outputSchema);

    const dispatch = async (
      prompt: string,
    ): Promise<NormalizedTextResponse> => {
      let response: ModelEvaluationWireResponse;
      try {
        switch (protocol) {
          case "openai-responses":
            response = await deps.wireClient.openAIResponses({
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
            response = await deps.wireClient.anthropicMessages({
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
            response = await deps.wireClient.openAIChatCompletions({
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
          deps.settlementResolver,
          {
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: null,
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error,
          },
        );
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
          deps.settlementResolver,
          {
            taskId: request.taskId,
            alias: request.alias,
            protocol,
            outcome: "failed",
            callCount: usage.callCount,
            usage: null,
            providerReportedCostCents: Object.freeze([
              ...providerReportedCostCents,
            ]),
            error,
          },
        );
        throw new ModelEvaluationCallError(
          "provider_response_invalid",
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
    const settlement = await safeResolveSettlement(deps.settlementResolver, {
      taskId: request.taskId,
      alias: request.alias,
      protocol,
      outcome: "completed",
      callCount: usage.callCount,
      usage: resolvedUsage,
      providerReportedCostCents: Object.freeze([...providerReportedCostCents]),
    });
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

  return Object.freeze({
    execute: <T>(
      request:
        ModelEvaluationExecutionRequest | CapabilityProbeExecutionRequest,
    ) => executeWithMode<T>(request, "target"),
    executeLegacyComparator: <T>(request: ModelEvaluationExecutionRequest) =>
      executeWithMode<T>(request, "legacy_comparator"),
  });
}
