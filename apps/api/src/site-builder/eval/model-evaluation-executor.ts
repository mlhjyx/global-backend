import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
export const MODEL_EVALUATION_TRANSPORT_RESPONSE_BODY_LIMIT_BYTES =
  2_097_152 as const;

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
  readonly credentialBearerTokenSha256?: string;
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
    credentialBearerTokenSha256: string;
  }>
>();

export interface ModelEvaluationCredentialHandle {
  readonly attestationId: string;
  readonly snapshotSha256: string;
  readonly bearerTokenSha256: string;
  readonly bearerToken: string;
}

class ModelEvaluationWireHttpError extends Error {
  readonly providerReportedCostCents?: number;

  constructor(status: number, providerReportedCostCents?: number) {
    super(`evaluation transport HTTP ${status}`);
    this.name = "ModelEvaluationWireHttpError";
    this.providerReportedCostCents = providerReportedCostCents;
  }
}

export function createCredentialBoundModelEvaluationWireClient(options: {
  credential: ModelEvaluationCredentialHandle;
  baseUrl: string;
  fetch: typeof fetch;
}): ModelEvaluationWireClient {
  const credential = options?.credential;
  const fetchImpl = options?.fetch;
  const normalizedBaseUrl =
    typeof options?.baseUrl === "string"
      ? options.baseUrl.replace(/\/+$/, "")
      : "";
  if (
    !credential ||
    typeof credential.attestationId !== "string" ||
    credential.attestationId.length === 0 ||
    !/^[a-f0-9]{64}$/.test(credential.snapshotSha256) ||
    !/^[a-f0-9]{64}$/.test(credential.bearerTokenSha256) ||
    typeof credential.bearerToken !== "string" ||
    credential.bearerToken.length < 8 ||
    createHash("sha256").update(credential.bearerToken).digest("hex") !==
      credential.bearerTokenSha256 ||
    !/^https:\/\/[^/\s]+(?:\/.*)?$/.test(normalizedBaseUrl) ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error(
      "attested evaluation credential handle, HTTPS base URL, and fetch are required",
    );
  }
  const bearerToken = credential.bearerToken;
  const capturedFetch = fetchImpl.bind(globalThis);
  const readBoundedJsonBody = async (response: Response): Promise<unknown> => {
    const declaredLength = response.headers.get("content-length");
    if (
      declaredLength !== null &&
      Number.isSafeInteger(Number(declaredLength)) &&
      Number(declaredLength) >
        MODEL_EVALUATION_TRANSPORT_RESPONSE_BODY_LIMIT_BYTES
    ) {
      await response.body?.cancel();
      throw new Error("evaluation transport response body exceeds byte limit");
    }
    if (!response.body) {
      throw new Error("evaluation transport response body is missing");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > MODEL_EVALUATION_TRANSPORT_RESPONSE_BODY_LIMIT_BYTES) {
          await reader.cancel();
          throw new Error(
            "evaluation transport response body exceeds byte limit",
          );
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bodyBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
    );
  };
  const dispatch = async (
    path: string,
    executionId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<ModelEvaluationWireResponse> => {
    const response = await capturedFetch(`${normalizedBaseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "content-type": "application/json",
        "x-site-builder-evaluation-execution-id": executionId,
        ...(path === "/messages" ? { "anthropic-version": "2023-06-01" } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
    const providerCostHeader = response.headers.get("x-provider-cost-cents");
    const providerReportedCostCents =
      providerCostHeader !== null && providerCostHeader.trim() !== ""
        ? Number(providerCostHeader)
        : undefined;
    const validProviderReportedCostCents =
      providerReportedCostCents !== undefined &&
      Number.isFinite(providerReportedCostCents) &&
      providerReportedCostCents >= 0
        ? providerReportedCostCents
        : undefined;
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelEvaluationWireHttpError(
        response.status,
        validProviderReportedCostCents,
      );
    }
    return {
      body: await readBoundedJsonBody(response),
      ...(validProviderReportedCostCents !== undefined
        ? { providerReportedCostCents: validProviderReportedCostCents }
        : {}),
    };
  };
  const bound = Object.freeze({
    credentialAttestationId: credential.attestationId,
    credentialSnapshotSha256: credential.snapshotSha256,
    credentialBearerTokenSha256: credential.bearerTokenSha256,
    openAIResponses: Object.freeze(
      (request: OpenAIResponsesEvaluationWireRequest) =>
        dispatch(
          "/responses",
          request.executionId,
          request.body,
          request.signal,
        ),
    ),
    anthropicMessages: Object.freeze(
      (request: AnthropicMessagesEvaluationWireRequest) =>
        dispatch(
          "/messages",
          request.executionId,
          request.body,
          request.signal,
        ),
    ),
    openAIChatCompletions: Object.freeze(
      (request: OpenAIChatCompletionsEvaluationWireRequest) =>
        dispatch(
          "/chat/completions",
          request.executionId,
          request.body,
          request.signal,
        ),
    ),
  }) satisfies ModelEvaluationWireClient;
  TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS.set(
    bound,
    Object.freeze({
      credentialAttestationId: credential.attestationId,
      credentialSnapshotSha256: credential.snapshotSha256,
      credentialBearerTokenSha256: credential.bearerTokenSha256,
    }),
  );
  return bound;
}

export interface ModelEvaluationAuthorizationLedgerClaim {
  authorizationId: string;
  executorClaimId: string;
  campaignBudgetCents: number;
  maxDispatchExecutions: number;
  maxWireCalls: number;
}

export interface ModelEvaluationAuthorizationLedgerReservation {
  authorizationId: string;
  executorClaimId: string;
  executionId: string;
  wireCalls: number;
  upperBoundCents: number;
}

export interface ModelEvaluationAuthorizationLedgerSettlement {
  authorizationId: string;
  executorClaimId: string;
  executionId: string;
  settlement: CostSettlement;
}

export interface ModelEvaluationAuthorizationLedger {
  readonly ledgerId: string;
  readonly directorySha256: string;
  claim(
    claim: Readonly<ModelEvaluationAuthorizationLedgerClaim>,
  ): boolean | Promise<boolean>;
  reserve(
    reservation: Readonly<ModelEvaluationAuthorizationLedgerReservation>,
  ): boolean | Promise<boolean>;
  settle(
    settlement: Readonly<ModelEvaluationAuthorizationLedgerSettlement>,
  ): boolean | Promise<boolean>;
  freeze(
    claim: Readonly<{
      authorizationId: string;
      executorClaimId: string;
      reason: string;
    }>,
  ): boolean | Promise<boolean>;
}

const TRUSTED_MODEL_EVALUATION_AUTHORIZATION_LEDGERS = new WeakSet<object>();
const LEDGER_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

function resolveLedgerDirectoryIdentity(directory: string): Readonly<{
  directory: string;
  sha256: string;
}> {
  const absoluteDirectory = resolve(directory);
  mkdirSync(absoluteDirectory, { recursive: true, mode: 0o700 });
  const stats = lstatSync(absoluteDirectory, { bigint: true });
  const realDirectory = realpathSync.native(absoluteDirectory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    realDirectory !== absoluteDirectory
  ) {
    throw new Error(
      "evaluation authorization ledger directory must be a stable real directory",
    );
  }
  return Object.freeze({
    directory: realDirectory,
    sha256: createHash("sha256")
      .update(
        `${realDirectory}\0${stats.dev.toString()}\0${stats.ino.toString()}`,
      )
      .digest("hex"),
  });
}

export function modelEvaluationLedgerDirectorySha256(
  directory: string,
): string {
  if (typeof directory !== "string" || !isAbsolute(directory)) {
    throw new Error(
      "absolute durable evaluation authorization ledger directory is required",
    );
  }
  return resolveLedgerDirectoryIdentity(directory).sha256;
}

export function createFileBackedModelEvaluationAuthorizationLedger(options: {
  ledgerId: string;
  directory: string;
}): ModelEvaluationAuthorizationLedger {
  if (
    !LEDGER_ID.test(options?.ledgerId ?? "") ||
    typeof options?.directory !== "string" ||
    !isAbsolute(options.directory)
  ) {
    throw new Error(
      "absolute durable evaluation authorization ledger directory is required",
    );
  }
  const directoryIdentity = resolveLedgerDirectoryIdentity(options.directory);
  const assertDirectoryIdentity = (): void => {
    if (
      resolveLedgerDirectoryIdentity(directoryIdentity.directory).sha256 !==
      directoryIdentity.sha256
    ) {
      throw new Error(
        "evaluation authorization ledger directory identity changed",
      );
    }
  };
  type LedgerState = {
    claimId: string;
    filePath: string;
    budgetCents: number;
    maxExecutions: number;
    maxWireCalls: number;
    executions: number;
    wireCalls: number;
    committedCents: number;
    reservedCents: number;
    frozen: boolean;
    reservations: Map<string, number>;
  };
  const states = new Map<string, LedgerState>();
  const writeAllSync = (descriptor: number, value: string): void => {
    const payload = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset < payload.byteLength) {
      const written = writeSync(
        descriptor,
        payload,
        offset,
        payload.byteLength - offset,
      );
      if (!Number.isSafeInteger(written) || written <= 0) {
        throw new Error("durable evaluation ledger write was incomplete");
      }
      offset += written;
    }
  };
  const appendDurably = (filePath: string, value: unknown): void => {
    assertDirectoryIdentity();
    const descriptor = openSync(filePath, "a", 0o600);
    try {
      writeAllSync(descriptor, `${JSON.stringify(value)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  };
  const ledger: ModelEvaluationAuthorizationLedger = {
    ledgerId: options.ledgerId,
    directorySha256: directoryIdentity.sha256,
    claim: (input) => {
      if (states.has(input.authorizationId)) return false;
      assertDirectoryIdentity();
      const filePath = join(
        directoryIdentity.directory,
        `${createHash("sha256")
          .update(input.authorizationId)
          .digest("hex")}.jsonl`,
      );
      let descriptor;
      try {
        descriptor = openSync(filePath, "wx", 0o600);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          return false;
        }
        throw error;
      }
      try {
        writeAllSync(
          descriptor,
          `${JSON.stringify({
            event: "authorization_claimed",
            ...input,
          })}\n`,
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const directoryDescriptor = openSync(directoryIdentity.directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      states.set(input.authorizationId, {
        claimId: input.executorClaimId,
        filePath,
        budgetCents: input.campaignBudgetCents,
        maxExecutions: input.maxDispatchExecutions,
        maxWireCalls: input.maxWireCalls,
        executions: 0,
        wireCalls: 0,
        committedCents: 0,
        reservedCents: 0,
        frozen: false,
        reservations: new Map(),
      });
      return true;
    },
    reserve: (input) => {
      const state = states.get(input.authorizationId);
      if (
        !state ||
        state.claimId !== input.executorClaimId ||
        state.frozen ||
        state.reservations.has(input.executionId) ||
        state.executions + 1 > state.maxExecutions ||
        state.wireCalls + input.wireCalls > state.maxWireCalls ||
        state.committedCents + state.reservedCents + input.upperBoundCents >
          state.budgetCents
      ) {
        return false;
      }
      appendDurably(state.filePath, {
        event: "dispatch_reserved",
        ...input,
      });
      state.executions += 1;
      state.wireCalls += input.wireCalls;
      state.reservedCents += input.upperBoundCents;
      state.reservations.set(input.executionId, input.upperBoundCents);
      return true;
    },
    settle: (input) => {
      const state = states.get(input.authorizationId);
      const reservation = state?.reservations.get(input.executionId);
      if (
        !state ||
        state.claimId !== input.executorClaimId ||
        reservation === undefined
      ) {
        return false;
      }
      appendDurably(state.filePath, {
        event: "dispatch_settled",
        ...input,
      });
      state.reservations.delete(input.executionId);
      state.reservedCents -= reservation;
      if (input.settlement.state === "settled") {
        state.committedCents += input.settlement.amountCents;
        if (state.committedCents > state.budgetCents) state.frozen = true;
      } else if (input.settlement.state === "unknown") {
        state.frozen = true;
      }
      return true;
    },
    freeze: (input) => {
      const state = states.get(input.authorizationId);
      if (!state || state.claimId !== input.executorClaimId) return false;
      appendDurably(state.filePath, {
        event: "authorization_frozen",
        ...input,
      });
      state.frozen = true;
      return true;
    },
  };
  const trusted = Object.freeze(ledger);
  TRUSTED_MODEL_EVALUATION_AUTHORIZATION_LEDGERS.add(trusted);
  return trusted;
}

function isTrustedModelEvaluationAuthorizationLedger(
  value: unknown,
): value is ModelEvaluationAuthorizationLedger {
  return (
    !!value &&
    typeof value === "object" &&
    TRUSTED_MODEL_EVALUATION_AUTHORIZATION_LEDGERS.has(value)
  );
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
      executionId?: string;
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
  () => Promise<void>
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

export async function freezeModelEvaluationProtocolExecutor(
  value: unknown,
): Promise<boolean> {
  const identity = modelEvaluationProtocolExecutorIdentity(value);
  const freeze = identity
    ? TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS.get(identity)
    : undefined;
  if (!freeze) return false;
  await freeze();
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
    exactKeys(value, ["state", "amountCents", "basis", "executionId"]) &&
    typeof value.amountCents === "number" &&
    Number.isFinite(value.amountCents) &&
    value.amountCents >= 0 &&
    typeof value.basis === "string" &&
    SETTLED_BASES.has(value.basis) &&
    context !== undefined &&
    value.executionId === context.executionId &&
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
  authorizationLedger: ModelEvaluationAuthorizationLedger;
}): ModelEvaluationProtocolExecutor {
  const wireReceiver = deps?.wireClient;
  const openAIResponses = wireReceiver?.openAIResponses;
  const anthropicMessages = wireReceiver?.anthropicMessages;
  const openAIChatCompletions = wireReceiver?.openAIChatCompletions;
  const resolverReceiver = deps?.settlementResolver;
  const resolverId = resolverReceiver?.resolverId;
  const resolverResolve = resolverReceiver?.resolve;
  const costSafety = deps?.costSafety;
  const authorizationLedger = deps?.authorizationLedger;
  const credentialAttestationId = wireReceiver?.credentialAttestationId;
  const credentialSnapshotSha256 = wireReceiver?.credentialSnapshotSha256;
  const credentialBearerTokenSha256 = wireReceiver?.credentialBearerTokenSha256;
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
    !isTrustedModelEvaluationAuthorizationLedger(authorizationLedger) ||
    authorizationLedger.ledgerId !== costSafety.authorization.ledgerId ||
    authorizationLedger.directorySha256 !==
      costSafety.authorization.ledgerDirectorySha256 ||
    costSafety.pricing.resolverId !== resolverId ||
    trustedWireCredential?.credentialAttestationId !==
      credentialAttestationId ||
    trustedWireCredential?.credentialSnapshotSha256 !==
      credentialSnapshotSha256 ||
    trustedWireCredential?.credentialBearerTokenSha256 !==
      credentialBearerTokenSha256 ||
    credentialAttestationId !== costSafety.credential.attestationId ||
    credentialSnapshotSha256 !== costSafety.credential.snapshotSha256 ||
    credentialBearerTokenSha256 !== costSafety.credential.bearerTokenSha256 ||
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
    credentialBearerTokenSha256,
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
  const executorClaimId = randomUUID();
  let durableClaim:
    Promise<Readonly<{ claimed: boolean; error: unknown | null }>> | undefined;
  const claimDurableAuthorization = () => {
    durableClaim ??= Promise.resolve()
      .then(() =>
        authorizationLedger.claim(
          Object.freeze({
            authorizationId: costSafety.authorization.authorizationId,
            executorClaimId,
            campaignBudgetCents: costSafety.limits.campaignBudgetCents,
            maxDispatchExecutions: costSafety.limits.maxDispatchExecutions,
            maxWireCalls: costSafety.limits.maxWireCalls,
          }),
        ),
      )
      .then(
        (claimed) =>
          Object.freeze({
            claimed: claimed === true,
            error: claimed === true ? null : new Error("claim rejected"),
          }),
        (error: unknown) => Object.freeze({ claimed: false, error }),
      );
    return durableClaim;
  };
  const freezeDurableAuthorization = async (reason: string): Promise<void> => {
    campaignFrozen = true;
    const claim = await claimDurableAuthorization();
    if (!claim.claimed) return;
    try {
      const frozen = await authorizationLedger.freeze(
        Object.freeze({
          authorizationId: costSafety.authorization.authorizationId,
          executorClaimId,
          reason,
        }),
      );
      if (frozen !== true) campaignFrozen = true;
    } catch {
      campaignFrozen = true;
    }
  };

  const executeWithMode = async <T>(
    request: EvaluationExecutionRequest,
    mode: "target" | "legacy_comparator",
  ): Promise<ModelEvaluationCallResult<T>> => {
    const claim = await claimDurableAuthorization();
    if (!claim.claimed) {
      campaignFrozen = true;
      throw preDispatchError("evaluation_cost_safety_rejected");
    }
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
    const closeCampaignReservation = async (
      settlement: CostSettlement,
    ): Promise<CostSettlement> => {
      if (!campaignReservationActive) return settlement;
      reservedCampaignUpperBoundCents -= campaignReservationCents;
      campaignReservationActive = false;
      let effectiveSettlement = settlement;
      try {
        const persisted = await authorizationLedger.settle(
          Object.freeze({
            authorizationId: costSafety.authorization.authorizationId,
            executorClaimId,
            executionId: request.executionId,
            settlement,
          }),
        );
        if (persisted !== true) {
          await freezeDurableAuthorization("settlement_persistence_rejected");
          effectiveSettlement = {
            state: "unknown",
            reason: "invalid_settlement",
          };
        }
      } catch {
        await freezeDurableAuthorization("settlement_persistence_failed");
        effectiveSettlement = {
          state: "unknown",
          reason: "invalid_settlement",
        };
      }
      if (effectiveSettlement.state === "settled") {
        committedCampaignCents += effectiveSettlement.amountCents;
        if (
          effectiveSettlement.amountCents > request.perCallCostCapCents ||
          committedCampaignCents > costSafety.limits.campaignBudgetCents
        ) {
          await freezeDurableAuthorization("settled_cost_cap_exceeded");
        }
      } else if (effectiveSettlement.state === "unknown") {
        await freezeDurableAuthorization("unknown_settlement");
      }
      return effectiveSettlement;
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
    try {
      const persisted = await authorizationLedger.reserve(
        Object.freeze({
          authorizationId: costSafety.authorization.authorizationId,
          executorClaimId,
          executionId: request.executionId,
          wireCalls: maximumWireCalls,
          upperBoundCents: campaignReservationCents,
        }),
      );
      if (persisted !== true) {
        throw new Error("durable reservation rejected");
      }
    } catch {
      reservedDispatchExecutions -= 1;
      reservedWireCalls -= maximumWireCalls;
      reservedCampaignUpperBoundCents -= campaignReservationCents;
      campaignReservationActive = false;
      await freezeDurableAuthorization("reservation_persistence_failed");
      throw preDispatchError("evaluation_cost_safety_rejected");
    }

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
          const effectiveSettlement = await closeCampaignReservation(rejected);
          throw new ModelEvaluationCallError(
            "evaluation_cost_safety_rejected",
            effectiveSettlement,
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
        const effectiveSettlement = await closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          "evaluation_cost_safety_rejected",
          effectiveSettlement,
        );
      }
      if (campaignFrozen || request.signal.aborted) {
        if (usage.callCount === 0) {
          const rejected = {
            state: "not_incurred",
            reason: "rejected_before_dispatch",
          } as const;
          const effectiveSettlement = await closeCampaignReservation(rejected);
          throw new ModelEvaluationCallError(
            request.signal.aborted
              ? "evaluation_aborted"
              : "evaluation_cost_safety_rejected",
            effectiveSettlement,
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
        const effectiveSettlement = await closeCampaignReservation(settlement);
        campaignFrozen = true;
        throw new ModelEvaluationCallError(
          request.signal.aborted
            ? "evaluation_aborted"
            : "evaluation_cost_safety_rejected",
          effectiveSettlement,
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
        providerReportedCostCents.push(
          error instanceof ModelEvaluationWireHttpError
            ? responseCost(error.providerReportedCostCents)
            : null,
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
        const effectiveSettlement = await closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          request.signal.aborted ? "evaluation_aborted" : "provider_error",
          effectiveSettlement,
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
        const effectiveSettlement = await closeCampaignReservation(settlement);
        throw new ModelEvaluationCallError(
          "provider_response_invalid",
          effectiveSettlement,
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
        const effectiveSettlement = await closeCampaignReservation(settlement);
        campaignFrozen = true;
        throw new ModelEvaluationCallError(
          "evaluation_output_token_limit_exceeded",
          effectiveSettlement,
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
    let settlement = await safeResolveSettlement(
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
    settlement = await closeCampaignReservation(settlement);
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
  TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS.set(executorIdentity, () =>
    freezeDurableAuthorization("harness_hard_stop"),
  );
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
