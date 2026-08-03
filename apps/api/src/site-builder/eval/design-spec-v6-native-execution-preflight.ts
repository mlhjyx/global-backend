import {
  createNativeModelEvaluationCostSafetyAttestation,
  nativeModelEvaluationPricingFeeCardSha256,
  type NativeModelEvaluationCostSafetyAttestation,
  type NativeModelEvaluationCostSafetyInput,
} from "./model-evaluation-native-cost-safety";
import { sha256CanonicalJson } from "./eval-provenance";

/**
 * Admission bridge for the only merged v6 design_spec public-price evidence.
 *
 * This bridge deliberately accepts the immutable evidence wrapper, rather than
 * a caller-supplied pricing table. The generic native cost safety contract
 * remains useful for isolated fake-fetch tests, but it is not an execution
 * admission path for design_spec.
 */
export const DESIGN_SPEC_V6_NATIVE_EXECUTION_PREFLIGHT_ID =
  "site-builder-design-spec-v6-native-execution-preflight/2026-08-04-v1" as const;

const V6_EVIDENCE_SCHEMA =
  "site-builder-design-spec-v6-native-fee-card-evidence/v1" as const;
const V6_PREPARATION_COMMIT =
  "22f27678dcb75f2d7e5efc38b210de7756b34843" as const;
const V6_CARD_SHA256 =
  "0f740f81d7aa42432d8e3f343a4d7a92ec86ee53b90aa7a9955f8972fd388a76" as const;
const V6_MANIFEST_SHA256 =
  "1a74fab9ac803bfc50636fdb51ab7ac1b04623a8053c8d17a37a60294c99facd" as const;
const V6_SUITE_ID =
  "site-builder.design-spec-evaluation-suite/2026-08-03-v15" as const;
const V6_SOURCE_BUNDLE_CONTRACT_ID =
  "design-spec-evaluation-source-bundle/v15" as const;
const V6_SOURCE_BUNDLE_SHA256 =
  "c6deda364bb15efe15d2237ea761573ba5501d8c10fd44578abd5926a2833e72" as const;
const V6_FIXED_SOURCE_COMMIT =
  "5c37bb9270db6893144f07c2431e74a830d6b9f4" as const;

const TRUSTED_V6_ATTESTATIONS = new WeakSet<object>();
const NATIVE_WEAK_SET_ADD = WeakSet.prototype.add;
const NATIVE_WEAK_SET_HAS = WeakSet.prototype.has;
const NATIVE_OBJECT_FREEZE = Object.freeze;
const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;
const NATIVE_APPLY = Reflect.apply;

type NativeAuthorizationInput =
  NativeModelEvaluationCostSafetyInput["authorization"];
type NativeCredentialInput = NativeModelEvaluationCostSafetyInput["credential"];

interface ValidatedV6Card {
  pricing: NativeModelEvaluationCostSafetyInput["pricing"];
  limits: NativeModelEvaluationCostSafetyInput["limits"];
}

export interface DesignSpecV6NativeExecutionPreflightInput {
  authorization: Omit<
    NativeAuthorizationInput,
    | "preparedManifestSha256"
    | "preparedFeeCardSha256"
    | "preparedSuiteId"
    | "preparedSourceBundleContractId"
    | "preparedSourceBundleSha256"
  >;
  credential: NativeCredentialInput;
  feeCardEvidence: unknown;
}

export type DesignSpecV6NativeExecutionAttestation =
  NativeModelEvaluationCostSafetyAttestation;

function nativeWeakSetAdd(value: object): void {
  NATIVE_APPLY(NATIVE_WEAK_SET_ADD, TRUSTED_V6_ATTESTATIONS, [value]);
}

function nativeWeakSetHas(value: object): boolean {
  return NATIVE_APPLY(NATIVE_WEAK_SET_HAS, TRUSTED_V6_ATTESTATIONS, [
    value,
  ]) as boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}
function asPositiveSafeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? (value as number)
    : null;
}

function asPicoUnits(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? value
    : null;
}

