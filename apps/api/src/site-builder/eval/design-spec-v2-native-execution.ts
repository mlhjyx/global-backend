import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { DESIGN_SPEC_TASK } from "../design/design-brief-producer";
import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  assessCanonicalTaskArtifact,
  buildCanonicalModelEvaluationCase,
  buildTaskEvaluationPlan,
} from "./model-evaluation-harness";
import {
  createCredentialBoundModelEvaluationWireClient,
  repairPrompt,
  structuredSystemPrompt,
  type ModelEvaluationCredentialHandle,
} from "./model-evaluation-executor";
import {
  assertModelEvaluationRuntimeIntegrity,
  modelEvaluationRuntimeIntegrityMatches,
} from "./model-evaluation-runtime-integrity";
import {
  assertNativeModelEvaluationDispatch,
  isTrustedNativeModelEvaluationCostSafetyAttestation,
  nativeMaximumPicoUnitsForModelEvaluationWire,
  type NativeModelEvaluationCostSafetyAttestation,
  type NativeModelEvaluationCostSettlement,
} from "./model-evaluation-native-cost-safety";
import type {
  NativeModelEvaluationAuthorizationLedger,
  NativeModelEvaluationLedgerFreezeReason,
} from "./native-model-evaluation-authorization-ledger";
import {
  createDesignSpecV2NativeRequestIdCapturingFetch,
  createDesignSpecV2NativeSettlementResolver,
  type DesignSpecV2NativeWireObservation,
} from "./design-spec-v2-native-settlement";
import { sha256CanonicalJson } from "./eval-provenance";

type NativeTargetProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/;
const MAX_REPAIR_REASON_BYTES = 16_384;
const TRUSTED_NATIVE_EXECUTION_RUNNERS = new WeakSet<object>();
const TRUSTED_NATIVE_EXECUTION_RUNNER_ADD = WeakSet.prototype.add;
const TRUSTED_NATIVE_EXECUTION_RUNNER_HAS = WeakSet.prototype.has;
const NATIVE_EXECUTION_RUNNER_APPLY = Reflect.apply;
const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;

interface NativeTextResponse {
  rawText: string;
  reportedModel: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface DesignSpecV2NativeExecutionResult {
  executionId: string;
  alias: string;
  protocol: NativeTargetProtocol;
  fixtureId: string;
  attempt: number;
  outcome: "accepted" | "rejected";
  artifactRetention: "digest_only";
  artifactSha256: string | null;
  assessment: {
    qualityPassed: boolean;
    structurePassed: boolean;
    factualityPassed: boolean;
    findingCodes: readonly string[];
  } | null;
  actualProtocol: NativeTargetProtocol;
  requestedModel: string;
  reportedModel: string | null;
  resolvedModel: string | null;
  modelResolutionSource: "upstream_response" | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    callCount: number;
  };
  costSettlement: NativeModelEvaluationCostSettlement;
}

export interface DesignSpecV2NativeExecutionRunner {
  execute(input: {
    executionId: string;
    alias: string;
    protocol: NativeTargetProtocol;
    fixtureId: string;
    attempt: number;
  }): Promise<DesignSpecV2NativeExecutionResult>;
  abort(): void;
}

