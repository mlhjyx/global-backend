import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import {
  settlementOpenOxPrice,
  type OpenOxPricingCatalog,
} from "../site-builder-model-settlement";
import { sha256CanonicalJson } from "./eval-provenance";
import { MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND } from "./model-evaluation-cost-safety";

/**
 * A v2-only source contract. It admits the manifest fixed on main by #267,
 * but cannot authorize any dispatch. The separately reviewed, create-only
 * public-price artifact is intentionally not present in this source change.
 */
export const DESIGN_SPEC_V2_NATIVE_FEE_CARD_ID =
  "site-builder-design-spec-v2-native-fee-card/2026-08-03-v1" as const;
export const DESIGN_SPEC_V2_NATIVE_FEE_CARD_SCHEMA_VERSION =
  "site-builder-design-spec-v2-native-fee-card/v1" as const;

const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES = Object.freeze([
  {
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    groupName: "gpt-unified",
    currency: "CNY",
    executionCount: 24,
  },
  {
    alias: "gpt-5.5",
    protocol: "openai-responses",
    groupName: "gpt-unified",
    currency: "CNY",
    executionCount: 25,
  },
  {
    alias: "claude-sonnet-5",
    protocol: "anthropic-messages",
    groupName: "special",
    currency: "USD",
    executionCount: 24,
  },
] as const);

const REQUIRED_FIXED_SOURCE_COMMIT_SHA =
  "295038d323b4bd09ed16ab73ea981d24e1f010df" as const;
const REQUIRED_SUITE_ID =
  "site-builder.design-spec-evaluation-suite/2026-08-03-v15" as const;
const REQUIRED_SOURCE_BUNDLE_CONTRACT_ID =
  "design-spec-evaluation-source-bundle/v15" as const;
const REQUIRED_SOURCE_BUNDLE_SHA256 =
  "9419952c08330c7dc4eafc2bf2d54c8804a9f3ca36fc5ba9d85d0458118d654f" as const;
const REQUIRED_MANIFEST_SHA256 =
  "aeb50d9f6cfb631b3a4fc20d94a0f42e11f4478fe02c181c408d589fe9280164" as const;

export type DesignSpecV2NativeCurrency =
  (typeof DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES)[number]["currency"];
export type DesignSpecV2NativeTargetProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

export interface DesignSpecV2NativeFeeCardInput {
  manifest: unknown;
  catalog: OpenOxPricingCatalog;
  capturedAt: string;
  catalogResponseSha256: string;
}

interface NativeAmount {
  /** Exact native-currency amount in 10^-12 units, represented as JSON text. */
  nativePicoUnits: string;
  formatted: string;
}

export interface DesignSpecV2NativeFeeCard {
  schemaVersion: typeof DESIGN_SPEC_V2_NATIVE_FEE_CARD_SCHEMA_VERSION;
  feeCardId: typeof DESIGN_SPEC_V2_NATIVE_FEE_CARD_ID;
  status: "READY_FOR_CREDENTIAL_ATTESTATION";
  dispatchAuthorization: "NOT_AUTHORIZED";
  fixedSourceCommitSha: string;
  manifestSha256: string;
  suite: {
    suiteId: string;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
  };
  pricing: {
    authority: "openox_model_marketplace";
    catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
    capturedAt: string;
    catalogResponseSha256: string;
  };
  tokenEnvelope: {
    initialInputTokens: number;
    repairInputTokens: number;
    outputTokensPerWireCall: number;
  };
  entries: readonly {
    alias: string;
    protocol: DesignSpecV2NativeTargetProtocol;
    groupName: string;
    currency: DesignSpecV2NativeCurrency;
    executionCount: number;
    maximumWireCalls: number;
    pricingVersion: string;
    effectiveInputRateMicrounitsPerMillionTokens: number;
    effectiveOutputRateMicrounitsPerMillionTokens: number;
    initialCallMaximum: NativeAmount;
    repairCallMaximum: NativeAmount;
    maximumCost: NativeAmount;
  }[];
  totalsByCurrency: Readonly<Record<DesignSpecV2NativeCurrency, NativeAmount>>;
  expectedCost: "not_known_before_usage";
  mechanicalPolicyCeiling: {
    amountCents: number;
    meaning: "mechanical_only_not_a_native_currency_budget";
  };
  noForeignExchangeConversion: true;
  cardSha256: string;
}

