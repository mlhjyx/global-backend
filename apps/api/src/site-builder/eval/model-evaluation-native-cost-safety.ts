import { createHash } from "node:crypto";

import {
  MODEL_CANDIDATE_PROTOCOLS,
  type ModelCandidateProtocol,
} from "../agents/model-candidate-baseline";

/**
 * A parallel, no-FX cost contract for fixed-commit model evaluations.
 *
 * The pre-existing cents-based contract remains the mechanical policy guard for
 * its own evaluator. It is deliberately not reused here: OpenOx quotes this
 * design_spec matrix in two native currencies, which must never be converted
 * or summed.
 */
export const SITE_BUILDER_MODEL_EVALUATION_NATIVE_COST_SAFETY_ID =
  "site-builder-model-evaluation-native-cost-safety/2026-08-03-v2" as const;

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._/-]{7,127}$/;
const PICO_UNITS = /^(?:0|[1-9][0-9]*)$/;
const HISTORICAL_V14_MANIFEST_SHA256 =
  "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72";
const HISTORICAL_V14_FEE_CARD_SHA256 =
  "de3f778561ce1cc630629b8674ca7932b991a9ded61fa02a3220aa13578dd869";
const HISTORICAL_V14_SUITE_ID =
  "site-builder.design-spec-evaluation-suite/2026-08-01-v14";
const HISTORICAL_V14_SOURCE_BUNDLE_ID =
  "design-spec-evaluation-source-bundle/v14";
const REQUIRED_NEW_API_EVALUATION_ORIGIN = "http://127.0.0.1:3001";

const REQUIRED_TARGET_DISPATCHES = Object.freeze([
  {
    alias: "gpt-5.6-terra",
    protocol: "openai-responses",
    currency: "CNY",
  },
  {
    alias: "gpt-5.5",
    protocol: "openai-responses",
    currency: "CNY",
  },
  {
    alias: "claude-sonnet-5",
    protocol: "anthropic-messages",
    currency: "USD",
  },
] as const);
const REQUIRED_EXECUTION_COUNTS = Object.freeze({
  "gpt-5.6-terra:openai-responses": 24,
  "gpt-5.5:openai-responses": 25,
  "claude-sonnet-5:anthropic-messages": 24,
} as const);
const REQUIRED_DISPATCH_EXECUTIONS = 73;
const REQUIRED_WIRE_CALLS = 146;
const REQUIRED_INITIAL_INPUT_TOKENS = 6438;
const REQUIRED_REPAIR_INPUT_TOKENS = 10745;
const REQUIRED_OUTPUT_TOKENS_PER_WIRE = 4000;
// Fixed by the create-only design_spec v2 manifest and carried into the
// native OpenOx fee card's token envelope (plus protocol framing tokens).
const REQUIRED_INITIAL_PROMPT_UTF8_BYTES = 2342;
const REQUIRED_REPAIR_PROMPT_UTF8_BYTES = 6649;
const USER_AUTHORIZED_MAXIMUMS_BY_CURRENCY = Object.freeze({
  CNY: 11276659000000n,
  USD: 3458427840000n,
} as const satisfies Record<NativeModelEvaluationCurrency, bigint>);

const NATIVE_COST_SAFETY_ATTESTATIONS = new WeakSet<object>();
const NATIVE_WEAK_SET_ADD = WeakSet.prototype.add;
const NATIVE_WEAK_SET_HAS = WeakSet.prototype.has;
const NATIVE_OBJECT_FREEZE = Object.freeze;
const NATIVE_OBJECT_IS_FROZEN = Object.isFrozen;
const NATIVE_OBJECT_VALUES = Object.values;
const NATIVE_APPLY = Reflect.apply;
const NATIVE_OBJECT_KEYS = Object.keys;
const NATIVE_OBJECT_HAS_OWN = Object.hasOwn;
const NATIVE_JSON_STRINGIFY = JSON.stringify;
const NATIVE_ARRAY_IS_ARRAY = Array.isArray;
const NATIVE_ARRAY_MAP = Array.prototype.map;
const NATIVE_ARRAY_SORT = Array.prototype.sort;
const NATIVE_ARRAY_EVERY = Array.prototype.every;
const NATIVE_ARRAY_SOME = Array.prototype.some;
const NATIVE_ARRAY_FIND = Array.prototype.find;
const NATIVE_ARRAY_INCLUDES = Array.prototype.includes;
const NATIVE_DATE = Date;
const NATIVE_DATE_PARSE = Date.parse;
const NATIVE_DATE_TO_ISO_STRING = Date.prototype.toISOString;
const NATIVE_NUMBER_IS_FINITE = Number.isFinite;
const NATIVE_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NATIVE_BIGINT = BigInt;
const NATIVE_BIGINT_TO_STRING = BigInt.prototype.toString;
const NATIVE_REGEXP_TEST = RegExp.prototype.test;
const NATIVE_STRUCTURED_CLONE = structuredClone;
const NATIVE_CREATE_HASH = createHash;
const NATIVE_HASH = NATIVE_CREATE_HASH("sha256");
const NATIVE_HASH_UPDATE = NATIVE_HASH.update;
const NATIVE_HASH_DIGEST = NATIVE_HASH.digest;