export function isTrustedDesignSpecV2NativeExecutionRunner(
  value: unknown,
): value is DesignSpecV2NativeExecutionRunner {
  return (
    !!value &&
    typeof value === "object" &&
    (NATIVE_EXECUTION_RUNNER_APPLY(
      TRUSTED_NATIVE_EXECUTION_RUNNER_HAS,
      TRUSTED_NATIVE_EXECUTION_RUNNERS,
      [value],
    ) as boolean) &&
    NATIVE_OBJECT_IS_FROZEN(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

function parseArtifact(rawText: string): unknown {
  return JSON.parse(stripJsonFence(rawText));
}

function requireUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  if (!isRecord(value)) throw new Error("native evaluation usage is absent");
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (
    !nonNegativeSafeInteger(inputTokens) ||
    !nonNegativeSafeInteger(outputTokens)
  ) {
    throw new Error("native evaluation usage is invalid");
  }
  return { inputTokens, outputTokens };
}

function parseOpenAIResponses(body: unknown): NativeTextResponse {
  if (
    !isRecord(body) ||
    body.status !== "completed" ||
    typeof body.model !== "string"
  ) {
    throw new Error("native openai responses body is invalid");
  }
  const fragments: string[] = [];
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (
          isRecord(content) &&
          content.type === "output_text" &&
          typeof content.text === "string"
        ) {
          fragments.push(content.text);
        }
      }
    }
  }
  const rawText =
    fragments.join("") ||
    (typeof body.output_text === "string" ? body.output_text : "");
  if (!rawText.trim()) throw new Error("native model output is empty");
  return {
    rawText,
    reportedModel: body.model,
    usage: requireUsage(body.usage),
  };
}

function parseAnthropicMessages(body: unknown): NativeTextResponse {
  if (
    !isRecord(body) ||
    body.stop_reason !== "end_turn" ||
    typeof body.model !== "string" ||
    !Array.isArray(body.content)
  ) {
    throw new Error("native anthropic messages body is invalid");
  }
  const rawText = body.content
    .flatMap((content) =>
      isRecord(content) &&
      content.type === "text" &&
      typeof content.text === "string"
        ? [content.text]
        : [],
    )
    .join("");
  if (!rawText.trim()) throw new Error("native model output is empty");
  return {
    rawText,
    reportedModel: body.model,
    usage: requireUsage(body.usage),
  };
}

function parseNativeTextResponse(
  protocol: NativeTargetProtocol,
  body: unknown,
): NativeTextResponse {
  return protocol === "openai-responses"
    ? parseOpenAIResponses(body)
    : parseAnthropicMessages(body);
}

function credentialMatches(
  credential: ModelEvaluationCredentialHandle,
  attestation: NativeModelEvaluationCostSafetyAttestation,
): boolean {
  return (
    credential.attestationId === attestation.credential.attestationId &&
    credential.snapshotSha256 === attestation.credential.snapshotSha256 &&
    credential.bearerTokenSha256 === attestation.credential.bearerTokenSha256 &&
    credential.gatewayOrigin === attestation.credential.gatewayOrigin
  );
}

function preparedSourceMatches(
  attestation: NativeModelEvaluationCostSafetyAttestation,
): boolean {
  let head: string;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return false;
  }
  const plan = buildTaskEvaluationPlan("site_builder.design_spec");
  const suite = plan.evaluationSuite;
  if (
    !suite ||
    plan.dispatchAdmission !== "task_evaluation_ready" ||
    suite.fixtureIds.length < 1
  ) {
    return false;
  }
  try {
    const canonicalCase = buildCanonicalModelEvaluationCase(
      plan,
      suite.fixtureIds[0]!,
    );
    return (
      head === attestation.authorization.preparedFixedCommitSha &&
      suite.suiteId === attestation.authorization.preparedSuiteId &&
      canonicalCase.contract.sourceBundleContractId ===
        attestation.authorization.preparedSourceBundleContractId &&
      canonicalCase.contract.sourceBundleSha256 ===
        attestation.authorization.preparedSourceBundleSha256
    );
  } catch {
    return false;
  }
}

function exactExecutionInput(input: {
  executionId: string;
  alias: string;
  protocol: NativeTargetProtocol;
  fixtureId: string;
  attempt: number;
}): boolean {
  return (
    EXECUTION_ID.test(input.executionId) &&
    typeof input.alias === "string" &&
    (input.protocol === "openai-responses" ||
      input.protocol === "anthropic-messages") &&
    typeof input.fixtureId === "string" &&
    Number.isSafeInteger(input.attempt) &&
    input.attempt >= 1
  );
}

