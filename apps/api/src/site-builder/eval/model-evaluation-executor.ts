import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { modelEvaluationRuntimeIntegrityMatches } from "./model-evaluation-runtime-integrity";
import {
  getModelCandidateCatalogEntry,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";
import { BRAND_PROFILE_TASK } from "../agents/brand-profile";
import { COPY_TASK } from "../agents/copy";
import { ASSEMBLE_TASK, ASSEMBLY_FIX_TASK } from "../agents/controlled-assembly";
import type { SiteBuilderTaskId } from "../agents/task-route-bindings";
import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import { QA_SUMMARIZE_TASK, SEO_REVIEW_TASK } from "../quality/quality-narrative";
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
  MODEL_EVALUATION_REPAIR_REASON_UTF8_BYTES_UPPER_BOUND,
  assertModelEvaluationCostSafetyDispatch,
  frozenModelEvaluationPriceCents,
  isAllowedModelEvaluationGatewayOrigin,
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

const RETIRED_EVALUATION_COMPARATOR_ALIASES = new Set([
  "minimax-m3",
  "doubao-seed-2.0-pro",
  "doubao-seed-2.0-lite",
]);

const CAPTURED_MODEL_EVALUATION_TASK_SYSTEM_PROMPTS = Object.freeze({
  "site_builder.brand_profile": BRAND_PROFILE_TASK.system ?? "",
  "site_builder.copy": COPY_TASK.system ?? "",
  "site_builder.design_spec": DESIGN_SPEC_TASK.system ?? "",
  "site_builder.assemble": ASSEMBLE_TASK.system ?? "",
  "site_builder.assembly_fix": ASSEMBLY_FIX_TASK.system ?? "",
  "site_builder.qa_summarize": QA_SUMMARIZE_TASK.system ?? "",
  "site_builder.seo_review": SEO_REVIEW_TASK.system ?? "",
} as const);

const CAPTURED_BRAND_PROFILE_VALIDATE_OUTPUT = (() => {
  const validator = BRAND_PROFILE_TASK.validateOutput;
  if (!validator) {
    throw new Error("BrandProfile canonical route validator is required");
  }
  return validator;
})();

const CAPTURED_DESIGN_SPEC_VALIDATE_OUTPUT = (() => {
  const validator = DESIGN_SPEC_TASK.validateOutput;
  if (!validator) {
    throw new Error("DesignSpec canonical route validator is required");
  }
  return validator;
})();
const CAPTURED_COPY_VALIDATE_OUTPUT = COPY_TASK.validateOutput!;
const CAPTURED_ASSEMBLE_VALIDATE_OUTPUT = ASSEMBLE_TASK.validateOutput!;
const CAPTURED_ASSEMBLY_FIX_VALIDATE_OUTPUT = ASSEMBLY_FIX_TASK.validateOutput!;
const CAPTURED_QA_SUMMARIZE_VALIDATE_OUTPUT = QA_SUMMARIZE_TASK.validateOutput!;
const CAPTURED_SEO_REVIEW_VALIDATE_OUTPUT = SEO_REVIEW_TASK.validateOutput!;

function taskValidatorMatchesCapturedIdentity(
  taskId: SiteBuilderTaskId,
): boolean {
  if (taskId === "site_builder.brand_profile") {
    return true;
  }
  return taskDefinition(taskId).validateOutput === capturedTaskValidator(taskId);
}

function capturedTaskValidator(taskId: SiteBuilderTaskId) {
  switch (taskId) {
    case "site_builder.brand_profile": return CAPTURED_BRAND_PROFILE_VALIDATE_OUTPUT;
    case "site_builder.copy": return CAPTURED_COPY_VALIDATE_OUTPUT;
    case "site_builder.design_spec": return CAPTURED_DESIGN_SPEC_VALIDATE_OUTPUT;
    case "site_builder.assemble": return CAPTURED_ASSEMBLE_VALIDATE_OUTPUT;
    case "site_builder.assembly_fix": return CAPTURED_ASSEMBLY_FIX_VALIDATE_OUTPUT;
    case "site_builder.qa_summarize": return CAPTURED_QA_SUMMARIZE_VALIDATE_OUTPUT;
    case "site_builder.seo_review": return CAPTURED_SEO_REVIEW_VALIDATE_OUTPUT;
  }
}

function capturedTaskSystemPrompt(taskId: SiteBuilderTaskId): string {
  return CAPTURED_MODEL_EVALUATION_TASK_SYSTEM_PROMPTS[taskId];
}

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
  readonly credentialGatewayOrigin?: string;
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
    credentialGatewayOrigin: string;
  }>