export type NativeModelEvaluationCurrency = "CNY" | "USD";
export type NativeModelEvaluationWireAttempt = "initial" | "repair";

export interface NativeModelEvaluationDispatch {
  mode: "target";
  alias: string;
  protocol: ModelCandidateProtocol;
  currency: NativeModelEvaluationCurrency;
}

/**
 * A token-log receipt is only meaningful when new-api's channel and purpose
 * are part of the same credential snapshot as the allowed dispatch scope.
 */
export interface NativeModelEvaluationGatewaySettlementRoute {
  alias: string;
  protocol: Extract<
    ModelCandidateProtocol,
    "openai-responses" | "anthropic-messages"
  >;
  channelId: number;
}

export interface NativeModelEvaluationCostSafetyInput {
  contractId: typeof SITE_BUILDER_MODEL_EVALUATION_NATIVE_COST_SAFETY_ID;
  authorization: {
    authorizationId: string;
    ledgerId: string;
    ledgerDirectorySha256: string;
    approvedAt: string;
    approvedMaximumsByCurrency: Record<NativeModelEvaluationCurrency, string>;
    approvedDispatchExecutions: number;
    approvedWireCalls: number;
    preparedFixedCommitSha: string;
    preparedManifestSha256: string;
    preparedFeeCardSha256: string;
    preparedSuiteId: string;
    preparedSourceBundleContractId: string;
    preparedSourceBundleSha256: string;
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
    allowedDispatches: NativeModelEvaluationDispatch[];
    gatewaySettlement: {
      purposeGroup: "design-spec-eval";
      tokenLogPath: "/api/log/token";
      routes: NativeModelEvaluationGatewaySettlementRoute[];
    };
  };
  pricing: {
    authority: "openox_model_marketplace";
    catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
    capturedAt: string;
    catalogResponseSha256: string;
    noForeignExchangeConversion: true;
    entries: {
      alias: string;
      protocol: ModelCandidateProtocol;
      currency: NativeModelEvaluationCurrency;
      inputRateMicrounitsPerMillionTokens: number;
      outputRateMicrounitsPerMillionTokens: number;
    }[];
  };
  limits: {
    maximumsByCurrency: Record<NativeModelEvaluationCurrency, string>;
    maxDispatchExecutions: number;
    maxWireCalls: number;
    maxInitialPromptUtf8Bytes: number;
    maxRepairPromptUtf8Bytes: number;
    maxInputTokensInitialWire: number;
    maxInputTokensRepairWire: number;
    maxOutputTokensPerWire: number;
  };
  settlement: {
    requestIdentityField: "executionId";
    requireVerifiedRequestSettlement: true;
    unknownSettlementPolicy: "freeze_campaign";
  };
}

export type NativeModelEvaluationCostSafetyAttestation =
  Readonly<NativeModelEvaluationCostSafetyInput>;

export type NativeModelEvaluationCostSettlement =
  | {
      state: "settled";
      executionId: string;
      currency: NativeModelEvaluationCurrency;
      nativePicoUnits: string;
      basis: `frozen_openox_native_pricing@${string}`;
    }
  | {
      state: "not_incurred";
      reason: "rejected_before_dispatch" | "provider_attested_not_incurred";
    }
  | {
      state: "unknown";
      reason:
        "provider_ack_unknown" | "diagnostic_hard_stop" | "invalid_settlement";
    };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !NATIVE_OBJECT_IS_FROZEN(value)) {
    NATIVE_OBJECT_FREEZE(value);
    const children = NATIVE_OBJECT_VALUES(value);
    for (let index = 0; index < children.length; index += 1) {
      deepFreeze(children[index]);
    }
  }
  return value;
}