function settlementBasis(
  attestation: NativeModelEvaluationCostSafetyAttestation,
): Extract<NativeModelEvaluationCostSettlement, { state: "settled" }>["basis"] {
  return `frozen_openox_native_pricing@${attestation.pricing.capturedAt}`;
}

function combinedMaximum(
  attestation: NativeModelEvaluationCostSafetyAttestation,
  alias: string,
  protocol: NativeTargetProtocol,
): { currency: "CNY" | "USD"; nativePicoUnits: string } {
  const initial = nativeMaximumPicoUnitsForModelEvaluationWire(attestation, {
    alias,
    protocol,
    wireAttempt: "initial",
  });
  const repair = nativeMaximumPicoUnitsForModelEvaluationWire(attestation, {
    alias,
    protocol,
    wireAttempt: "repair",
  });
  if (initial.currency !== repair.currency) {
    throw new Error("native evaluation currency drifted across repair");
  }
  return {
    currency: initial.currency,
    nativePicoUnits: (
      BigInt(initial.nativePicoUnits) + BigInt(repair.nativePicoUnits)
    ).toString(),
  };
}

function freeze(
  ledger: NativeModelEvaluationAuthorizationLedger,
  authorizationId: string,
  executorClaimId: string,
  reason: NativeModelEvaluationLedgerFreezeReason,
): void {
  try {
    ledger.freeze({ authorizationId, executorClaimId, reason });
  } catch {
    // The ledger itself preserves a write failure as a durable freeze state.
  }
}

function isRuntimeIntegrityDrift(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("native evaluation runtime integrity drifted")
  );
}

class NativeWireAttemptError extends Error {
  readonly mayHaveDispatched: boolean;

  constructor(error: unknown, mayHaveDispatched: boolean) {
    super(
      error instanceof Error
        ? error.message
        : "native evaluation wire attempt failed",
      { cause: error },
    );
    this.name = "NativeWireAttemptError";
    this.mayHaveDispatched = mayHaveDispatched;
  }
}

function promptLimitForAttempt(
  attestation: NativeModelEvaluationCostSafetyAttestation,
  wireAttempt: "initial" | "repair",
): number {
  return wireAttempt === "initial"
    ? attestation.limits.maxInitialPromptUtf8Bytes
    : attestation.limits.maxRepairPromptUtf8Bytes;
}

function assertPromptWithinNativeEnvelope(input: {
  attestation: NativeModelEvaluationCostSafetyAttestation;
  system: string;
  prompt: string;
  wireAttempt: "initial" | "repair";
}): void {
  const promptBytes =
    Buffer.byteLength(input.system, "utf8") +
    Buffer.byteLength(input.prompt, "utf8");
  if (
    promptBytes > promptLimitForAttempt(input.attestation, input.wireAttempt)
  ) {
    throw new Error("native evaluation prompt exceeds the attested envelope");
  }
}

/**
 * Creates a paid-only, native-currency attempt runner. Constructing it claims
 * a single durable authorization; callers must therefore construct it only
 * after the fixed source, limited credential, and spending gates are closed.
 */
