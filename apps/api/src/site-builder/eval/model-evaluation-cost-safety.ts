import {
  MODEL_CANDIDATE_PROTOCOLS,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";

export const SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID =
  "site-builder-model-evaluation-cost-safety/2026-07-28-v1" as const;
export const MODEL_EVALUATION_ABSOLUTE_LIMITS = Object.freeze({
  credentialQuotaCapCents: 25_000,
  campaignBudgetCents: 10_000,
  dispatchExecutions: 500,
  wireCalls: 1_000,
  promptUtf8BytesPerCall: 1_048_576,
  outputTokensPerCall: 100_000,
});
const MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND = 4_096;

export type ModelEvaluationDispatchMode = "target" | "legacy_comparator";

export interface ModelEvaluationCostSafetyDispatch {
  mode: ModelEvaluationDispatchMode;
  alias: string;
  protocol: ModelCandidateProtocol;
}

export interface ModelEvaluationCredentialIdentity {
  attestationId: string;
  snapshotSha256: string;
}

export interface ModelEvaluationCostSafetyInput {
  contractId: typeof SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID;
  authorization: {
    authorizationId: string;
    ledgerId: string;
    ledgerDirectorySha256: string;
    approvedAt: string;
    approvedCampaignBudgetCents: number;
    approvedDispatchExecutions: number;
  };
  credential: {
    attestationId: string;
    observedAt: string;
    snapshotSha256: string;
    bearerTokenSha256: string;
    gatewayOrigin: string;
    purpose: "site_builder_model_evaluation";
    quotaMode: "limited";
    scopeExact: true;
    quotaCapCents: number;
    remainingQuotaCents: number;
    allowedDispatches: readonly ModelEvaluationCostSafetyDispatch[];
  };
  pricing: {
    snapshotId: string;
    snapshotSha256: string;
    basis: "frozen_unit_price_snapshot";
    defaultOrUnconfiguredRatioAllowed: false;
    resolverId: string;
    entries: readonly {
      alias: string;
      protocol: ModelCandidateProtocol;
      inputCentsPerMillionTokens: number;
      outputCentsPerMillionTokens: number;
    }[];
  };
  limits: {
    campaignBudgetCents: number;
    maxDispatchExecutions: number;
    maxWireCalls: number;
    maxPromptUtf8BytesPerCall: number;
    maxOutputTokensPerCall: number;
  };
  settlement: {
    requestIdentityField: "executionId";
    requireVerifiedRequestSettlement: true;
    unknownSettlementPolicy: "freeze_campaign";
  };
  media: {
    genericChannelTest: "forbidden";
    allowedDispatches: readonly [];
  };
}

export type ModelEvaluationCostSafetyAttestation =
  Readonly<ModelEvaluationCostSafetyInput>;

const ATTESTATION_ID = /^[a-z0-9][a-z0-9._/-]{7,127}$/;
const RESOLVER_ID = /^[a-z0-9][a-z0-9._/-]{2,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUSTED_COST_SAFETY_ATTESTATIONS = new WeakSet<object>();
const COST_SAFETY_WEAK_SET_ADD = WeakSet.prototype.add;
const COST_SAFETY_WEAK_SET_HAS = WeakSet.prototype.has;
const APPLY_COST_SAFETY_INTRINSIC = Reflect.apply;
const COST_SAFETY_OBJECT_FREEZE = Object.freeze;
const COST_SAFETY_OBJECT_IS_FROZEN = Object.isFrozen;
const COST_SAFETY_OBJECT_VALUES = Object.values;

function deepFreeze<T>(value: T): T {
  if (
    value &&
    typeof value === "object" &&
    !COST_SAFETY_OBJECT_IS_FROZEN(value)
  ) {
    COST_SAFETY_OBJECT_FREEZE(value);
    for (const child of COST_SAFETY_OBJECT_VALUES(value)) deepFreeze(child);
  }
  return value;
}

function isDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return true;
  if (!COST_SAFETY_OBJECT_IS_FROZEN(value)) return false;
  seen.add(value);
  return COST_SAFETY_OBJECT_VALUES(value).every((child) =>
    isDeeplyFrozen(child, seen),
  );
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function dispatchKey(value: ModelEvaluationCostSafetyDispatch): string {
  return `${value.mode}:${value.alias}:${value.protocol}`;
}

function priceKey(value: {
  alias: string;
  protocol: ModelCandidateProtocol;
}): string {
  return `${value.alias}:${value.protocol}`;
}

function priceCents(
  attestation: ModelEvaluationCostSafetyAttestation,
  alias: string,
  protocol: ModelCandidateProtocol,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = attestation.pricing.entries.find(
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
  if (!price) return Number.POSITIVE_INFINITY;
  return (
    (inputTokens * price.inputCentsPerMillionTokens +
      outputTokens * price.outputCentsPerMillionTokens) /
    1_000_000
  );
}

function assertExactUniqueKeys(values: readonly string[], label: string): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${label} must be non-empty and unique`);
  }
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

export function createModelEvaluationCostSafetyAttestation(
  input: ModelEvaluationCostSafetyInput,
): ModelEvaluationCostSafetyAttestation {
  let copy: ModelEvaluationCostSafetyInput;
  try {
    copy = structuredClone(input);
  } catch {
    throw new Error("model evaluation cost safety input must be cloneable");
  }
  if (
    !hasExactKeys(copy, [
      "contractId",
      "authorization",
      "credential",
      "pricing",
      "limits",
      "settlement",
      "media",
    ]) ||
    !hasExactKeys(copy.authorization, [
      "authorizationId",
      "ledgerId",
      "ledgerDirectorySha256",
      "approvedAt",
      "approvedCampaignBudgetCents",
      "approvedDispatchExecutions",
    ]) ||
    !hasExactKeys(copy.credential, [
      "attestationId",
      "observedAt",
      "snapshotSha256",
      "bearerTokenSha256",
      "gatewayOrigin",
      "purpose",
      "quotaMode",
      "scopeExact",
      "quotaCapCents",
      "remainingQuotaCents",
      "allowedDispatches",
    ]) ||
    !hasExactKeys(copy.pricing, [
      "snapshotId",
      "snapshotSha256",
      "basis",
      "defaultOrUnconfiguredRatioAllowed",
      "resolverId",
      "entries",
    ]) ||
    !hasExactKeys(copy.limits, [
      "campaignBudgetCents",
      "maxDispatchExecutions",
      "maxWireCalls",
      "maxPromptUtf8BytesPerCall",
      "maxOutputTokensPerCall",
    ]) ||
    !hasExactKeys(copy.settlement, [
      "requestIdentityField",
      "requireVerifiedRequestSettlement",
      "unknownSettlementPolicy",
    ]) ||
    !hasExactKeys(copy.media, ["genericChannelTest", "allowedDispatches"]) ||
    copy.contractId !== SITE_BUILDER_MODEL_EVALUATION_COST_SAFETY_ID ||
    !ATTESTATION_ID.test(copy.authorization.authorizationId) ||
    !RESOLVER_ID.test(copy.authorization.ledgerId) ||
    !SHA256.test(copy.authorization.ledgerDirectorySha256) ||
    !canonicalUtcInstant(copy.authorization.approvedAt) ||
    copy.authorization.approvedCampaignBudgetCents !==
      copy.limits.campaignBudgetCents ||
    copy.authorization.approvedDispatchExecutions !==
      copy.limits.maxDispatchExecutions ||
    copy.credential.purpose !== "site_builder_model_evaluation" ||
    copy.credential.quotaMode !== "limited" ||
    copy.credential.scopeExact !== true ||
    !ATTESTATION_ID.test(copy.credential.attestationId) ||
    !canonicalUtcInstant(copy.credential.observedAt) ||
    !SHA256.test(copy.credential.snapshotSha256) ||
    !SHA256.test(copy.credential.bearerTokenSha256) ||
    !canonicalHttpsOrigin(copy.credential.gatewayOrigin) ||
    !positiveFinite(copy.credential.quotaCapCents) ||
    copy.credential.quotaCapCents >
      MODEL_EVALUATION_ABSOLUTE_LIMITS.credentialQuotaCapCents ||
    !positiveFinite(copy.credential.remainingQuotaCents) ||
    copy.credential.remainingQuotaCents > copy.credential.quotaCapCents ||
    !positiveFinite(copy.limits.campaignBudgetCents) ||
    copy.limits.campaignBudgetCents >
      MODEL_EVALUATION_ABSOLUTE_LIMITS.campaignBudgetCents ||
    copy.limits.campaignBudgetCents > copy.credential.remainingQuotaCents ||
    !positiveSafeInteger(copy.limits.maxDispatchExecutions) ||
    copy.limits.maxDispatchExecutions >
      MODEL_EVALUATION_ABSOLUTE_LIMITS.dispatchExecutions ||
    !positiveSafeInteger(copy.limits.maxWireCalls) ||
    copy.limits.maxWireCalls > MODEL_EVALUATION_ABSOLUTE_LIMITS.wireCalls ||
    copy.limits.maxWireCalls < copy.limits.maxDispatchExecutions ||
    !positiveSafeInteger(copy.limits.maxPromptUtf8BytesPerCall) ||
    copy.limits.maxPromptUtf8BytesPerCall >
      MODEL_EVALUATION_ABSOLUTE_LIMITS.promptUtf8BytesPerCall ||
    !positiveSafeInteger(copy.limits.maxOutputTokensPerCall) ||
    copy.limits.maxOutputTokensPerCall >
      MODEL_EVALUATION_ABSOLUTE_LIMITS.outputTokensPerCall ||
    copy.pricing.basis !== "frozen_unit_price_snapshot" ||
    copy.pricing.defaultOrUnconfiguredRatioAllowed !== false ||
    !ATTESTATION_ID.test(copy.pricing.snapshotId) ||
    !SHA256.test(copy.pricing.snapshotSha256) ||
    !RESOLVER_ID.test(copy.pricing.resolverId) ||
    copy.settlement.requestIdentityField !== "executionId" ||
    copy.settlement.requireVerifiedRequestSettlement !== true ||
    copy.settlement.unknownSettlementPolicy !== "freeze_campaign" ||
    copy.media.genericChannelTest !== "forbidden" ||
    copy.media.allowedDispatches.length !== 0
  ) {
    throw new Error("model evaluation cost safety attestation is invalid");
  }

  const dispatchKeys = copy.credential.allowedDispatches.map(dispatchKey);
  assertExactUniqueKeys(dispatchKeys, "credential allowed dispatches");
  for (const dispatch of copy.credential.allowedDispatches) {
    if (
      !hasExactKeys(dispatch, ["mode", "alias", "protocol"]) ||
      (dispatch.mode !== "target" && dispatch.mode !== "legacy_comparator") ||
      typeof dispatch.alias !== "string" ||
      dispatch.alias.length === 0 ||
      !MODEL_CANDIDATE_PROTOCOLS.includes(dispatch.protocol)
    ) {
      throw new Error("credential dispatch scope is invalid");
    }
    if (
      dispatch.mode === "target" &&
      dispatch.protocol === "openai-chat-completions"
    ) {
      throw new Error("legacy Chat cannot be admitted as a target dispatch");
    }
    if (
      dispatch.mode === "legacy_comparator" &&
      dispatch.protocol !== "openai-chat-completions"
    ) {
      throw new Error("legacy comparator must use isolated Chat Completions");
    }
  }

  const priceKeys = copy.pricing.entries.map(priceKey);
  assertExactUniqueKeys(priceKeys, "pricing entries");
  const expectedPriceKeys = new Set(
    copy.credential.allowedDispatches.map(priceKey),
  );
  if (
    priceKeys.length !== expectedPriceKeys.size ||
    priceKeys.some((key) => !expectedPriceKeys.has(key))
  ) {
    throw new Error(
      "frozen pricing must cover the credential dispatch scope exactly",
    );
  }
  for (const entry of copy.pricing.entries) {
    if (
      !hasExactKeys(entry, [
        "alias",
        "protocol",
        "inputCentsPerMillionTokens",
        "outputCentsPerMillionTokens",
      ]) ||
      typeof entry.alias !== "string" ||
      entry.alias.length === 0 ||
      !nonNegativeFinite(entry.inputCentsPerMillionTokens) ||
      !nonNegativeFinite(entry.outputCentsPerMillionTokens) ||
      (entry.inputCentsPerMillionTokens === 0 &&
        entry.outputCentsPerMillionTokens === 0)
    ) {
      throw new Error("frozen pricing entry is invalid");
    }
  }

  const attestation = deepFreeze(copy);
  if (!isDeeplyFrozen(attestation)) {
    throw new Error("cost safety attestation could not be deeply frozen");
  }
  APPLY_COST_SAFETY_INTRINSIC(
    COST_SAFETY_WEAK_SET_ADD,
    TRUSTED_COST_SAFETY_ATTESTATIONS,
    [attestation],
  );
  return attestation;
}

export function isTrustedModelEvaluationCostSafetyAttestation(
  value: unknown,
): value is ModelEvaluationCostSafetyAttestation {
  return (
    !!value &&
    typeof value === "object" &&
    APPLY_COST_SAFETY_INTRINSIC(
      COST_SAFETY_WEAK_SET_HAS,
      TRUSTED_COST_SAFETY_ATTESTATIONS,
      [value],
    ) === true
  );
}

export function assertModelEvaluationCostSafetyDispatch(
  attestation: ModelEvaluationCostSafetyAttestation,
  request: {
    mode: ModelEvaluationDispatchMode;
    alias: string;
    protocol: ModelCandidateProtocol;
    maxOutputTokens: number;
    promptUtf8Bytes: number;
    maximumWireCalls: number;
    perCallCostCapCents: number;
  },
): void {
  if (!isTrustedModelEvaluationCostSafetyAttestation(attestation)) {
    throw new Error(
      "trusted model evaluation cost safety attestation required",
    );
  }
  if (
    !attestation.credential.allowedDispatches.some(
      (entry) =>
        entry.mode === request.mode &&
        entry.alias === request.alias &&
        entry.protocol === request.protocol,
    ) ||
    !positiveSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens > attestation.limits.maxOutputTokensPerCall ||
    !positiveSafeInteger(request.promptUtf8Bytes) ||
    request.promptUtf8Bytes > attestation.limits.maxPromptUtf8BytesPerCall ||
    !positiveSafeInteger(request.maximumWireCalls) ||
    !positiveFinite(request.perCallCostCapCents)
  ) {
    throw new Error("model evaluation dispatch exceeds cost safety scope");
  }
  const worstCasePerCallCents = priceCents(
    attestation,
    request.alias,
    request.protocol,
    request.promptUtf8Bytes +
      MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
    request.maxOutputTokens,
  );
  if (
    !Number.isFinite(worstCasePerCallCents) ||
    worstCasePerCallCents > request.perCallCostCapCents ||
    worstCasePerCallCents * request.maximumWireCalls >
      attestation.limits.campaignBudgetCents
  ) {
    throw new Error("model evaluation dispatch exceeds priced cost safety");
  }
}

export function frozenModelEvaluationPriceCents(
  attestation: ModelEvaluationCostSafetyAttestation,
  request: {
    alias: string;
    protocol: ModelCandidateProtocol;
    inputTokens: number;
    outputTokens: number;
  },
): number | null {
  if (
    !isTrustedModelEvaluationCostSafetyAttestation(attestation) ||
    !Number.isSafeInteger(request.inputTokens) ||
    request.inputTokens < 0 ||
    !Number.isSafeInteger(request.outputTokens) ||
    request.outputTokens < 0
  ) {
    return null;
  }
  const amount = priceCents(
    attestation,
    request.alias,
    request.protocol,
    request.inputTokens,
    request.outputTokens,
  );
  return Number.isFinite(amount) ? amount : null;
}