function nativeWeakSetAdd(value: object): void {
  NATIVE_APPLY(NATIVE_WEAK_SET_ADD, NATIVE_COST_SAFETY_ATTESTATIONS, [value]);
}

function nativeWeakSetHas(value: object): boolean {
  return NATIVE_APPLY(NATIVE_WEAK_SET_HAS, NATIVE_COST_SAFETY_ATTESTATIONS, [
    value,
  ]) as boolean;
}

function nativeArrayMap<T, U>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => U,
): U[] {
  return NATIVE_APPLY(NATIVE_ARRAY_MAP, values, [callback]) as U[];
}

function nativeArraySort<T>(values: T[]): T[] {
  return NATIVE_APPLY(NATIVE_ARRAY_SORT, values, []) as T[];
}

function nativeArrayEvery<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): boolean {
  return NATIVE_APPLY(NATIVE_ARRAY_EVERY, values, [callback]) as boolean;
}

function nativeArraySome<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): boolean {
  return NATIVE_APPLY(NATIVE_ARRAY_SOME, values, [callback]) as boolean;
}

function nativeArrayFind<T>(
  values: readonly T[],
  callback: (value: T, index: number, array: T[]) => boolean,
): T | undefined {
  return NATIVE_APPLY(NATIVE_ARRAY_FIND, values, [callback]) as T | undefined;
}

function nativeArrayIncludes<T>(values: readonly T[], value: T): boolean {
  return NATIVE_APPLY(NATIVE_ARRAY_INCLUDES, values, [value]) as boolean;
}

function nativeRegExpTest(pattern: RegExp, value: string): boolean {
  return NATIVE_APPLY(NATIVE_REGEXP_TEST, pattern, [value]) as boolean;
}

function nativeBigInt(value: string | number): bigint {
  return NATIVE_BIGINT(value);
}

function nativeBigIntString(value: bigint): string {
  return NATIVE_APPLY(NATIVE_BIGINT_TO_STRING, value, []) as string;
}

function nativeSha256Text(value: string): string {
  const hash = NATIVE_CREATE_HASH("sha256");
  NATIVE_APPLY(NATIVE_HASH_UPDATE, hash, [value, "utf8"]);
  return NATIVE_APPLY(NATIVE_HASH_DIGEST, hash, ["hex"]) as string;
}

function canonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = NATIVE_DATE_PARSE(value);
  return (
    NATIVE_NUMBER_IS_FINITE(milliseconds) &&
    (NATIVE_APPLY(
      NATIVE_DATE_TO_ISO_STRING,
      new NATIVE_DATE(milliseconds),
      [],
    ) as string) === value
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return NATIVE_NUMBER_IS_SAFE_INTEGER(value) && (value as number) > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return NATIVE_NUMBER_IS_SAFE_INTEGER(value) && (value as number) >= 0;
}

function canonicalPicoUnits(value: unknown): value is string {
  return typeof value === "string" && nativeRegExpTest(PICO_UNITS, value);
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object") return false;
  const actual = nativeArraySort(NATIVE_OBJECT_KEYS(value));
  const expectedKeys = nativeArraySort(
    nativeArrayMap(expected, (key) => key),
  );
  if (actual.length !== expectedKeys.length) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expectedKeys[index]) return false;
  }
  return true;
}

function dispatchKey(value: {
  alias: string;
  protocol: ModelCandidateProtocol;
  currency: NativeModelEvaluationCurrency;
}): string {
  return `${value.alias}:${value.protocol}:${value.currency}`;
}

function exactDispatchSet(
  values: readonly {
    alias: string;
    protocol: ModelCandidateProtocol;
    currency: NativeModelEvaluationCurrency;
  }[],
): boolean {
  const expected = nativeArraySort(
    nativeArrayMap(REQUIRED_TARGET_DISPATCHES, dispatchKey),
  );
  if (values.length !== expected.length) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (
      !NATIVE_APPLY(NATIVE_OBJECT_HAS_OWN, Object, [values, index]) ||
      !values[index]
    ) {
      return false;
    }
  }
  const actual = nativeArraySort(nativeArrayMap(values, dispatchKey));
  return (
    actual.length === expected.length &&
    nativeArrayEvery(actual, (value, index) => value === expected[index])
  );
}

function receiptRouteKey(value: {
  alias: string;
  protocol: ModelCandidateProtocol;
}): string {
  return `${value.alias}:${value.protocol}`;
}