>();
const MODEL_EVALUATION_WEAK_MAP_GET = WeakMap.prototype.get;
const MODEL_EVALUATION_WEAK_MAP_SET = WeakMap.prototype.set;
const MODEL_EVALUATION_WEAK_SET_ADD = WeakSet.prototype.add;
const MODEL_EVALUATION_WEAK_SET_HAS = WeakSet.prototype.has;
const APPLY_MODEL_EVALUATION_INTRINSIC = Reflect.apply;

export interface ModelEvaluationCredentialHandle {
  readonly attestationId: string;
  readonly snapshotSha256: string;
  readonly bearerTokenSha256: string;
  readonly gatewayOrigin: string;
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

class ModelEvaluationWireResponseBodyError extends Error {
  readonly providerReportedCostCents?: number;

  constructor(providerReportedCostCents: number | undefined, cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "evaluation transport response body is invalid",
      { cause },
    );
    this.name = "ModelEvaluationWireResponseBodyError";
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
  let parsedBaseUrl: URL | undefined;
  try {
    parsedBaseUrl = new URL(normalizedBaseUrl);
  } catch {
    parsedBaseUrl = undefined;
  }
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
    !parsedBaseUrl ||
    !isAllowedModelEvaluationGatewayOrigin(parsedBaseUrl.origin) ||
    parsedBaseUrl.username !== "" ||
    parsedBaseUrl.password !== "" ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== "" ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error(
      "attested evaluation credential handle, HTTPS or explicit loopback HTTP base URL, and fetch are required",
    );
  }
  const gatewayOrigin = parsedBaseUrl.origin;
  if (credential.gatewayOrigin !== gatewayOrigin) {
    throw new Error(
      "attested evaluation credential gateway origin does not match",
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
      try {
        await response.body?.cancel();
      } catch {
        // Preserve the already parsed status and provider cost observation.
      }
      throw new ModelEvaluationWireHttpError(
        response.status,
        validProviderReportedCostCents,
      );
    }
    let responseBody: unknown;
    try {
      responseBody = await readBoundedJsonBody(response);
    } catch (error) {
      throw new ModelEvaluationWireResponseBodyError(
        validProviderReportedCostCents,
        error,
      );
    }
    return {
      body: responseBody,
      ...(validProviderReportedCostCents !== undefined
        ? { providerReportedCostCents: validProviderReportedCostCents }
        : {}),
    };
  };
  const bound = Object.freeze({
    credentialAttestationId: credential.attestationId,
    credentialSnapshotSha256: credential.snapshotSha256,
    credentialBearerTokenSha256: credential.bearerTokenSha256,
    credentialGatewayOrigin: gatewayOrigin,
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
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_MAP_SET,
    TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS,
    [
      bound,
      Object.freeze({
        credentialAttestationId: credential.attestationId,
        credentialSnapshotSha256: credential.snapshotSha256,
        credentialBearerTokenSha256: credential.bearerTokenSha256,
        credentialGatewayOrigin: gatewayOrigin,
      }),
    ],
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

class ModelEvaluationClaimLockContentionError extends Error {
  constructor(cause?: unknown) {
    super(
      "evaluation authorization claim index is locked; retry without reissuing authorization",
      cause === undefined ? undefined : { cause },
    );
    this.name = "ModelEvaluationClaimLockContentionError";
  }
}

function decodeLinuxMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function linuxMountGenerationIdentity(directory: string): string {
  const mountInfo = readFileSync("/proc/self/mountinfo", "utf8");
  let selected:
    | Readonly<{
        mountId: string;
        parentMountId: string;
        majorMinor: string;
        root: string;
        mountPoint: string;
      }>
    | undefined;
  for (const line of mountInfo.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split(" ");
    if (fields.length < 6) continue;
    const mountId = fields[0] ?? "";
    const parentMountId = fields[1] ?? "";
    const majorMinor = fields[2] ?? "";
    const root = decodeLinuxMountInfoPath(fields[3] ?? "");
    const mountPoint = decodeLinuxMountInfoPath(fields[4] ?? "");
    if (
      !/^\d+$/.test(mountId) ||
      !/^\d+$/.test(parentMountId) ||
      !/^\d+:\d+$/.test(majorMinor) ||
      root.length === 0 ||
      !mountPoint.startsWith("/")
    ) {
      continue;
    }
    const containsDirectory =
      mountPoint === "/" ||
      directory === mountPoint ||
      directory.startsWith(`${mountPoint}/`);
    if (
      containsDirectory &&
      (!selected || mountPoint.length > selected.mountPoint.length)
    ) {
      selected = { mountId, parentMountId, majorMinor, root, mountPoint };
    }
  }
  if (!selected) {
    throw new Error(
      "evaluation authorization ledger mount generation is unavailable",
    );
  }
  return [
    linuxBootId(),
    selected.mountId,
    selected.parentMountId,
    selected.majorMinor,
    selected.root,
    selected.mountPoint,
  ].join("\0");
}

function resolveLedgerDirectoryIdentity(directory: string): Readonly<{
  directory: string;
  sha256: string;
  baseSha256: string;
  markerPath: string;
  markerDevice: bigint;
  markerInode: bigint;
  markerCtimeNs: bigint;
  markerSize: bigint;
  claimedAuthorizationDigests: readonly string[];
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
  const mountGenerationIdentity = linuxMountGenerationIdentity(realDirectory);
  const markerPath = join(
    realDirectory,
    ".site-builder-model-evaluation-ledger-id",
  );
  let markerDescriptor: number | undefined;
  try {
    try {
      markerDescriptor = openSync(markerPath, "wx+", 0o600);
      writeFileSync(markerDescriptor, `${randomUUID()}\n`, "utf8");
      fsyncSync(markerDescriptor);
      closeSync(markerDescriptor);
      markerDescriptor = undefined;
      markerDescriptor = openSync(
        markerPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const directoryDescriptor = openSync(realDirectory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      markerDescriptor = openSync(
        markerPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    }
    const markerStats = fstatSync(markerDescriptor, { bigint: true });
    const marker = readFileSync(markerDescriptor, "utf8");
    const markerLines = marker.split("\n");
    const markerId = markerLines[0] ?? "";
    const claimLines = markerLines.slice(1, -1);
    if (
      !markerStats.isFile() ||
      markerStats.nlink !== 1n ||
      markerLines.at(-1) !== "" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        markerId,
      ) ||
      claimLines.some((line) => !/^claim:[a-f0-9]{64}$/.test(line))
    ) {
      throw new Error(
        "evaluation authorization ledger directory marker is invalid",
      );
    }
    const claimedAuthorizationDigests = claimLines.map((line) =>
      line.slice("claim:".length),
    );
    const baseIdentity = `${realDirectory}\0${stats.dev.toString()}\0${stats.ino.toString()}\0${markerStats.dev.toString()}\0${markerStats.ino.toString()}\0${markerId}\0${mountGenerationIdentity}`;
    const baseSha256 = createHash("sha256").update(baseIdentity).digest("hex");
    return Object.freeze({
      directory: realDirectory,
      sha256: createHash("sha256")
        .update(baseIdentity)
        .update("\0")
        .update(marker)
        .digest("hex"),
      baseSha256,
      markerPath,
      markerDevice: markerStats.dev,
      markerInode: markerStats.ino,
      markerCtimeNs: markerStats.ctimeNs,
      markerSize: markerStats.size,
      claimedAuthorizationDigests: Object.freeze(claimedAuthorizationDigests),
    });
  } finally {
    if (markerDescriptor !== undefined) closeSync(markerDescriptor);
  }
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

interface ModelEvaluationClaimLockOwner {
  pid: number;
  bootId: string;
  processStartTimeTicks: string;
  nonce: string;
}

function linuxBootId(): string {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[a-f0-9-]{36}$/.test(value)) {
    throw new Error("evaluation authorization claim lock boot id is invalid");
  }
  return value;
}

function linuxProcessStartTimeTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      throw new Error(
        "evaluation authorization claim lock process stat is malformed",
      );
    }
    const fields = stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/);
    const startTimeTicks = fields[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) {
      throw new Error(
        "evaluation authorization claim lock process start time is invalid",
      );
    }
    return startTimeTicks;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function parseClaimLockOwner(
  value: string,
): ModelEvaluationClaimLockOwner | null {
  try {
    const owner = JSON.parse(value) as Record<string, unknown>;
    if (
      Object.keys(owner).sort().join(",") !==
        "bootId,nonce,pid,processStartTimeTicks" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.bootId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner.bootId) ||
      typeof owner.processStartTimeTicks !== "string" ||
      !/^\d+$/.test(owner.processStartTimeTicks) ||
      typeof owner.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(owner.nonce)
    ) {
      return null;
    }
    return owner as unknown as ModelEvaluationClaimLockOwner;
  } catch {
    return null;
  }
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
  let observedClaimHistory = [...directoryIdentity.claimedAuthorizationDigests];
  const assertDirectoryIdentity = () => {
    const currentIdentity = resolveLedgerDirectoryIdentity(
      directoryIdentity.directory,
    );
    if (
      currentIdentity.baseSha256 !== directoryIdentity.baseSha256 ||
      currentIdentity.claimedAuthorizationDigests.length <
        observedClaimHistory.length ||
      observedClaimHistory.some(
        (digest, index) =>
          currentIdentity.claimedAuthorizationDigests[index] !== digest,
      )
    ) {
      throw new Error(
        "evaluation authorization ledger directory identity or append-only claim history changed",
      );
    }
    observedClaimHistory = [...currentIdentity.claimedAuthorizationDigests];
    return currentIdentity;
  };
  type LedgerState = {
    claimId: string;
    filePath: string;
    fileDevice: bigint;
    fileInode: bigint;
    fileCtimeNs: bigint;
    fileSize: bigint;
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
  const fsyncLedgerDirectory = (): void => {
    const directoryDescriptor = openSync(directoryIdentity.directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  };
  const claimLockContention = (
    cause?: unknown,
  ): ModelEvaluationClaimLockContentionError =>
    new ModelEvaluationClaimLockContentionError(cause);
  const acquireAuthorizationClaimLock = (
    lockPath: string,
  ): { descriptor: number; stats: BigIntStats } => {
    const bootId = linuxBootId();
    const processStartTimeTicks = linuxProcessStartTimeTicks(process.pid);
    if (processStartTimeTicks === null) {
      throw new Error(
        "evaluation authorization claim lock process identity is unavailable",
      );
    }
    const owner: ModelEvaluationClaimLockOwner = {
      pid: process.pid,
      bootId,
      processStartTimeTicks,
      nonce: randomUUID(),
    };
    const temporaryPath = `${lockPath}.${owner.pid}.${owner.nonce}.tmp`;
    const descriptor = openSync(temporaryPath, "wx+", 0o600);
    const descriptorStats = fstatSync(descriptor, { bigint: true });
    let linked = false;
    try {
      writeAllSync(descriptor, `${JSON.stringify(owner)}\n`);
      fsyncSync(descriptor);
      const acquire = (): void => {
        try {
          linkSync(temporaryPath, lockPath);
          linked = true;
          return;
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "EEXIST"
          ) {
            throw error;
          }
        }

        const existingDescriptor = openSync(
          lockPath,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        let existingStats: BigIntStats;
        let existingOwner: ModelEvaluationClaimLockOwner | null;
        try {
          existingStats = fstatSync(existingDescriptor, { bigint: true });
          existingOwner = parseClaimLockOwner(
            readFileSync(existingDescriptor, "utf8").trim(),
          );
        } finally {
          closeSync(existingDescriptor);
        }
        if (
          !existingStats.isFile() ||
          existingStats.isSymbolicLink() ||
          existingStats.nlink < 1n ||
          existingOwner === null
        ) {
          throw claimLockContention();
        }
        const existingProcessStartTimeTicks =
          existingOwner.bootId === bootId
            ? linuxProcessStartTimeTicks(existingOwner.pid)
            : null;
        if (
          existingOwner.bootId === bootId &&
          existingProcessStartTimeTicks === existingOwner.processStartTimeTicks
        ) {
          throw claimLockContention();
        }
        const currentStats = lstatSync(lockPath, { bigint: true });
        if (
          !currentStats.isFile() ||
          currentStats.isSymbolicLink() ||
          currentStats.dev !== existingStats.dev ||
          currentStats.ino !== existingStats.ino
        ) {
          throw claimLockContention();
        }
        unlinkSync(lockPath);
        const staleTemporaryPath = `${lockPath}.${existingOwner.pid}.${existingOwner.nonce}.tmp`;
        try {
          const staleTemporaryStats = lstatSync(staleTemporaryPath, {
            bigint: true,
          });
          if (
            staleTemporaryStats.isFile() &&
            !staleTemporaryStats.isSymbolicLink() &&
            staleTemporaryStats.dev === existingStats.dev &&
            staleTemporaryStats.ino === existingStats.ino
          ) {
            unlinkSync(staleTemporaryPath);
          }
        } catch (error) {
          if (
            typeof error !== "object" ||
            error === null ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
        fsyncLedgerDirectory();
        try {
          linkSync(temporaryPath, lockPath);
          linked = true;
        } catch (error) {
          throw claimLockContention(error);
        }
      };

      acquire();
      unlinkSync(temporaryPath);
      fsyncLedgerDirectory();
      const lockStats = fstatSync(descriptor, { bigint: true });
      if (
        !lockStats.isFile() ||
        lockStats.nlink !== 1n ||
        lockStats.dev !== descriptorStats.dev ||
        lockStats.ino !== descriptorStats.ino
      ) {
        throw new Error(
          "evaluation authorization claim index lock identity changed",
        );
      }
      return { descriptor, stats: lockStats };
    } catch (error) {
      try {
        const temporaryStats = lstatSync(temporaryPath, { bigint: true });
        if (
          temporaryStats.isFile() &&
          !temporaryStats.isSymbolicLink() &&
          temporaryStats.dev === descriptorStats.dev &&
          temporaryStats.ino === descriptorStats.ino
        ) {
          unlinkSync(temporaryPath);
        }
      } catch {
        // The temporary link may already be gone.
      }
      if (linked) {
        try {
          const currentStats = lstatSync(lockPath, { bigint: true });
          if (
            currentStats.isFile() &&
            !currentStats.isSymbolicLink() &&
            currentStats.dev === descriptorStats.dev &&
            currentStats.ino === descriptorStats.ino
          ) {
            unlinkSync(lockPath);
            fsyncLedgerDirectory();
          }
        } catch {
          // Preserve the original acquisition error.
        }
      }
      closeSync(descriptor);
      throw error;
    }
  };
  const appendAuthorizationClaimUnderLock = (
    authorizationId: string,
  ): boolean => {
    const authorizationDigest = createHash("sha256")
      .update(authorizationId)
      .digest("hex");
    const currentIdentity = assertDirectoryIdentity();
    if (
      currentIdentity.claimedAuthorizationDigests.includes(authorizationDigest)
    ) {
      return false;
    }
    const descriptor = openSync(
      currentIdentity.markerPath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.dev !== currentIdentity.markerDevice ||
        before.ino !== currentIdentity.markerInode ||
        before.ctimeNs !== currentIdentity.markerCtimeNs ||
        before.size !== currentIdentity.markerSize
      ) {
        throw new Error(
          "evaluation authorization ledger directory marker identity changed",
        );
      }
      const payload = `claim:${authorizationDigest}\n`;
      writeAllSync(descriptor, payload);
      fsyncSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (
        !after.isFile() ||
        after.nlink !== 1n ||
        after.dev !== currentIdentity.markerDevice ||
        after.ino !== currentIdentity.markerInode ||
        after.size !== before.size + BigInt(Buffer.byteLength(payload, "utf8"))
      ) {
        throw new Error(
          "evaluation authorization ledger directory marker changed during append",
        );
      }
      observedClaimHistory.push(authorizationDigest);
    } finally {
      closeSync(descriptor);
    }
    return true;
  };
  const appendAuthorizationClaimDurably = (
    authorizationId: string,
  ): boolean => {
    assertDirectoryIdentity();
    const lockPath = join(
      directoryIdentity.directory,
      ".site-builder-model-evaluation-claim.lock",
    );
    const { descriptor: lockDescriptor, stats: lockStats } =
      acquireAuthorizationClaimLock(lockPath);
    let result: boolean | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      fsyncSync(lockDescriptor);
      fsyncLedgerDirectory();
      result = appendAuthorizationClaimUnderLock(authorizationId);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      closeSync(lockDescriptor);
      const currentLockStats = lstatSync(lockPath, { bigint: true });
      if (
        !currentLockStats.isFile() ||
        currentLockStats.isSymbolicLink() ||
        currentLockStats.nlink !== 1n ||
        currentLockStats.dev !== lockStats.dev ||
        currentLockStats.ino !== lockStats.ino
      ) {
        throw new Error(
          "evaluation authorization claim index lock identity changed",
        );
      }
      unlinkSync(lockPath);
      fsyncLedgerDirectory();
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, cleanupError],
          "evaluation authorization claim and lock cleanup both failed",
        );
      }
      throw cleanupError;
    }
    if (operationFailed) throw operationError;
    if (result === undefined) {
      throw new Error("evaluation authorization claim result is missing");
    }
    return result;
  };
  const appendDurably = (state: LedgerState, value: unknown): void => {
    assertDirectoryIdentity();
    const descriptor = openSync(
      state.filePath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink < 1n ||
        before.dev !== state.fileDevice ||
        before.ino !== state.fileInode ||
        before.ctimeNs !== state.fileCtimeNs ||
        before.size !== state.fileSize
      ) {
        throw new Error(
          "durable evaluation ledger claim file identity changed",
        );
      }
      const payload = `${JSON.stringify(value)}\n`;
      writeAllSync(descriptor, payload);
      fsyncSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (
        !after.isFile() ||
        after.nlink < 1n ||
        after.dev !== state.fileDevice ||
        after.ino !== state.fileInode ||
        after.size !== before.size + BigInt(Buffer.byteLength(payload, "utf8"))
      ) {
        throw new Error(
          "durable evaluation ledger claim file changed during append",
        );
      }
      state.fileCtimeNs = after.ctimeNs;
      state.fileSize = after.size;
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
      if (!appendAuthorizationClaimDurably(input.authorizationId)) return false;
      const filePath = join(
        directoryIdentity.directory,
        `${createHash("sha256")
          .update(input.authorizationId)
          .digest("hex")}.jsonl`,
      );
      let descriptor;
      let claimFileStats: BigIntStats | undefined;
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
        claimFileStats = fstatSync(descriptor, { bigint: true });
      } finally {
        closeSync(descriptor);
      }
      if (!claimFileStats) {
        throw new Error(
          "durable evaluation ledger claim file identity is missing",
        );
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
        fileDevice: claimFileStats.dev,
        fileInode: claimFileStats.ino,
        fileCtimeNs: claimFileStats.ctimeNs,
        fileSize: claimFileStats.size,
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
      appendDurably(state, {
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
      appendDurably(state, {
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
      appendDurably(state, {
        event: "authorization_frozen",
        ...input,
      });
      state.frozen = true;
      return true;
    },
  };
  const trusted = Object.freeze(ledger);
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_SET_ADD,
    TRUSTED_MODEL_EVALUATION_AUTHORIZATION_LEDGERS,
    [trusted],
  );
  return trusted;
}

function isTrustedModelEvaluationAuthorizationLedger(
  value: unknown,
): value is ModelEvaluationAuthorizationLedger {
  return (
    !!value &&
    typeof value === "object" &&
    APPLY_MODEL_EVALUATION_INTRINSIC(
      MODEL_EVALUATION_WEAK_SET_HAS,
      TRUSTED_MODEL_EVALUATION_AUTHORIZATION_LEDGERS,
      [value],
    ) === true
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
const CLAIMED_MODEL_EVALUATION_AUTHORIZATIONS = new Set<string>();

export function modelEvaluationProtocolExecutorIdentity(
  value: unknown,
): object | null {
  if (typeof value !== "function") return null;
  return (
    (APPLY_MODEL_EVALUATION_INTRINSIC(
      MODEL_EVALUATION_WEAK_MAP_GET,
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
    : ((APPLY_MODEL_EVALUATION_INTRINSIC(
        MODEL_EVALUATION_WEAK_MAP_GET,
        TRUSTED_MODEL_EVALUATION_EXECUTOR_COST_SAFETY,
        [identity],
      ) as ModelEvaluationCostSafetyAttestation | undefined) ?? null);
}

export async function freezeModelEvaluationProtocolExecutor(
  value: unknown,
): Promise<boolean> {
  const identity = modelEvaluationProtocolExecutorIdentity(value);
  const freeze = identity
    ? (APPLY_MODEL_EVALUATION_INTRINSIC(
        MODEL_EVALUATION_WEAK_MAP_GET,
        TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS,
        [identity],
      ) as (() => Promise<void>) | undefined)
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
  if (!taskValidatorMatchesCapturedIdentity(request.taskId)) {
    throw preDispatchError("evaluation_task_validator_drift");
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
    if (
      RETIRED_EVALUATION_COMPARATOR_ALIASES.has(request.alias) ||
      catalog.status !== "legacy-only" ||
      catalog.domain !== "text" ||
      request.expectedProtocol !== "openai-chat-completions" ||
      !plan.evaluationSuite.legacyComparatorAliases.includes(request.alias)
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
      taskDefinition(request.taskId).outputSchema,
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

function taskDefinition(taskId: SiteBuilderTaskId) {
  switch (taskId) {
    case "site_builder.brand_profile": return BRAND_PROFILE_TASK;
    case "site_builder.copy": return COPY_TASK;
    case "site_builder.design_spec": return DESIGN_SPEC_TASK;
    case "site_builder.assemble": return ASSEMBLE_TASK;
    case "site_builder.assembly_fix": return ASSEMBLY_FIX_TASK;
    case "site_builder.qa_summarize": return QA_SUMMARIZE_TASK;
    case "site_builder.seo_review": return SEO_REVIEW_TASK;
  }
}

function taskEvaluationOutputConstraint(taskId: SiteBuilderTaskId): string {
  if (taskId !== "site_builder.design_spec") return "";
  return "\n评测输出的 reasons/warnings 必须为空，或每项严格使用以下封闭 claim 之一：selectedCandidateId=<已选 candidate 完整 id>、industryMatchCount=<已选 candidate 数值>、userAssetCoverage=<已选 candidate 数值>、demoFallbackCount=<已选 candidate 数值>。不得返回自由文本、其他字段、其他 candidate 或任何新事实。";
}

export function structuredSystemPrompt(
  outputSchema: Readonly<Record<string, unknown>>,
  taskId: SiteBuilderTaskId = "site_builder.brand_profile",
): string {
  taskDefinition(taskId);
  return `${capturedTaskSystemPrompt(taskId)}${taskEvaluationOutputConstraint(taskId)}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(outputSchema)}`;
}

export function repairPrompt(prompt: string, kind: string, reason: string): string {
  return `${prompt}\n\n上一次输出未通过${kind}校验，错误：\n${reason}\n请只修正被拒字段，不得新增、猜测或放宽任何事实；重新只输出同时通过 JSON Schema 和任务硬门的合法 JSON。`;
}

export function modelEvaluationInitialPromptUtf8Bytes(
  prompt: string,
  outputSchema: Readonly<Record<string, unknown>>,
  taskId: SiteBuilderTaskId = "site_builder.brand_profile",
): number {
  return (
    Buffer.byteLength(structuredSystemPrompt(outputSchema, taskId), "utf8") +
    Buffer.byteLength(prompt, "utf8")
  );
}

export function modelEvaluationRepairPromptUtf8BytesUpperBound(
  prompt: string,
  outputSchema: Readonly<Record<string, unknown>>,
  taskId: SiteBuilderTaskId = "site_builder.brand_profile",
): number {
  return (
    Buffer.byteLength(structuredSystemPrompt(outputSchema, taskId), "utf8") +
    Buffer.byteLength(
      repairPrompt(
        prompt,
        "任务确定性硬门",
        "x".repeat(MODEL_EVALUATION_REPAIR_REASON_UTF8_BYTES_UPPER_BOUND),
      ),
      "utf8",
    )
  );
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
    capturedTaskValidator(request.taskId)(
      request.casePayload.taskInput as never,
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
  const credentialGatewayOrigin = wireReceiver?.credentialGatewayOrigin;
  const trustedWireCredential =
    wireReceiver && typeof wireReceiver === "object"
      ? (APPLY_MODEL_EVALUATION_INTRINSIC(
          MODEL_EVALUATION_WEAK_MAP_GET,
          TRUSTED_MODEL_EVALUATION_WIRE_CREDENTIALS,
          [wireReceiver],
        ) as
          | Readonly<{
              credentialAttestationId: string;
              credentialSnapshotSha256: string;
              credentialBearerTokenSha256: string;
              credentialGatewayOrigin: string;
            }>
          | undefined)
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
    trustedWireCredential?.credentialGatewayOrigin !==
      credentialGatewayOrigin ||
    credentialAttestationId !== costSafety.credential.attestationId ||
    credentialSnapshotSha256 !== costSafety.credential.snapshotSha256 ||
    credentialBearerTokenSha256 !== costSafety.credential.bearerTokenSha256 ||
    credentialGatewayOrigin !== costSafety.credential.gatewayOrigin ||
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
    credentialGatewayOrigin,
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
    if (durableClaim) return durableClaim;
    const claimAttempt = Promise.resolve()
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
    durableClaim = claimAttempt;
    void claimAttempt.then((claim) => {
      if (
        !claim.claimed &&
        claim.error instanceof ModelEvaluationClaimLockContentionError &&
        durableClaim === claimAttempt
      ) {
        durableClaim = undefined;
      }
    });
    return claimAttempt;
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
    const protocol = assertCanonicalRequest(request, mode);
    if (!consumeAuthorizedModelEvaluationExecutionRequest(request)) {
      throw preDispatchError("evaluation_dispatch_not_authorized");
    }
    const claim = await claimDurableAuthorization();
    if (!claim.claimed) {
      if (!(claim.error instanceof ModelEvaluationClaimLockContentionError)) {
        campaignFrozen = true;
      }
      throw preDispatchError("evaluation_cost_safety_rejected");
    }
    const usage: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      callCount: 0,
      complete: true,
    };
    const providerReportedCostCents: (number | null)[] = [];
    const system = structuredSystemPrompt(request.outputSchema, request.taskId);
    const maximumWireCalls = request.repairTaskOutput ? 2 : 1;
    const campaignReservationCents =
      request.perCallCostCapCents * maximumWireCalls;
    let campaignReservationActive = false;
    let executionCostCapExceeded = false;
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
        const physicalCallCapExceeded = providerReportedCostCents.some(
          (amount) =>
            amount !== null && amount > request.perCallCostCapCents,
        );
        const executionReservationExceeded =
          effectiveSettlement.amountCents > campaignReservationCents;
        executionCostCapExceeded =
          physicalCallCapExceeded || executionReservationExceeded;
        if (
          executionCostCapExceeded ||
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
      if (!modelEvaluationRuntimeIntegrityMatches(request.taskId)) {
        if (usage.callCount === 0) {
          const effectiveSettlement = await closeCampaignReservation({
            state: "not_incurred",
            reason: "rejected_before_dispatch",
          });
          await freezeDurableAuthorization(
            "compiled_contracts_runtime_attestation_mismatch",
          );
          throw new ModelEvaluationCallError(
            "compiled_contracts_runtime_attestation_mismatch",
            effectiveSettlement,
          );
        }
        const error = new Error(
          "compiled_contracts_runtime_attestation_mismatch_before_repair",
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
        await freezeDurableAuthorization(
          "compiled_contracts_runtime_attestation_mismatch",
        );
        throw new ModelEvaluationCallError(
          "compiled_contracts_runtime_attestation_mismatch",
          effectiveSettlement,
        );
      }
      let response: ModelEvaluationWireResponse | undefined;
      let wireFailed = false;
      let wireError: unknown;
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
        wireFailed = true;
        wireError = error;
      }

      if (!modelEvaluationRuntimeIntegrityMatches(request.taskId)) {
        usage.callCount += 1;
        usage.complete = false;
        providerReportedCostCents.push(
          wireFailed &&
            (wireError instanceof ModelEvaluationWireHttpError ||
              wireError instanceof ModelEvaluationWireResponseBodyError)
            ? responseCost(wireError.providerReportedCostCents)
            : isRecord(response)
              ? responseCost(response.providerReportedCostCents)
              : null,
        );
        const error = new Error(
          "compiled_contracts_runtime_attestation_mismatch_after_wire",
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
        await freezeDurableAuthorization(
          "compiled_contracts_runtime_attestation_mismatch",
        );
        throw new ModelEvaluationCallError(
          "compiled_contracts_runtime_attestation_mismatch",
          effectiveSettlement,
        );
      }

      if (wireFailed) {
        usage.callCount += 1;
        usage.complete = false;
        providerReportedCostCents.push(
          wireError instanceof ModelEvaluationWireHttpError ||
            wireError instanceof ModelEvaluationWireResponseBodyError
            ? responseCost(wireError.providerReportedCostCents)
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
            error: wireError,
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
        await freezeDurableAuthorization("output_token_limit_exceeded");
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
        if (
          Buffer.byteLength(failure.reason, "utf8") >
          MODEL_EVALUATION_REPAIR_REASON_UTF8_BYTES_UPPER_BOUND
        ) {
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
              error: new Error("evaluation_repair_reason_too_large"),
            },
            costSafety,
          );
          const effectiveSettlement =
            await closeCampaignReservation(settlement);
          await freezeDurableAuthorization("repair_reason_too_large");
          throw new ModelEvaluationCallError(
            "evaluation_repair_reason_too_large",
            effectiveSettlement,
          );
        }
        const physicalCallCapExceeded = providerReportedCostCents.some(
          (amount) =>
            amount !== null && amount > request.perCallCostCapCents,
        );
        if (physicalCallCapExceeded) {
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
              error: new Error(
                "evaluation_physical_call_cost_cap_exceeded_before_repair",
              ),
            },
            costSafety,
          );
          const effectiveSettlement =
            await closeCampaignReservation(settlement);
          await freezeDurableAuthorization(
            "physical_call_cost_cap_exceeded_before_repair",
          );
          throw new ModelEvaluationCallError(
            "evaluation_cost_safety_rejected",
            effectiveSettlement,
          );
        }
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
    if (executionCostCapExceeded) {
      throw new ModelEvaluationCallError(
        "evaluation_cost_safety_rejected",
        settlement,
      );
    }
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
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_MAP_SET,
    TRUSTED_MODEL_EVALUATION_EXECUTOR_COST_SAFETY,
    [executorIdentity, costSafety],
  );
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_MAP_SET,
    TRUSTED_MODEL_EVALUATION_EXECUTOR_FREEZERS,
    [executorIdentity, () => freezeDurableAuthorization("harness_hard_stop")],
  );
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_MAP_SET,
    TRUSTED_MODEL_EVALUATION_EXECUTES,
    [execute, executorIdentity],
  );
  const executeLegacyComparator = Object.freeze(
    <T>(request: ModelEvaluationExecutionRequest) =>
      executeWithMode<T>(request, "legacy_comparator"),
  );
  APPLY_MODEL_EVALUATION_INTRINSIC(
    MODEL_EVALUATION_WEAK_MAP_SET,
    TRUSTED_MODEL_EVALUATION_EXECUTES,
    [executeLegacyComparator, executorIdentity],
  );
  return Object.freeze({
    execute,
    executeLegacyComparator,
  });
}
