import {
  createNativeModelEvaluationCostSafetyAttestation,
  nativeModelEvaluationPricingFeeCardSha256,
  type NativeModelEvaluationCostSafetyAttestation,
  type NativeModelEvaluationCostSafetyInput,
} from "./model-evaluation-native-cost-safety";
import { sha256CanonicalJson } from "./eval-provenance";

/**
 * Admission bridge for the only merged v5 design_spec public-price evidence.
 *
 * This bridge deliberately accepts the immutable evidence wrapper, rather than
 * a caller-supplied pricing table. The generic native cost safety contract
 * remains useful for isolated fake-fetch tests, but it is not an execution
 * admission path for design_spec.
 */
export const DESIGN_SPEC_V5_NATIVE_EXECUTION_PREFLIGHT_ID =
  "site-builder-design-spec-v5-native-execution-preflight/2026-08-04-v1" as const;

const V5_EVIDENCE_SCHEMA =
  "site-builder-design-spec-v5-native-fee-card-evidence/v1" as const;
const V5_PREPARATION_COMMIT =
  "0a32c1737c82f30c3f333fd48d77f572bf1e8318" as const;
const V5_CARD_SHA256 =
  "ad76f3aea73fbdccdd27cf8e509af206d66a249f06a7566512d55c32819a18e8" as const;
const V5_MANIFEST_SHA256 =
  "bcc0ac261f56a5c950e11483a3dc28f33ed678c626891367a45b6c1f56429dc4" as const;
const V5_SUITE_ID =
  "site-builder.design-spec-evaluation-suite/2026-08-03-v15" as const;
const V5_SOURCE_BUNDLE_CONTRACT_ID =
  "design-spec-evaluation-source-bundle/v15" as const;
const V5_SOURCE_BUNDLE_SHA256 =
  "0a14c446ddb0527204b6c0a472597403aaf61998c1d12975595ae921ffd8e98d" as const;
const V5_FIXED_SOURCE_COMMIT =
  "377f8a3ae983bad0e4ae43f767a4bc59d8f7d0a9" as const;

const TRUSTED_V5_ATTESTATIONS = new WeakSet<object>();
const NATIVE_WEAK_SET_ADD = WeakSet.prototype.add;
const NATIVE_WEAK_SET_HAS = WeakSet.prototype.has;
const NATIVE_OBJECT_FREEZE = Object.freeze;
const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;
const NATIVE_APPLY = Reflect.apply;

type NativeAuthorizationInput =
  NativeModelEvaluationCostSafetyInput["authorization"];
type NativeCredentialInput = NativeModelEvaluationCostSafetyInput["credential"];

interface ValidatedV5Card {
  pricing: NativeModelEvaluationCostSafetyInput["pricing"];
  limits: NativeModelEvaluationCostSafetyInput["limits"];
}

export interface DesignSpecV5NativeExecutionPreflightInput {
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

export type DesignSpecV5NativeExecutionAttestation =
  NativeModelEvaluationCostSafetyAttestation;

function nativeWeakSetAdd(value: object): void {
  NATIVE_APPLY(NATIVE_WEAK_SET_ADD, TRUSTED_V5_ATTESTATIONS, [value]);
}

function nativeWeakSetHas(value: object): boolean {
  return NATIVE_APPLY(NATIVE_WEAK_SET_HAS, TRUSTED_V5_ATTESTATIONS, [
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

function assertV5FeeCardEvidence(value: unknown): ValidatedV5Card {
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
    throw new Error("design_spec v5 fee-card evidence is invalid");
  }
  if (
    value.schemaVersion !== V5_EVIDENCE_SCHEMA ||
    value.preparationCommitSha !== V5_PREPARATION_COMMIT ||
    value.modelWireCalls !== 0 ||
    value.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    !isRecord(value.actualModelCost) ||
    !exactKeys(value.actualModelCost, ["CNY", "USD"]) ||
    value.actualModelCost.CNY !== "0" ||
    value.actualModelCost.USD !== "0" ||
    !isRecord(value.card)
  ) {
    throw new Error("design_spec v5 fee-card evidence is invalid");
  }
  const card = value.card;
  const cardSha256 = card.cardSha256;
  const { cardSha256: _cardDigest, ...unsignedCard } = card;
  if (
    cardSha256 !== V5_CARD_SHA256 ||
    sha256CanonicalJson(unsignedCard) !== V5_CARD_SHA256 ||
    card.schemaVersion !== "site-builder-design-spec-v5-native-fee-card/v1" ||
    card.feeCardId !==
      "site-builder-design-spec-v5-native-fee-card/2026-08-04-v1" ||
    card.status !== "READY_FOR_CREDENTIAL_ATTESTATION" ||
    card.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    card.fixedSourceCommitSha !== V5_FIXED_SOURCE_COMMIT ||
    card.manifestSha256 !== V5_MANIFEST_SHA256 ||
    card.noForeignExchangeConversion !== true ||
    card.expectedCost !== "not_known_before_usage" ||
    !isRecord(card.suite) ||
    card.suite.suiteId !== V5_SUITE_ID ||
    card.suite.sourceBundleContractId !== V5_SOURCE_BUNDLE_CONTRACT_ID ||
    card.suite.sourceBundleSha256 !== V5_SOURCE_BUNDLE_SHA256 ||
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
    throw new Error("design_spec v5 fee-card evidence is invalid");
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
      throw new Error("design_spec v5 fee-card evidence is invalid");
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
    throw new Error("design_spec v5 fee-card evidence is invalid");
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
 * Creates an execution-only attestation bound to the merged v5 public-price
 * evidence. It does not authorize dispatch: finite credential and ledger
 * authorization are still required by the execution runner.
 */
export function createDesignSpecV5NativeExecutionAttestation(
  input: DesignSpecV5NativeExecutionPreflightInput,
): DesignSpecV5NativeExecutionAttestation {
  const feeCard = assertV5FeeCardEvidence(input?.feeCardEvidence);
  const attestation = createNativeModelEvaluationCostSafetyAttestation({
    contractId:
      "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2",
    authorization: {
      ...input.authorization,
      preparedManifestSha256: V5_MANIFEST_SHA256,
      preparedFeeCardSha256: nativeModelEvaluationPricingFeeCardSha256(
        feeCard.pricing,
      ),
      preparedSuiteId: V5_SUITE_ID,
      preparedSourceBundleContractId: V5_SOURCE_BUNDLE_CONTRACT_ID,
      preparedSourceBundleSha256: V5_SOURCE_BUNDLE_SHA256,
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

export function isTrustedDesignSpecV5NativeExecutionAttestation(
  value: unknown,
): value is DesignSpecV5NativeExecutionAttestation {
  return (
    !!value &&
    typeof value === "object" &&
    NATIVE_OBJECT_IS_FROZEN(value) &&
    nativeWeakSetHas(value)
  );
}