function exactGatewaySettlementBinding(
  value: NativeModelEvaluationCostSafetyInput["credential"]["gatewaySettlement"],
  allowedDispatches: readonly NativeModelEvaluationDispatch[],
): boolean {
  if (
    !exactKeys(value, ["purposeGroup", "tokenLogPath", "routes"]) ||
    value.purposeGroup !== "design-spec-eval" ||
    value.tokenLogPath !== "/api/log/token" ||
    !NATIVE_ARRAY_IS_ARRAY(value.routes) ||
    value.routes.length !== allowedDispatches.length
  ) {
    return false;
  }
  const expected = nativeArraySort(
    nativeArrayMap(allowedDispatches, receiptRouteKey),
  );
  const received: string[] = [];
  for (let index = 0; index < value.routes.length; index += 1) {
    const route = value.routes[index];
    if (
      !route ||
      !exactKeys(route, ["alias", "protocol", "channelId"]) ||
      !positiveSafeInteger(route.channelId) ||
      (route.protocol !== "openai-responses" &&
        route.protocol !== "anthropic-messages")
    ) {
      return false;
    }
    received.push(receiptRouteKey(route));
  }
  const actual = nativeArraySort(received);
  return (
    actual.length === expected.length &&
    nativeArrayEvery(actual, (entry, index) => entry === expected[index])
  );
}

/**
 * Binds a prepared fee-card identifier to the exact, native-currency OpenOx
 * prices that will later be reserved and settled. This deliberately contains
 * no FX or generic-cents representation.
 */
export function nativeModelEvaluationPricingFeeCardSha256(
  pricing: NativeModelEvaluationCostSafetyInput["pricing"],
): string {
  const entries = nativeArraySort(
    nativeArrayMap(pricing.entries, (entry) =>
      NATIVE_JSON_STRINGIFY(entry.alias) +
      "\u0000" +
      NATIVE_JSON_STRINGIFY(entry.protocol) +
      "\u0000" +
      NATIVE_JSON_STRINGIFY(entry.currency) +
      "\u0000" +
      NATIVE_JSON_STRINGIFY(entry.inputRateMicrounitsPerMillionTokens) +
      "\u0000" +
      NATIVE_JSON_STRINGIFY(entry.outputRateMicrounitsPerMillionTokens),
    ),
  );
  let canonical =
    "site-builder-model-evaluation-native-pricing-fee-card/v1\u0000" +
    NATIVE_JSON_STRINGIFY(pricing.authority) +
    "\u0000" +
    NATIVE_JSON_STRINGIFY(pricing.catalogEndpoint) +
    "\u0000" +
    NATIVE_JSON_STRINGIFY(pricing.capturedAt) +
    "\u0000" +
    NATIVE_JSON_STRINGIFY(pricing.catalogResponseSha256) +
    "\u0000" +
    NATIVE_JSON_STRINGIFY(pricing.noForeignExchangeConversion);
  for (let index = 0; index < entries.length; index += 1) {
    canonical += `\u0000${entries[index]}`;
  }
  return nativeSha256Text(canonical);
}

function aliasProtocolKey(value: {
  alias: string;
  protocol: ModelCandidateProtocol;
}): keyof typeof REQUIRED_EXECUTION_COUNTS | null {
  const key = `${value.alias}:${value.protocol}`;
  return NATIVE_APPLY(NATIVE_OBJECT_HAS_OWN, Object, [
    REQUIRED_EXECUTION_COUNTS,
    key,
  ]) === true
    ? (key as keyof typeof REQUIRED_EXECUTION_COUNTS)
    : null;
}

function validMaximums(
  value: unknown,
): value is Record<NativeModelEvaluationCurrency, string> {
  return (
    exactKeys(value, ["CNY", "USD"]) &&
    canonicalPicoUnits((value as Record<string, unknown>).CNY) &&
    canonicalPicoUnits((value as Record<string, unknown>).USD) &&
    nativeBigInt((value as Record<string, string>).CNY) > 0n &&
    nativeBigInt((value as Record<string, string>).USD) > 0n
  );
}