export function createDesignSpecV2NativeExecutionRunner(options: {
  attestation: NativeModelEvaluationCostSafetyAttestation;
  credential: ModelEvaluationCredentialHandle;
  ledger: NativeModelEvaluationAuthorizationLedger;
  fetch: typeof fetch;
}): DesignSpecV2NativeExecutionRunner {
  if (
    !isTrustedNativeModelEvaluationCostSafetyAttestation(options.attestation)
  ) {
    throw new Error("trusted native model evaluation cost safety is required");
  }
  const attestation = options.attestation;
  const credential = options.credential;
  const ledger = options.ledger;
  const fetchImpl = options.fetch;
  if (
    !credentialMatches(credential, attestation) ||
    !preparedSourceMatches(attestation) ||
    !ledger ||
    ledger.ledgerId !== attestation.authorization.ledgerId ||
    ledger.directorySha256 !==
      attestation.authorization.ledgerDirectorySha256 ||
    typeof fetchImpl !== "function"
  ) {
    throw new Error("native evaluation credential or ledger does not match");
  }
  const executorClaimId = randomUUID();
  if (
    !ledger.claim({
      authorizationId: attestation.authorization.authorizationId,
      executorClaimId,
      settlementBasis: settlementBasis(attestation),
      maximumsByCurrency: attestation.limits.maximumsByCurrency,
      maxDispatchExecutions: attestation.limits.maxDispatchExecutions,
      maxWireCalls: attestation.limits.maxWireCalls,
    })
  ) {
    throw new Error("native evaluation authorization claim was rejected");
  }

  const requestIdCapture = createDesignSpecV2NativeRequestIdCapturingFetch({
    attestation,
    gatewayOrigin: credential.gatewayOrigin,
    bearerToken: credential.bearerToken,
    fetch: fetchImpl,
  });
  const wireClient = createCredentialBoundModelEvaluationWireClient({
    credential,
    baseUrl: `${credential.gatewayOrigin}/v1`,
    fetch: requestIdCapture.fetch,
  });
  const settlementResolver = createDesignSpecV2NativeSettlementResolver({
    attestation,
    bearerToken: credential.bearerToken,
    requestIdCapture,
    fetch: fetchImpl,
  });

  const execute = async (input: {
    executionId: string;
    alias: string;
    protocol: NativeTargetProtocol;
    fixtureId: string;
    attempt: number;
  }): Promise<DesignSpecV2NativeExecutionResult> => {
    if (!exactExecutionInput(input)) {
      throw new Error("native design_spec execution input is invalid");
    }
    if (!preparedSourceMatches(attestation)) {
      throw new Error("native design_spec prepared source does not match");
    }
    const plan = buildTaskEvaluationPlan("site_builder.design_spec");
    const candidate = plan.candidates.find(
      (entry) =>
        entry.alias === input.alias &&
        entry.expectedProtocol === input.protocol,
    );
    if (
      plan.dispatchAdmission !== "task_evaluation_ready" ||
      !plan.evaluationSuite ||
      !candidate ||
      input.attempt > plan.evaluationSuite.repeats
    ) {
      throw new Error(
        "native design_spec execution is not in the canonical matrix",
      );
    }
    assertNativeModelEvaluationDispatch(attestation, {
      mode: "target",
      alias: input.alias,
      protocol: input.protocol,
      wireAttempt: "initial",
      maximumWireCalls: 2,
      maxOutputTokens: plan.envelope.maxTokens,
      inputTokens: 0,
    });
    const evaluationCase = buildCanonicalModelEvaluationCase(
      plan,
      input.fixtureId,
    );
    assertModelEvaluationRuntimeIntegrity("site_builder.design_spec");
    const reservation = combinedMaximum(
      attestation,
      input.alias,
      input.protocol,
    );
    if (
      !ledger.reserve({
        authorizationId: attestation.authorization.authorizationId,
        executorClaimId,
        executionId: input.executionId,
        currency: reservation.currency,
        nativePicoUnits: reservation.nativePicoUnits,
        wireCalls: 2,
      })
    ) {
      throw new Error("native design_spec reservation was rejected");
    }

    const signal = AbortSignal.timeout(plan.envelope.hardStopMs);
    const wires: DesignSpecV2NativeWireObservation[] = [];
    let settled = false;
    const settle = async (options?: {
      forceUnknown?: boolean;
    }): Promise<NativeModelEvaluationCostSettlement> => {
      const costSettlement = options?.forceUnknown
        ? ({ state: "unknown", reason: "invalid_settlement" } as const)
        : await settlementResolver.resolve({
            executionId: input.executionId,
            alias: input.alias,
            protocol: input.protocol,
            wires,
          });
      if (
        !ledger.settle({
          authorizationId: attestation.authorization.authorizationId,
          executorClaimId,
          executionId: input.executionId,
          settlement: costSettlement,
        })
      ) {
        throw new Error("native design_spec settlement was rejected");
      }
      settled = true;
      return costSettlement;
    };
    const settleOrFreeze = async (options?: {
      forceUnknown?: boolean;
    }): Promise<void> => {
      if (settled) return;
      try {
        await settle(options);
      } catch {
        freeze(
          ledger,
          attestation.authorization.authorizationId,
          executorClaimId,
          "unknown_settlement",
        );
      }
    };
    const dispatch = async (
      prompt: string,
      wireAttempt: "initial" | "repair",
    ): Promise<NativeTextResponse> => {
      assertNativeModelEvaluationDispatch(attestation, {
        mode: "target",
        alias: input.alias,
        protocol: input.protocol,
        wireAttempt,
        maximumWireCalls: 2,
        maxOutputTokens: plan.envelope.maxTokens,
        inputTokens: 0,
      });
      if (!modelEvaluationRuntimeIntegrityMatches("site_builder.design_spec")) {
        throw new Error(
          "native evaluation runtime integrity drifted before wire",
        );
      }
      const system = structuredSystemPrompt(
        DESIGN_SPEC_TASK.outputSchema,
        "site_builder.design_spec",
      );
      assertPromptWithinNativeEnvelope({
        attestation,
        system,
        prompt,
        wireAttempt,
      });
      let mayHaveDispatched = false;
      try {
        mayHaveDispatched = true;
        const response =
          input.protocol === "openai-responses"
            ? await wireClient.openAIResponses({
                executionId: input.executionId,
                body: {
                  model: input.alias,
                  input: [
                    { role: "system", content: system },
                    { role: "user", content: prompt },
                  ],
                  max_output_tokens: plan.envelope.maxTokens,
                  temperature: 0,
                  text: { format: { type: "json_object" } },
                  ...(plan.envelope.reasoningEffort
                    ? { reasoning: { effort: plan.envelope.reasoningEffort } }
                    : {}),
                },
                signal,
              })
            : await wireClient.anthropicMessages({
                executionId: input.executionId,
                body: {
                  model: input.alias,
                  system,
                  messages: [{ role: "user", content: prompt }],
                  max_tokens: plan.envelope.maxTokens,
                  temperature: 0,
                },
                signal,
              });
        const parsed = parseNativeTextResponse(input.protocol, response.body);
        if (
          parsed.usage.inputTokens >
            (wireAttempt === "initial"
              ? attestation.limits.maxInputTokensInitialWire
              : attestation.limits.maxInputTokensRepairWire) ||
          parsed.usage.outputTokens > attestation.limits.maxOutputTokensPerWire
        ) {
          throw new Error(
            "native evaluation usage exceeds the attested envelope",
          );
        }
        wires.push({ wireAttempt, usage: parsed.usage });
        if (
          !modelEvaluationRuntimeIntegrityMatches("site_builder.design_spec")
        ) {
          throw new Error(
            "native evaluation runtime integrity drifted after wire",
          );
        }
        return parsed;
      } catch (error) {
        throw new NativeWireAttemptError(error, mayHaveDispatched);
      }
    };

    let response: NativeTextResponse;
    try {
      response = await dispatch(evaluationCase.payload.prompt, "initial");
    } catch (error) {
      await settleOrFreeze();
      if (isRuntimeIntegrityDrift(error)) {
        freeze(
          ledger,
          attestation.authorization.authorizationId,
          executorClaimId,
          "runtime_integrity_drift",
        );
      }
      throw error;
    }
    if (response.reportedModel !== input.alias) {
      const costSettlement = await settle();
      return {
        executionId: input.executionId,
        alias: input.alias,
        protocol: input.protocol,
        fixtureId: input.fixtureId,
        attempt: input.attempt,
        outcome: "rejected",
        artifactRetention: "digest_only",
        artifactSha256: null,
        assessment: null,
        actualProtocol: input.protocol,
        requestedModel: input.alias,
        reportedModel: response.reportedModel,
        resolvedModel: null,
        modelResolutionSource: null,
        usage: { ...response.usage, callCount: 1 },
        costSettlement,
      };
    }

    let artifact: unknown;
    let assessment: ReturnType<typeof assessCanonicalTaskArtifact> | null =
      null;
    let invalidReason: string | null = null;
    try {
      artifact = parseArtifact(response.rawText);
      assessment = assessCanonicalTaskArtifact(
        plan,
        evaluationCase.payload,
        artifact,
      );
    } catch (error) {
      invalidReason = error instanceof Error ? error.message : "schema_invalid";
      artifact = undefined;
    }
    if (
      invalidReason &&
      Buffer.byteLength(invalidReason, "utf8") <= MAX_REPAIR_REASON_BYTES
    ) {
      try {
        response = await dispatch(
          repairPrompt(
            evaluationCase.payload.prompt,
            "任务确定性硬门",
            invalidReason,
          ),
          "repair",
        );
        if (response.reportedModel === input.alias) {
          artifact = parseArtifact(response.rawText);
          assessment = assessCanonicalTaskArtifact(
            plan,
            evaluationCase.payload,
            artifact,
          );
          invalidReason = null;
        }
      } catch (error) {
        if (isRuntimeIntegrityDrift(error)) {
          await settleOrFreeze();
          freeze(
            ledger,
            attestation.authorization.authorizationId,
            executorClaimId,
            "runtime_integrity_drift",
          );
          throw error;
        }
        if (
          error instanceof NativeWireAttemptError &&
          error.mayHaveDispatched
        ) {
          await settleOrFreeze({ forceUnknown: true });
          throw error;
        }
        invalidReason = "repair_rejected";
        artifact = undefined;
        assessment = null;
      }
    }
    const costSettlement = await settle();
    const accepted =
      invalidReason === null &&
      assessment !== null &&
      assessment.qualityPassed &&
      assessment.structurePassed &&
      assessment.factualityPassed;
    const callCount = wires.length;
    const usage = wires.reduce(
      (total, wire) => ({
        inputTokens: total.inputTokens + wire.usage.inputTokens,
        outputTokens: total.outputTokens + wire.usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    return {
      executionId: input.executionId,
      alias: input.alias,
      protocol: input.protocol,
      fixtureId: input.fixtureId,
      attempt: input.attempt,
      outcome: accepted ? "accepted" : "rejected",
      artifactRetention: "digest_only",
      artifactSha256:
        artifact === undefined ? null : sha256CanonicalJson(artifact),
      assessment:
        assessment === null
          ? null
          : {
              qualityPassed: assessment.qualityPassed,
              structurePassed: assessment.structurePassed,
              factualityPassed: assessment.factualityPassed,
              findingCodes: Object.freeze([...assessment.findingCodes]),
            },
      actualProtocol: input.protocol,
      requestedModel: input.alias,
      reportedModel: response.reportedModel,
      resolvedModel:
        response.reportedModel === input.alias ? input.alias : null,
      modelResolutionSource:
        response.reportedModel === input.alias ? "upstream_response" : null,
      usage: { ...usage, callCount },
      costSettlement,
    };
  };
  const abort = (): void => {
    freeze(
      ledger,
      attestation.authorization.authorizationId,
      executorClaimId,
      "campaign_aborted",
    );
  };
  const runner = Object.freeze({ execute, abort });
  NATIVE_EXECUTION_RUNNER_APPLY(
    TRUSTED_NATIVE_EXECUTION_RUNNER_ADD,
    TRUSTED_NATIVE_EXECUTION_RUNNERS,
    [runner],
  );
  return runner;
}