interface ValidatedManifest {
  fixedCommitSha: string;
  manifestSha256: string;
  promptUtf8Bytes: {
    maximumCanonicalInitial: number;
    maximumCanonicalRepair: number;
  };
  suite: {
    suiteId: string;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
  };
  planningHardUpperBound: { amountCents: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function dispatchKey(value: { alias: string; protocol: string }): string {
  return `${value.alias}:${value.protocol}`;
}

function assertManifest(value: unknown): ValidatedManifest {
  if (!isRecord(value)) {
    throw new Error("design_spec v2 manifest must be an object");
  }
  const promptUtf8Bytes = value.promptUtf8Bytes;
  const suite = value.suite;
  const executions = value.executions;
  const planningHardUpperBound = value.planningHardUpperBound;
  if (
    value.schemaVersion !==
      "site-builder-design-spec-evaluation-manifest-prep/v2" ||
    value.taskId !== "site_builder.design_spec" ||
    value.fixedCommitSha !== REQUIRED_FIXED_SOURCE_COMMIT_SHA ||
    value.createOnly !== true ||
    value.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    value.actualNetworkCalls !== 0 ||
    value.actualModelCostCents !== 0 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256.test(value.manifestSha256) ||
    !isRecord(promptUtf8Bytes) ||
    !positiveSafeInteger(promptUtf8Bytes.maximumCanonicalInitial) ||
    !positiveSafeInteger(promptUtf8Bytes.maximumCanonicalRepair) ||
    !isRecord(suite) ||
    suite.suiteId !== REQUIRED_SUITE_ID ||
    suite.sourceBundleContractId !== REQUIRED_SOURCE_BUNDLE_CONTRACT_ID ||
    suite.sourceBundleSha256 !== REQUIRED_SOURCE_BUNDLE_SHA256 ||
    !isRecord(planningHardUpperBound) ||
    !positiveSafeInteger(planningHardUpperBound.amountCents) ||
    value.executionCount !== 73 ||
    value.maximumWireCallCount !== 146 ||
    !Array.isArray(executions) ||
    executions.length !== 73
  ) {
    throw new Error("design_spec v2 manifest identity or envelope is invalid");
  }

  const { manifestSha256: declaredManifestSha256, ...manifestWithoutDigest } =
    value;
  if (sha256CanonicalJson(manifestWithoutDigest) !== declaredManifestSha256) {
    throw new Error("design_spec v2 manifest digest drifted");
  }

  const counts = new Map<string, number>();
  let capabilityProbeCount = 0;
  for (let index = 0; index < executions.length; index += 1) {
    const execution = executions[index];
    if (
      !isRecord(execution) ||
      (execution.kind !== "capability_probe" && execution.kind !== "target") ||
      typeof execution.alias !== "string" ||
      (execution.protocol !== "openai-responses" &&
        execution.protocol !== "anthropic-messages") ||
      execution.maximumWireCalls !== 2 ||
      execution.maximumRepairCalls !== 1
    ) {
      throw new Error("design_spec v2 execution alias or protocol drifted");
    }
    if (execution.kind === "capability_probe") {
      capabilityProbeCount += 1;
      if (
        index !== 0 ||
        execution.alias !== "gpt-5.5" ||
        execution.protocol !== "openai-responses"
      ) {
        throw new Error("design_spec v2 execution alias or protocol drifted");
      }
    }
    const key = dispatchKey({
      alias: execution.alias,
      protocol: execution.protocol,
    });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const expected = DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES.map(dispatchKey)
    .sort()
    .join("\u0000");
  const actual = [...counts.keys()].sort().join("\u0000");
  if (
    capabilityProbeCount !== 1 ||
    actual !== expected ||
    DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES.some(
      (dispatch) =>
        counts.get(dispatchKey(dispatch)) !== dispatch.executionCount,
    )
  ) {
    throw new Error("design_spec v2 execution alias or protocol drifted");
  }
  if (value.manifestSha256 !== REQUIRED_MANIFEST_SHA256) {
    throw new Error("design_spec v2 manifest identity or envelope is invalid");
  }

  return {
    fixedCommitSha: value.fixedCommitSha,
    manifestSha256: value.manifestSha256,
    promptUtf8Bytes: {
      maximumCanonicalInitial: promptUtf8Bytes.maximumCanonicalInitial,
      maximumCanonicalRepair: promptUtf8Bytes.maximumCanonicalRepair,
    },
    suite: {
      suiteId: suite.suiteId,
      sourceBundleContractId: suite.sourceBundleContractId,
      sourceBundleSha256: suite.sourceBundleSha256,
    },
    planningHardUpperBound: {
      amountCents: planningHardUpperBound.amountCents,
    },
  };
}

/** Validates the exact v2 manifest identity before any public catalog read. */
export function assertDesignSpecV2NativeFeeCardManifest(value: unknown): void {
  assertManifest(value);
}

function nativePicoUnits(
  inputTokens: number,
  outputTokens: number,
  inputRateMicrounitsPerMillionTokens: number,
  outputRateMicrounitsPerMillionTokens: number,
): bigint {
  if (
    !nonNegativeSafeInteger(inputTokens) ||
    !nonNegativeSafeInteger(outputTokens) ||
    !nonNegativeSafeInteger(inputRateMicrounitsPerMillionTokens) ||
    !nonNegativeSafeInteger(outputRateMicrounitsPerMillionTokens)
  ) {
    throw new Error("native fee amount is invalid");
  }
  return (
    BigInt(inputTokens) * BigInt(inputRateMicrounitsPerMillionTokens) +
    BigInt(outputTokens) * BigInt(outputRateMicrounitsPerMillionTokens)
  );
}

function amount(value: bigint): NativeAmount {
  if (value < 0n) throw new Error("native fee amount is negative");
  const scale = 1_000_000_000_000n;
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(12, "0")
    .replace(/0+$/, "");
  return {
    nativePicoUnits: value.toString(),
    formatted: fraction.length > 0 ? `${whole}.${fraction}` : whole.toString(),
  };
}

export function buildDesignSpecV2NativeFeeCard(
  input: DesignSpecV2NativeFeeCardInput,
): DesignSpecV2NativeFeeCard {
  if (
    !canonicalInstant(input.capturedAt) ||
    !SHA256.test(input.catalogResponseSha256)
  ) {
    throw new Error("v2 fee-card capture binding is invalid");
  }
  const manifest = assertManifest(input.manifest);
  const tokenEnvelope = {
    initialInputTokens:
      manifest.promptUtf8Bytes.maximumCanonicalInitial +
      MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
    repairInputTokens:
      manifest.promptUtf8Bytes.maximumCanonicalRepair +
      MODEL_EVALUATION_PROTOCOL_FRAMING_TOKEN_UPPER_BOUND,
    outputTokensPerWireCall: 4_000,
  };
  const totals = new Map<DesignSpecV2NativeCurrency, bigint>([
    ["CNY", 0n],
    ["USD", 0n],
  ]);
  const entries = DESIGN_SPEC_V2_NATIVE_FEE_CARD_DISPATCHES.map((dispatch) => {
    const price = settlementOpenOxPrice(
      input.catalog,
      dispatch.alias,
      dispatch.groupName,
    );
    if (!price || price.currency !== dispatch.currency) {
      throw new Error(
        `OpenOx price is missing or unpublished: ${dispatch.alias}`,
      );
    }
    const initial = nativePicoUnits(
      tokenEnvelope.initialInputTokens,
      tokenEnvelope.outputTokensPerWireCall,
      price.inputPriceMicrounitsPerMillionTokens,
      price.outputPriceMicrounitsPerMillionTokens,
    );
    const repair = nativePicoUnits(
      tokenEnvelope.repairInputTokens,
      tokenEnvelope.outputTokensPerWireCall,
      price.inputPriceMicrounitsPerMillionTokens,
      price.outputPriceMicrounitsPerMillionTokens,
    );
    const maximum = BigInt(dispatch.executionCount) * (initial + repair);
    totals.set(
      dispatch.currency,
      (totals.get(dispatch.currency) ?? 0n) + maximum,
    );
    return Object.freeze({
      alias: dispatch.alias,
      protocol: dispatch.protocol,
      groupName: dispatch.groupName,
      currency: dispatch.currency,
      executionCount: dispatch.executionCount,
      maximumWireCalls: dispatch.executionCount * 2,
      pricingVersion: price.pricingVersion,
      effectiveInputRateMicrounitsPerMillionTokens:
        price.inputPriceMicrounitsPerMillionTokens,
      effectiveOutputRateMicrounitsPerMillionTokens:
        price.outputPriceMicrounitsPerMillionTokens,
      initialCallMaximum: amount(initial),
      repairCallMaximum: amount(repair),
      maximumCost: amount(maximum),
    });
  }).sort((left, right) =>
    left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0,
  );

  const withoutDigest = {
    schemaVersion: DESIGN_SPEC_V2_NATIVE_FEE_CARD_SCHEMA_VERSION,
    feeCardId: DESIGN_SPEC_V2_NATIVE_FEE_CARD_ID,
    status: "READY_FOR_CREDENTIAL_ATTESTATION" as const,
    dispatchAuthorization: "NOT_AUTHORIZED" as const,
    fixedSourceCommitSha: manifest.fixedCommitSha,
    manifestSha256: manifest.manifestSha256,
    suite: manifest.suite,
    pricing: {
      authority: "openox_model_marketplace" as const,
      catalogEndpoint:
        "https://openox.tech/api/public/pricing-catalog" as const,
      capturedAt: input.capturedAt,
      catalogResponseSha256: input.catalogResponseSha256,
    },
    tokenEnvelope,
    entries,
    totalsByCurrency: {
      CNY: amount(totals.get("CNY")!),
      USD: amount(totals.get("USD")!),
    },
    expectedCost: "not_known_before_usage" as const,
    mechanicalPolicyCeiling: {
      amountCents: manifest.planningHardUpperBound.amountCents,
      meaning: "mechanical_only_not_a_native_currency_budget" as const,
    },
    noForeignExchangeConversion: true as const,
  };
  return Object.freeze({
    ...withoutDigest,
    cardSha256: sha256CanonicalJson(withoutDigest),
  });
}