function matchesExactNativeDesignSpecMatrix(
  authorization: NativeModelEvaluationCostSafetyInput["authorization"],
  pricing: NativeModelEvaluationCostSafetyInput["pricing"],
  limits: NativeModelEvaluationCostSafetyInput["limits"],
): boolean {
  if (
    authorization.approvedDispatchExecutions !== REQUIRED_DISPATCH_EXECUTIONS ||
    authorization.approvedWireCalls !== REQUIRED_WIRE_CALLS ||
    limits.maxDispatchExecutions !== REQUIRED_DISPATCH_EXECUTIONS ||
    limits.maxWireCalls !== REQUIRED_WIRE_CALLS ||
    limits.maxInitialPromptUtf8Bytes !== REQUIRED_INITIAL_PROMPT_UTF8_BYTES ||
    limits.maxRepairPromptUtf8Bytes !== REQUIRED_REPAIR_PROMPT_UTF8_BYTES ||
    limits.maxInputTokensInitialWire !== REQUIRED_INITIAL_INPUT_TOKENS ||
    limits.maxInputTokensRepairWire !== REQUIRED_REPAIR_INPUT_TOKENS ||
    limits.maxOutputTokensPerWire !== REQUIRED_OUTPUT_TOKENS_PER_WIRE
  ) {
    return false;
  }
  const totals = { CNY: 0n, USD: 0n } as Record<
    NativeModelEvaluationCurrency,
    bigint
  >;
  for (let index = 0; index < pricing.entries.length; index += 1) {
    const entry = pricing.entries[index];
    if (!entry) return false;
    const executionKey = aliasProtocolKey(entry);
    if (executionKey === null) return false;
    const executions = REQUIRED_EXECUTION_COUNTS[executionKey];
    const initialPicoUnits =
      nativeBigInt(limits.maxInputTokensInitialWire) *
        nativeBigInt(entry.inputRateMicrounitsPerMillionTokens) +
      nativeBigInt(limits.maxOutputTokensPerWire) *
        nativeBigInt(entry.outputRateMicrounitsPerMillionTokens);
    const repairPicoUnits =
      nativeBigInt(limits.maxInputTokensRepairWire) *
        nativeBigInt(entry.inputRateMicrounitsPerMillionTokens) +
      nativeBigInt(limits.maxOutputTokensPerWire) *
        nativeBigInt(entry.outputRateMicrounitsPerMillionTokens);
    totals[entry.currency] +=
      (initialPicoUnits + repairPicoUnits) * nativeBigInt(executions);
  }
  return (
    totals.CNY === nativeBigInt(limits.maximumsByCurrency.CNY) &&
    totals.USD === nativeBigInt(limits.maximumsByCurrency.USD) &&
    totals.CNY <= USER_AUTHORIZED_MAXIMUMS_BY_CURRENCY.CNY &&
    totals.USD <= USER_AUTHORIZED_MAXIMUMS_BY_CURRENCY.USD
  );
}