function assertV6FeeCardEvidence(value: unknown): ValidatedV6Card {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "actualModelCost",
      "card",
      "dispatchAuthorization",
      "modelWireCalls",
      "preparationCommitSha",
      "schemaVersion",
    ])
  ) {
    throw new Error("design_spec v6 fee-card evidence is invalid");
  }
  if (
    value.schemaVersion !== V6_EVIDENCE_SCHEMA ||
    value.preparationCommitSha !== V6_PREPARATION_COMMIT ||
    value.modelWireCalls !== 0 ||
    value.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    !isRecord(value.actualModelCost) ||
    !exactKeys(value.actualModelCost, ["CNY", "USD"]) ||
    value.actualModelCost.CNY !== "0" ||
    value.actualModelCost.USD !== "0" ||
    !isRecord(value.card)
  ) {
    throw new Error("design_spec v6 fee-card evidence is invalid");
  }
  const card = value.card;
  const cardSha256 = card.cardSha256;
  const { cardSha256: _cardDigest, ...unsignedCard } = card;
  if (
    cardSha256 !== V6_CARD_SHA256 ||
    sha256CanonicalJson(unsignedCard) !== V6_CARD_SHA256 ||
    card.schemaVersion !== "site-builder-design-spec-v6-native-fee-card/v1" ||
    card.feeCardId !==
      "site-builder-design-spec-v6-native-fee-card/2026-08-04-v1" ||
    card.status !== "READY_FOR_CREDENTIAL_ATTESTATION" ||
    card.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    card.fixedSourceCommitSha !== V6_FIXED_SOURCE_COMMIT ||
    card.manifestSha256 !== V6_MANIFEST_SHA256 ||
    card.noForeignExchangeConversion !== true ||
    card.expectedCost !== "not_known_before_usage" ||
    !isRecord(card.suite) ||
    card.suite.suiteId !== V6_SUITE_ID ||
    card.suite.sourceBundleContractId !== V6_SOURCE_BUNDLE_CONTRACT_ID ||
    card.suite.sourceBundleSha256 !== V6_SOURCE_BUNDLE_SHA256 ||
    !isRecord(card.pricing) ||
    card.pricing.authority !== "openox_model_marketplace" ||
    card.pricing.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    typeof card.pricing.capturedAt !== "string" ||
    !/^[a-f0-9]{64}$/.test(String(card.pricing.catalogResponseSha256)) ||
    !isRecord(card.tokenEnvelope) ||
    card.tokenEnvelope.initialInputTokens !== 6438 ||
    card.tokenEnvelope.repairInputTokens !== 10745 ||
    card.tokenEnvelope.outputTokensPerWireCall !== 4000 ||
    !Array.isArray(card.entries) ||
    card.entries.length !== 3 ||
    !isRecord(card.totalsByCurrency) ||
    !isRecord(card.totalsByCurrency.CNY) ||
    !isRecord(card.totalsByCurrency.USD)
  ) {
    throw new Error("design_spec v6 fee-card evidence is invalid");
  }
  const cardEntries = card.entries;

  const expectedEntries = [
    ["gpt-5.6-terra", "openai-responses", "CNY", 24, 2_000_000, 12_000_000],
    ["gpt-5.5", "openai-responses", "CNY", 25, 5_000_000, 30_000_000],
    ["claude-sonnet-5", "anthropic-messages", "USD", 24, 2_520_000, 12_600_000],
  ] as const;
  const entries = expectedEntries.map((expected) => {
    const entry = cardEntries.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.alias === expected[0] &&
        candidate.protocol === expected[1],
    );
    if (
      !isRecord(entry) ||
      entry.currency !== expected[2] ||
      entry.executionCount !== expected[3] ||
      entry.maximumWireCalls !== expected[3] * 2 ||
      asPositiveSafeInteger(
        entry.effectiveInputRateMicrounitsPerMillionTokens,
      ) !== expected[4] ||
      asPositiveSafeInteger(
        entry.effectiveOutputRateMicrounitsPerMillionTokens,
      ) !== expected[5]
    ) {
      throw new Error("design_spec v6 fee-card evidence is invalid");
    }
    return {
      alias: expected[0],
      protocol: expected[1],
      currency: expected[2],
      inputRateMicrounitsPerMillionTokens: expected[4],
      outputRateMicrounitsPerMillionTokens: expected[5],
    };
  });
  const cnyTotal = asPicoUnits(card.totalsByCurrency.CNY.nativePicoUnits);
  const usdTotal = asPicoUnits(card.totalsByCurrency.USD.nativePicoUnits);
  if (cnyTotal !== "11276659000000" || usdTotal !== "3458427840000") {
    throw new Error("design_spec v6 fee-card evidence is invalid");
  }
  return {
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: card.pricing.capturedAt,
      catalogResponseSha256: card.pricing.catalogResponseSha256 as string,
      noForeignExchangeConversion: true,
      entries,
    },
    limits: {
      maximumsByCurrency: { CNY: cnyTotal, USD: usdTotal },
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      maxInitialPromptUtf8Bytes: 2342,
      maxRepairPromptUtf8Bytes: 6649,
      maxInputTokensInitialWire: 6438,
      maxInputTokensRepairWire: 10745,
      maxOutputTokensPerWire: 4000,
    },
  };
}

/**
 * Creates an execution-only attestation bound to the merged v6 public-price
 * evidence. It does not authorize dispatch: finite credential and ledger
 * authorization are still required by the execution runner.
 */
export function createDesignSpecV6NativeExecutionAttestation(
  input: DesignSpecV6NativeExecutionPreflightInput,
): DesignSpecV6NativeExecutionAttestation {
  const feeCard = assertV6FeeCardEvidence(input?.feeCardEvidence);
  const attestation = createNativeModelEvaluationCostSafetyAttestation({
    contractId:
      "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2",
    authorization: {
      ...input.authorization,
      preparedManifestSha256: V6_MANIFEST_SHA256,
      preparedFeeCardSha256: nativeModelEvaluationPricingFeeCardSha256(
        feeCard.pricing,
      ),
      preparedSuiteId: V6_SUITE_ID,
      preparedSourceBundleContractId: V6_SOURCE_BUNDLE_CONTRACT_ID,
      preparedSourceBundleSha256: V6_SOURCE_BUNDLE_SHA256,
    },
    credential: input.credential,
    pricing: feeCard.pricing,
    limits: feeCard.limits,
    settlement: {
      requestIdentityField: "executionId",
      requireVerifiedRequestSettlement: true,
      unknownSettlementPolicy: "freeze_campaign",
    },
  });
  nativeWeakSetAdd(attestation);
  return NATIVE_OBJECT_FREEZE(attestation);
}

export function isTrustedDesignSpecV6NativeExecutionAttestation(
  value: unknown,
): value is DesignSpecV6NativeExecutionAttestation {
  return (
    !!value &&
    typeof value === "object" &&
    NATIVE_OBJECT_IS_FROZEN(value) &&
    nativeWeakSetHas(value)
  );
}