function validNativeCostSafetyInput(
  value: NativeModelEvaluationCostSafetyInput,
): boolean {
  const { authorization, credential, pricing, limits, settlement } = value;
  if (
    !exactKeys(value, [
      "contractId",
      "authorization",
      "credential",
      "pricing",
      "limits",
      "settlement",
    ]) ||
    value.contractId !== SITE_BUILDER_MODEL_EVALUATION_NATIVE_COST_SAFETY_ID ||
    !exactKeys(authorization, [
      "authorizationId",
      "ledgerId",
      "ledgerDirectorySha256",
      "approvedAt",
      "approvedMaximumsByCurrency",
      "approvedDispatchExecutions",
      "approvedWireCalls",
      "preparedFixedCommitSha",
      "preparedManifestSha256",
      "preparedFeeCardSha256",
      "preparedSuiteId",
      "preparedSourceBundleContractId",
      "preparedSourceBundleSha256",
    ]) ||
    !exactKeys(credential, [
      "attestationId",
      "observedAt",
      "snapshotSha256",
      "bearerTokenSha256",
      "gatewayOrigin",
      "purpose",
      "quotaMode",
      "scopeExact",
      "allowedDispatches",
      "gatewaySettlement",
    ]) ||
    !exactKeys(pricing, [
      "authority",
      "catalogEndpoint",
      "capturedAt",
      "catalogResponseSha256",
      "noForeignExchangeConversion",
      "entries",
    ]) ||
    !exactKeys(limits, [
      "maximumsByCurrency",
      "maxDispatchExecutions",
      "maxWireCalls",
      "maxInitialPromptUtf8Bytes",
      "maxRepairPromptUtf8Bytes",
      "maxInputTokensInitialWire",
      "maxInputTokensRepairWire",
      "maxOutputTokensPerWire",
    ]) ||
    !exactKeys(settlement, [
      "requestIdentityField",
      "requireVerifiedRequestSettlement",
      "unknownSettlementPolicy",
    ]) ||
    !nativeRegExpTest(IDENTIFIER, authorization.authorizationId) ||
    !nativeRegExpTest(IDENTIFIER, authorization.ledgerId) ||
    !nativeRegExpTest(SHA256, authorization.ledgerDirectorySha256) ||
    !canonicalUtcInstant(authorization.approvedAt) ||
    !validMaximums(authorization.approvedMaximumsByCurrency) ||
    !positiveSafeInteger(authorization.approvedDispatchExecutions) ||
    !positiveSafeInteger(authorization.approvedWireCalls) ||
    authorization.approvedWireCalls <
      authorization.approvedDispatchExecutions ||
    !nativeRegExpTest(SHA1, authorization.preparedFixedCommitSha) ||
    !nativeRegExpTest(SHA256, authorization.preparedManifestSha256) ||
    !nativeRegExpTest(SHA256, authorization.preparedFeeCardSha256) ||
    authorization.preparedManifestSha256 === HISTORICAL_V14_MANIFEST_SHA256 ||
    authorization.preparedFeeCardSha256 === HISTORICAL_V14_FEE_CARD_SHA256 ||
    authorization.preparedSuiteId === HISTORICAL_V14_SUITE_ID ||
    authorization.preparedSourceBundleContractId ===
      HISTORICAL_V14_SOURCE_BUNDLE_ID ||
    !nativeRegExpTest(IDENTIFIER, authorization.preparedSuiteId) ||
    !nativeRegExpTest(
      IDENTIFIER,
      authorization.preparedSourceBundleContractId,
    ) ||
    !nativeRegExpTest(SHA256, authorization.preparedSourceBundleSha256) ||
    credential.purpose !== "site_builder_model_evaluation" ||
    credential.quotaMode !== "limited" ||
    credential.scopeExact !== true ||
    !nativeRegExpTest(IDENTIFIER, credential.attestationId) ||
    !canonicalUtcInstant(credential.observedAt) ||
    !nativeRegExpTest(SHA256, credential.snapshotSha256) ||
    !nativeRegExpTest(SHA256, credential.bearerTokenSha256) ||
    credential.gatewayOrigin !== REQUIRED_NEW_API_EVALUATION_ORIGIN ||
    !NATIVE_ARRAY_IS_ARRAY(credential.allowedDispatches) ||
    !exactDispatchSet(credential.allowedDispatches) ||
    !exactGatewaySettlementBinding(
      credential.gatewaySettlement,
      credential.allowedDispatches,
    ) ||
    nativeArraySome(
      credential.allowedDispatches,
      (dispatch) =>
        !exactKeys(dispatch, ["mode", "alias", "protocol", "currency"]) ||
        dispatch.mode !== "target" ||
        !nativeArrayIncludes(MODEL_CANDIDATE_PROTOCOLS, dispatch.protocol),
    ) ||
    pricing.authority !== "openox_model_marketplace" ||
    pricing.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    !canonicalUtcInstant(pricing.capturedAt) ||
    !nativeRegExpTest(SHA256, pricing.catalogResponseSha256) ||
    pricing.noForeignExchangeConversion !== true ||
    !NATIVE_ARRAY_IS_ARRAY(pricing.entries) ||
    !exactDispatchSet(pricing.entries) ||
    nativeArraySome(
      pricing.entries,
      (entry) =>
        !exactKeys(entry, [
          "alias",
          "protocol",
          "currency",
          "inputRateMicrounitsPerMillionTokens",
          "outputRateMicrounitsPerMillionTokens",
        ]) ||
        !nativeArrayIncludes(MODEL_CANDIDATE_PROTOCOLS, entry.protocol) ||
        !positiveSafeInteger(entry.inputRateMicrounitsPerMillionTokens) ||
        !positiveSafeInteger(entry.outputRateMicrounitsPerMillionTokens),
    ) ||
    !validMaximums(limits.maximumsByCurrency) ||
    !positiveSafeInteger(limits.maxDispatchExecutions) ||
    !positiveSafeInteger(limits.maxWireCalls) ||
    limits.maxWireCalls < limits.maxDispatchExecutions ||
    limits.maxDispatchExecutions !== authorization.approvedDispatchExecutions ||
    limits.maxWireCalls !== authorization.approvedWireCalls ||
    limits.maximumsByCurrency.CNY !==
      authorization.approvedMaximumsByCurrency.CNY ||
    limits.maximumsByCurrency.USD !==
      authorization.approvedMaximumsByCurrency.USD ||
    !positiveSafeInteger(limits.maxInitialPromptUtf8Bytes) ||
    !positiveSafeInteger(limits.maxRepairPromptUtf8Bytes) ||
    limits.maxRepairPromptUtf8Bytes < limits.maxInitialPromptUtf8Bytes ||
    !positiveSafeInteger(limits.maxInputTokensInitialWire) ||
    !positiveSafeInteger(limits.maxInputTokensRepairWire) ||
    limits.maxInputTokensRepairWire < limits.maxInputTokensInitialWire ||
    !positiveSafeInteger(limits.maxOutputTokensPerWire) ||
    settlement.requestIdentityField !== "executionId" ||
    settlement.requireVerifiedRequestSettlement !== true ||
    settlement.unknownSettlementPolicy !== "freeze_campaign" ||
    !matchesExactNativeDesignSpecMatrix(authorization, pricing, limits) ||
    authorization.preparedFeeCardSha256 !==
      nativeModelEvaluationPricingFeeCardSha256(pricing)
  ) {
    return false;
  }
  return true;
}

/** Creates a private-brand attestation; plain cloned JSON is never trusted. */
export function createNativeModelEvaluationCostSafetyAttestation(
  input: NativeModelEvaluationCostSafetyInput,
): NativeModelEvaluationCostSafetyAttestation {
  let copy: NativeModelEvaluationCostSafetyInput;
  try {
    copy = NATIVE_STRUCTURED_CLONE(input);
  } catch {
    throw new Error(
      "native model evaluation cost safety attestation is invalid",
    );
  }
  if (!validNativeCostSafetyInput(copy)) {
    throw new Error(
      "native model evaluation cost safety attestation is invalid",
    );
  }
  const attestation = deepFreeze(copy);
  nativeWeakSetAdd(attestation);
  return attestation;
}

export function isTrustedNativeModelEvaluationCostSafetyAttestation(
  value: unknown,
): value is NativeModelEvaluationCostSafetyAttestation {
  return (
    !!value &&
    typeof value === "object" &&
    nativeWeakSetHas(value) &&
    NATIVE_OBJECT_IS_FROZEN(value)
  );
}

function trustedAttestation(
  value: unknown,
): NativeModelEvaluationCostSafetyAttestation {
  if (!isTrustedNativeModelEvaluationCostSafetyAttestation(value)) {
    throw new Error("native model evaluation dispatch is not authorized");
  }
  return value;
}

function nativePricingEntry(
  attestation: NativeModelEvaluationCostSafetyAttestation,
  alias: string,
  protocol: ModelCandidateProtocol,
) {
  return nativeArrayFind(
    attestation.pricing.entries,
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
}

function inputTokenLimitForWireAttempt(
  attestation: NativeModelEvaluationCostSafetyAttestation,
  wireAttempt: NativeModelEvaluationWireAttempt,
): number {
  return wireAttempt === "initial"
    ? attestation.limits.maxInputTokensInitialWire
    : attestation.limits.maxInputTokensRepairWire;
}

export function assertNativeModelEvaluationDispatch(
  value: unknown,
  input: {
    mode: "target";
    alias: string;
    protocol: ModelCandidateProtocol;
    wireAttempt: NativeModelEvaluationWireAttempt;
    maximumWireCalls: number;
    maxOutputTokens: number;
    inputTokens: number;
  },
): NativeModelEvaluationDispatch {
  const attestation = trustedAttestation(value);
  const admitted = nativeArrayFind(
    attestation.credential.allowedDispatches,
    (dispatch) =>
      dispatch.mode === input?.mode &&
      dispatch.alias === input?.alias &&
      dispatch.protocol === input?.protocol,
  );
  if (
    !admitted ||
    !nativePricingEntry(attestation, input.alias, input.protocol) ||
    (input.wireAttempt !== "initial" && input.wireAttempt !== "repair") ||
    !positiveSafeInteger(input.maximumWireCalls) ||
    input.maximumWireCalls > 2 ||
    !positiveSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens > attestation.limits.maxOutputTokensPerWire ||
    !nonNegativeSafeInteger(input.inputTokens) ||
    input.inputTokens >
      inputTokenLimitForWireAttempt(attestation, input.wireAttempt)
  ) {
    throw new Error("native model evaluation dispatch is not authorized");
  }
  return NATIVE_OBJECT_FREEZE({ ...admitted });
}

export function nativePicoUnitsForModelEvaluationUsage(
  value: unknown,
  input: {
    executionId: string;
    alias: string;
    protocol: ModelCandidateProtocol;
    wireAttempt: NativeModelEvaluationWireAttempt;
    inputTokens: number;
    outputTokens: number;
  },
): Extract<NativeModelEvaluationCostSettlement, { state: "settled" }> {
  const attestation = trustedAttestation(value);
  if (
    typeof input?.executionId !== "string" ||
    input.executionId.length === 0 ||
    (input.wireAttempt !== "initial" && input.wireAttempt !== "repair") ||
    !nonNegativeSafeInteger(input.inputTokens) ||
    !nonNegativeSafeInteger(input.outputTokens)
  ) {
    throw new Error("native model evaluation settlement is invalid");
  }
  const dispatch = assertNativeModelEvaluationDispatch(attestation, {
    mode: "target",
    alias: input.alias,
    protocol: input.protocol,
    wireAttempt: input.wireAttempt,
    maximumWireCalls: 1,
    maxOutputTokens: Math.max(1, input.outputTokens),
    inputTokens: input.inputTokens,
  });
  if (
    input.inputTokens >
      inputTokenLimitForWireAttempt(attestation, input.wireAttempt) ||
    input.outputTokens > attestation.limits.maxOutputTokensPerWire
  ) {
    throw new Error("native model evaluation settlement is invalid");
  }
  const pricing = nativePricingEntry(attestation, input.alias, input.protocol);
  if (!pricing || pricing.currency !== dispatch.currency) {
    throw new Error("native model evaluation settlement is invalid");
  }
  const nativePicoUnits =
    nativeBigInt(input.inputTokens) *
      nativeBigInt(pricing.inputRateMicrounitsPerMillionTokens) +
    nativeBigInt(input.outputTokens) *
      nativeBigInt(pricing.outputRateMicrounitsPerMillionTokens);
  return NATIVE_OBJECT_FREEZE({
    state: "settled" as const,
    executionId: input.executionId,
    currency: pricing.currency,
    nativePicoUnits: nativeBigIntString(nativePicoUnits),
    basis:
      `frozen_openox_native_pricing@${attestation.pricing.capturedAt}` as const,
  });
}

/**
 * Calculates the native reservation required before a physical wire call. The
 * caller chooses a wire attempt explicitly, so an initial call cannot borrow a
 * repair budget or vice versa.
 */
export function nativeMaximumPicoUnitsForModelEvaluationWire(
  value: unknown,
  input: {
    alias: string;
    protocol: ModelCandidateProtocol;
    wireAttempt: NativeModelEvaluationWireAttempt;
  },
): Readonly<{
  currency: NativeModelEvaluationCurrency;
  nativePicoUnits: string;
}> {
  const attestation = trustedAttestation(value);
  if (input?.wireAttempt !== "initial" && input?.wireAttempt !== "repair") {
    throw new Error("native model evaluation dispatch is not authorized");
  }
  const dispatch = assertNativeModelEvaluationDispatch(attestation, {
    mode: "target",
    alias: input.alias,
    protocol: input.protocol,
    wireAttempt: input.wireAttempt,
    maximumWireCalls: 1,
    maxOutputTokens: attestation.limits.maxOutputTokensPerWire,
    inputTokens: inputTokenLimitForWireAttempt(attestation, input.wireAttempt),
  });
  const pricing = nativePricingEntry(attestation, input.alias, input.protocol);
  if (!pricing || pricing.currency !== dispatch.currency) {
    throw new Error("native model evaluation dispatch is not authorized");
  }
  const nativePicoUnits =
    nativeBigInt(
      inputTokenLimitForWireAttempt(attestation, input.wireAttempt),
    ) *
      nativeBigInt(pricing.inputRateMicrounitsPerMillionTokens) +
    nativeBigInt(attestation.limits.maxOutputTokensPerWire) *
      nativeBigInt(pricing.outputRateMicrounitsPerMillionTokens);
  return NATIVE_OBJECT_FREEZE({
    currency: pricing.currency,
    nativePicoUnits: nativeBigIntString(nativePicoUnits),
  });
}
