import type { ModelCandidateProtocol } from "../agents/model-candidate-baseline";
import type { RemainingTextNativeFeeCardTaskId } from "./remaining-text-native-fee-card";
import {
  NATIVE_APPLY,
  NATIVE_ARRAY_IS_ARRAY,
  NATIVE_DATE,
  NATIVE_DATE_PARSE,
  NATIVE_DATE_TO_ISO_STRING,
  NATIVE_MATH_MAX,
  NATIVE_NUMBER_IS_FINITE,
  NATIVE_NUMBER_IS_SAFE_INTEGER,
  NATIVE_OBJECT_FREEZE,
  NATIVE_OBJECT_HAS_OWN,
  NATIVE_OBJECT_IS_FROZEN,
  NATIVE_OBJECT_KEYS,
  NATIVE_OBJECT_VALUES,
  NATIVE_STRUCTURED_CLONE,
  NATIVE_WEAK_SET_ADD,
  NATIVE_WEAK_SET_HAS,
  nativeArrayEvery,
  nativeArrayFind,
  nativeArrayMap,
  nativeArraySome,
  nativeArraySort,
  nativeArraySortBy,
  nativeBigInt,
  nativeBigIntToString,
  nativeCanonicalJson,
  nativeRegExpTest,
  nativeSha256Text,
} from "./remaining-text-native-intrinsics";

export const REMAINING_TEXT_NATIVE_EXECUTION_PREFLIGHT_ID =
  "site-builder-remaining-text-native-execution-preflight/2026-08-04-v1" as const;

const EVIDENCE_SCHEMA =
  "site-builder-remaining-text-native-fee-card-evidence/v1" as const;
const CARD_SCHEMA = "site-builder-remaining-text-native-fee-card/v3" as const;
const FIXED_SOURCE_COMMIT = "a04f60f5597762d8fde634552b3be6a8a42c8d1d" as const;
const MANIFEST_SHA256 =
  "c10baa88044085f89e32075f4099605c53981dda57ff557a16cf8c3edaa7b87f" as const;
const GATEWAY_ORIGIN = "http://127.0.0.1:3001" as const;
const TOKEN_LOG_PATH = "/api/log/token" as const;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type NativeCurrency = "CNY" | "USD";
type NativeProtocol = Extract<
  ModelCandidateProtocol,
  "openai-responses" | "anthropic-messages"
>;

interface TaskPolicy {
  preparationCommitSha: string;
  cardSha256: string;
  suiteId: string;
  sourceBundleContractId: string;
  sourceBundleSha256: string;
  executionCount: number;
  wireCount: number;
  totals: Readonly<Record<NativeCurrency, string>>;
}

const TASK_POLICIES = Object.freeze({
  "site_builder.copy": Object.freeze({
    preparationCommitSha: "018704462e16a1d1e5db32db411c588c1ada13b6",
    cardSha256:
      "5bb09c7ce5ed5a222344297d46d8016665de00d40dc822392e96d748b3586d4a",
    suiteId: "site-builder.copy-evaluation-suite/2026-08-04-v1",
    sourceBundleContractId: "copy-evaluation-source-bundle/v1",
    sourceBundleSha256:
      "e22fd039f982bb15c1f71ebcda4ae61c9815d80350e5a7e59654f3f11ce74fc8",
    executionCount: 13,
    wireCount: 26,
    totals: Object.freeze({ CNY: "2177043000000", USD: "584347680000" }),
  }),
  "site_builder.assemble": Object.freeze({
    preparationCommitSha: "c8cf8b43b56d3d0c8bfd7532f37c0ced8870ce81",
    cardSha256:
      "598624687a84aa66147fad496f3a3d001f63c4f80178b8c677a6179ea2557731",
    suiteId: "site-builder.assemble-evaluation-suite/2026-08-04-v1",
    sourceBundleContractId: "controlled-assembly-evaluation-source-bundle/v1",
    sourceBundleSha256:
      "5346cd60e38d47650616002ab26ee6d7d109dc1b58520c04e3cb764ff125cb13",
    executionCount: 48,
    wireCount: 96,
    totals: Object.freeze({ CNY: "8346384000000", USD: "9064923840000" }),
  }),
  "site_builder.assembly_fix": Object.freeze({
    preparationCommitSha: "8837eb56ded4b54d5267cc4ae310d3ff078528af",
    cardSha256:
      "03c582377c4637d858895f471de515e49740462d3fbbe68950aa8c8c0632c6bb",
    suiteId: "site-builder.assembly-fix-evaluation-suite/2026-08-04-v1",
    sourceBundleContractId: "controlled-assembly-evaluation-source-bundle/v1",
    sourceBundleSha256:
      "5346cd60e38d47650616002ab26ee6d7d109dc1b58520c04e3cb764ff125cb13",
    executionCount: 48,
    wireCount: 96,
    totals: Object.freeze({ CNY: "8374896000000", USD: "9100848960000" }),
  }),
  "site_builder.qa_summarize": Object.freeze({
    preparationCommitSha: "ffe7beab56801d487299a37c61eb9465661a5a31",
    cardSha256:
      "2c998f1aeff2b3b6588a775606ca5d3fd2017d2c63d5d842340c5b838509700a",
    suiteId: "site-builder.qa-summarize-evaluation-suite/2026-08-04-v1",
    sourceBundleContractId: "quality-narrative-evaluation-source-bundle/v1",
    sourceBundleSha256:
      "b4f3beed23fdabc600b905482b5132fbe4b6810744cb5b837a643db17ec13221",
    executionCount: 12,
    wireCount: 24,
    totals: Object.freeze({ CNY: "490362400000", USD: "501207840000" }),
  }),
  "site_builder.seo_review": Object.freeze({
    preparationCommitSha: "04b3e0adb2d27625bfca8b242051cefda013040c",
    cardSha256:
      "1ed226ade75e66f338d8b3926a2429b59a02126d6e22873811b3076e06d888a0",
    suiteId: "site-builder.seo-review-evaluation-suite/2026-08-04-v1",
    sourceBundleContractId: "quality-narrative-evaluation-source-bundle/v1",
    sourceBundleSha256:
      "b4f3beed23fdabc600b905482b5132fbe4b6810744cb5b837a643db17ec13221",
    executionCount: 12,
    wireCount: 24,
    totals: Object.freeze({ CNY: "503069600000", USD: "515763360000" }),
  }),
} as const satisfies Record<RemainingTextNativeFeeCardTaskId, TaskPolicy>);

export interface RemainingTextNativeDispatch {
  mode: "target";
  alias: string;
  protocol: NativeProtocol;
  currency: NativeCurrency;
}

export interface RemainingTextNativeExecutionPreflightInput {
  taskId: RemainingTextNativeFeeCardTaskId;
  authorization: {
    authorizationId: string;
    ledgerId: string;
    ledgerDirectorySha256: string;
    approvedAt: string;
    approvedMaximumsByCurrency: Record<NativeCurrency, string>;
    approvedDispatchExecutions: number;
    approvedWireCalls: number;
    approvedSettlementRoutesSha256: string;
    preparedExecutionCommitSha: string;
    preparedFixedSourceCommitSha: string;
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
    gatewayOrigin: typeof GATEWAY_ORIGIN;
    purpose: "site_builder_model_evaluation";
    purposeGroup: `remaining-text-eval:${RemainingTextNativeFeeCardTaskId}`;
    quotaMode: "limited";
    scopeExact: true;
    allowedDispatches: RemainingTextNativeDispatch[];
    gatewaySettlement: {
      purposeGroup: `remaining-text-eval:${RemainingTextNativeFeeCardTaskId}`;
      tokenLogPath: typeof TOKEN_LOG_PATH;
      routeSnapshotSha256: string;
      routes: {
        alias: string;
        protocol: NativeProtocol;
        channelId: number;
      }[];
    };
  };
  feeCardEvidence: unknown;
}

export interface RemainingTextNativeExecutionAttestation {
  contractId: typeof REMAINING_TEXT_NATIVE_EXECUTION_PREFLIGHT_ID;
  taskId: RemainingTextNativeFeeCardTaskId;
  fixedSourceCommitSha: typeof FIXED_SOURCE_COMMIT;
  manifestSha256: typeof MANIFEST_SHA256;
  feeCardSha256: string;
  suite: {
    suiteId: string;
    sourceBundleContractId: string;
    sourceBundleSha256: string;
  };
  authorization: RemainingTextNativeExecutionPreflightInput["authorization"];
  credential: RemainingTextNativeExecutionPreflightInput["credential"];
  pricing: {
    authority: "openox_model_marketplace";
    catalogEndpoint: "https://openox.tech/api/public/pricing-catalog";
    capturedAt: string;
    catalogResponseSha256: string;
    noForeignExchangeConversion: true;
    entries: readonly {
      alias: string;
      protocol: NativeProtocol;
      currency: NativeCurrency;
      executionCount: number;
      maximumWireCalls: number;
      inputRateMicrounitsPerMillionTokens: number;
      outputRateMicrounitsPerMillionTokens: number;
    }[];
  };
  limits: {
    maximumsByCurrency: Readonly<Record<NativeCurrency, string>>;
    maxDispatchExecutions: number;
    maxWireCalls: number;
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

const TRUSTED_ATTESTATIONS = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !NATIVE_ARRAY_IS_ARRAY(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = nativeArraySort(NATIVE_OBJECT_KEYS(value));
  const wanted = nativeArraySort(nativeArrayMap(expected, (entry) => entry));
  return (
    actual.length === wanted.length &&
    nativeArrayEvery(actual, (key, index) => key === wanted[index])
  );
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    nativeRegExpTest(ISO_INSTANT, value) &&
    NATIVE_NUMBER_IS_FINITE(NATIVE_DATE_PARSE(value)) &&
    (NATIVE_APPLY(NATIVE_DATE_TO_ISO_STRING, new NATIVE_DATE(value), []) as
      string | undefined) === value
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return NATIVE_NUMBER_IS_SAFE_INTEGER(value) && (value as number) > 0;
}

export function remainingTextNativeSettlementRouteSnapshotSha256(input: {
  purposeGroup: string;
  tokenLogPath: string;
  routes: readonly {
    alias: string;
    protocol: NativeProtocol;
    channelId: number;
  }[];
}): string {
  const routes = nativeArrayMap(input.routes, (route) => ({ ...route }));
  nativeArraySortBy(
    routes,
    (
      left: { alias: string; protocol: NativeProtocol; channelId: number },
      right: { alias: string; protocol: NativeProtocol; channelId: number },
    ) => {
      const leftKey = `${left.alias}:${left.protocol}:${left.channelId}`;
      const rightKey = `${right.alias}:${right.protocol}:${right.channelId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    },
  );
  return nativeSha256Text(
    `site-builder-remaining-text-native-settlement-routes/v1\u0000${nativeCanonicalJson(
      {
        purposeGroup: input.purposeGroup,
        tokenLogPath: input.tokenLogPath,
        routes,
      },
    )}`,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !NATIVE_OBJECT_IS_FROZEN(value)) {
    for (const child of NATIVE_OBJECT_VALUES(value)) deepFreeze(child);
    NATIVE_OBJECT_FREEZE(value);
  }
  return value;
}

function assertAuthorizationAndCredential(
  input: RemainingTextNativeExecutionPreflightInput,
  policy: TaskPolicy,
  entries: RemainingTextNativeExecutionAttestation["pricing"]["entries"],
): void {
  const { authorization, credential, taskId } = input;
  const expectedDispatches = nativeArraySort(
    nativeArrayMap(
      entries,
      ({ alias, protocol, currency }) => `${alias}:${protocol}:${currency}`,
    ),
  );
  const actualDispatches = nativeArraySort(
    nativeArrayMap(
      credential.allowedDispatches,
      ({ alias, protocol, currency }) => `${alias}:${protocol}:${currency}`,
    ),
  );
  const exactDispatches =
    actualDispatches.length === expectedDispatches.length &&
    nativeArrayEvery(
      actualDispatches,
      (entry, index) => entry === expectedDispatches[index],
    ) &&
    nativeArrayEvery(
      credential.allowedDispatches,
      (entry) =>
        exactKeys(entry as unknown as Record<string, unknown>, [
          "mode",
          "alias",
          "protocol",
          "currency",
        ]) && entry.mode === "target",
    );
  const settlementRoutes = credential.gatewaySettlement?.routes;
  const actualRoutes = NATIVE_ARRAY_IS_ARRAY(settlementRoutes)
    ? nativeArraySort(
        nativeArrayMap(
          settlementRoutes,
          ({ alias, protocol }) => `${alias}:${protocol}`,
        ),
      )
    : [];
  const expectedRoutes = nativeArraySort(
    nativeArrayMap(entries, ({ alias, protocol }) => `${alias}:${protocol}`),
  );
  const exactSettlement =
    isRecord(credential.gatewaySettlement) &&
    exactKeys(
      credential.gatewaySettlement as unknown as Record<string, unknown>,
      ["purposeGroup", "tokenLogPath", "routeSnapshotSha256", "routes"],
    ) &&
    credential.gatewaySettlement.purposeGroup ===
      `remaining-text-eval:${taskId}` &&
    credential.gatewaySettlement.tokenLogPath === TOKEN_LOG_PATH &&
    actualRoutes.length === expectedRoutes.length &&
    nativeRegExpTest(
      SHA256,
      credential.gatewaySettlement.routeSnapshotSha256,
    ) &&
    credential.gatewaySettlement.routeSnapshotSha256 ===
      remainingTextNativeSettlementRouteSnapshotSha256({
        purposeGroup: credential.gatewaySettlement.purposeGroup,
        tokenLogPath: credential.gatewaySettlement.tokenLogPath,
        routes: credential.gatewaySettlement.routes,
      }) &&
    nativeArrayEvery(
      actualRoutes,
      (entry, index) => entry === expectedRoutes[index],
    ) &&
    nativeArrayEvery(
      settlementRoutes,
      (route) =>
        exactKeys(route as unknown as Record<string, unknown>, [
          "alias",
          "protocol",
          "channelId",
        ]) && positiveSafeInteger(route.channelId),
    );
  if (
    !nativeRegExpTest(IDENTIFIER, authorization.authorizationId) ||
    !nativeRegExpTest(IDENTIFIER, authorization.ledgerId) ||
    !nativeRegExpTest(SHA256, authorization.ledgerDirectorySha256) ||
    !canonicalInstant(authorization.approvedAt) ||
    !nativeRegExpTest(SHA1, authorization.preparedExecutionCommitSha) ||
    authorization.preparedFixedSourceCommitSha !== FIXED_SOURCE_COMMIT ||
    authorization.preparedManifestSha256 !== MANIFEST_SHA256 ||
    authorization.preparedFeeCardSha256 !== policy.cardSha256 ||
    authorization.preparedSuiteId !== policy.suiteId ||
    authorization.preparedSourceBundleContractId !==
      policy.sourceBundleContractId ||
    authorization.preparedSourceBundleSha256 !== policy.sourceBundleSha256 ||
    authorization.approvedMaximumsByCurrency.CNY !== policy.totals.CNY ||
    authorization.approvedMaximumsByCurrency.USD !== policy.totals.USD ||
    authorization.approvedDispatchExecutions !== policy.executionCount ||
    authorization.approvedWireCalls !== policy.wireCount ||
    !nativeRegExpTest(SHA256, authorization.approvedSettlementRoutesSha256) ||
    authorization.approvedSettlementRoutesSha256 !==
      credential.gatewaySettlement.routeSnapshotSha256 ||
    !nativeRegExpTest(IDENTIFIER, credential.attestationId) ||
    !canonicalInstant(credential.observedAt) ||
    !nativeRegExpTest(SHA256, credential.snapshotSha256) ||
    !nativeRegExpTest(SHA256, credential.bearerTokenSha256) ||
    credential.gatewayOrigin !== GATEWAY_ORIGIN ||
    credential.purpose !== "site_builder_model_evaluation" ||
    credential.purposeGroup !== `remaining-text-eval:${taskId}` ||
    credential.quotaMode !== "limited" ||
    credential.scopeExact !== true ||
    !exactDispatches ||
    !exactSettlement
  ) {
    throw new Error("remaining text native execution preflight is invalid");
  }
}

function assertFeeCardEvidence(
  taskId: RemainingTextNativeFeeCardTaskId,
  value: unknown,
): {
  feeCardSha256: string;
  suite: RemainingTextNativeExecutionAttestation["suite"];
  pricing: RemainingTextNativeExecutionAttestation["pricing"];
  limits: RemainingTextNativeExecutionAttestation["limits"];
} {
  const policy = TASK_POLICIES[taskId];
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "preparationCommitSha",
      "modelWireCalls",
      "actualModelCost",
      "dispatchAuthorization",
      "card",
    ]) ||
    value.schemaVersion !== EVIDENCE_SCHEMA ||
    value.preparationCommitSha !== policy.preparationCommitSha ||
    value.modelWireCalls !== 0 ||
    value.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    !isRecord(value.actualModelCost) ||
    value.actualModelCost.CNY !== "0" ||
    value.actualModelCost.USD !== "0" ||
    !isRecord(value.card)
  ) {
    throw new Error("remaining text fee-card evidence is invalid");
  }
  const card = value.card;
  const cardSha256 = card.cardSha256;
  const { cardSha256: _ignored, ...unsignedCard } = card;
  if (
    cardSha256 !== policy.cardSha256 ||
    nativeSha256Text(nativeCanonicalJson(unsignedCard)) !== policy.cardSha256 ||
    card.schemaVersion !== CARD_SCHEMA ||
    card.feeCardId !==
      `site-builder-remaining-text-native-fee-card/2026-08-04-v3/${taskId}` ||
    card.status !== "READY_FOR_CREDENTIAL_ATTESTATION" ||
    card.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    card.taskId !== taskId ||
    card.fixedSourceCommitSha !== FIXED_SOURCE_COMMIT ||
    card.manifestSha256 !== MANIFEST_SHA256 ||
    card.noForeignExchangeConversion !== true ||
    card.expectedCost !== "not_known_before_usage" ||
    !isRecord(card.suite) ||
    card.suite.suiteId !== policy.suiteId ||
    card.suite.sourceBundleContractId !== policy.sourceBundleContractId ||
    card.suite.sourceBundleSha256 !== policy.sourceBundleSha256 ||
    !isRecord(card.pricing) ||
    card.pricing.authority !== "openox_model_marketplace" ||
    card.pricing.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    !canonicalInstant(card.pricing.capturedAt) ||
    typeof card.pricing.catalogResponseSha256 !== "string" ||
    !nativeRegExpTest(SHA256, card.pricing.catalogResponseSha256) ||
    !isRecord(card.tokenEnvelope) ||
    !positiveSafeInteger(card.tokenEnvelope.initialInputTokens) ||
    !positiveSafeInteger(card.tokenEnvelope.repairInputTokens) ||
    !positiveSafeInteger(card.tokenEnvelope.outputTokensPerWireCall) ||
    !NATIVE_ARRAY_IS_ARRAY(card.entries) ||
    card.entries.length < 2 ||
    !isRecord(card.totalsByCurrency) ||
    !isRecord(card.totalsByCurrency.CNY) ||
    !isRecord(card.totalsByCurrency.USD) ||
    card.totalsByCurrency.CNY.nativePicoUnits !== policy.totals.CNY ||
    card.totalsByCurrency.USD.nativePicoUnits !== policy.totals.USD
  ) {
    throw new Error("remaining text fee-card evidence is invalid");
  }
  const entries = nativeArrayMap(
    card.entries,
    (
      entry,
    ): RemainingTextNativeExecutionAttestation["pricing"]["entries"][number] => {
      if (
        !isRecord(entry) ||
        typeof entry.alias !== "string" ||
        (entry.protocol !== "openai-responses" &&
          entry.protocol !== "anthropic-messages") ||
        (entry.currency !== "CNY" && entry.currency !== "USD") ||
        !positiveSafeInteger(entry.executionCount) ||
        !positiveSafeInteger(entry.maximumWireCalls) ||
        entry.maximumWireCalls !== entry.executionCount * 2 ||
        !positiveSafeInteger(
          entry.effectiveInputRateMicrounitsPerMillionTokens,
        ) ||
        !positiveSafeInteger(
          entry.effectiveOutputRateMicrounitsPerMillionTokens,
        ) ||
        entry.exceedsPerWireCostCap !== false
      ) {
        throw new Error("remaining text fee-card evidence is invalid");
      }
      return {
        alias: entry.alias,
        protocol: entry.protocol,
        currency: entry.currency,
        executionCount: entry.executionCount,
        maximumWireCalls: entry.maximumWireCalls,
        inputRateMicrounitsPerMillionTokens:
          entry.effectiveInputRateMicrounitsPerMillionTokens,
        outputRateMicrounitsPerMillionTokens:
          entry.effectiveOutputRateMicrounitsPerMillionTokens,
      };
    },
  );
  let executionCount = 0;
  let wireCount = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) throw new Error("remaining text fee-card evidence is invalid");
    executionCount += entry.executionCount;
    wireCount += entry.maximumWireCalls;
  }
  if (
    executionCount !== policy.executionCount ||
    wireCount !== policy.wireCount
  ) {
    throw new Error("remaining text fee-card evidence is invalid");
  }
  return {
    feeCardSha256: policy.cardSha256,
    suite: {
      suiteId: policy.suiteId,
      sourceBundleContractId: policy.sourceBundleContractId,
      sourceBundleSha256: policy.sourceBundleSha256,
    },
    pricing: {
      authority: "openox_model_marketplace",
      catalogEndpoint: "https://openox.tech/api/public/pricing-catalog",
      capturedAt: card.pricing.capturedAt,
      catalogResponseSha256: card.pricing.catalogResponseSha256,
      noForeignExchangeConversion: true,
      entries,
    },
    limits: {
      maximumsByCurrency: policy.totals,
      maxDispatchExecutions: policy.executionCount,
      maxWireCalls: policy.wireCount,
      maxInputTokensInitialWire: card.tokenEnvelope.initialInputTokens,
      maxInputTokensRepairWire: card.tokenEnvelope.repairInputTokens,
      maxOutputTokensPerWire: card.tokenEnvelope.outputTokensPerWireCall,
    },
  };
}

export function createRemainingTextNativeExecutionAttestation(
  input: RemainingTextNativeExecutionPreflightInput,
): RemainingTextNativeExecutionAttestation {
  if (
    !input ||
    !NATIVE_APPLY(NATIVE_OBJECT_HAS_OWN, Object, [TASK_POLICIES, input.taskId])
  ) {
    throw new Error("remaining text native execution preflight is invalid");
  }
  const validated = assertFeeCardEvidence(input.taskId, input.feeCardEvidence);
  assertAuthorizationAndCredential(
    input,
    TASK_POLICIES[input.taskId],
    validated.pricing.entries,
  );
  const attestation = deepFreeze(
    NATIVE_STRUCTURED_CLONE({
      contractId: REMAINING_TEXT_NATIVE_EXECUTION_PREFLIGHT_ID,
      taskId: input.taskId,
      fixedSourceCommitSha: FIXED_SOURCE_COMMIT,
      manifestSha256: MANIFEST_SHA256,
      feeCardSha256: validated.feeCardSha256,
      suite: validated.suite,
      authorization: input.authorization,
      credential: input.credential,
      pricing: validated.pricing,
      limits: validated.limits,
      settlement: {
        requestIdentityField: "executionId" as const,
        requireVerifiedRequestSettlement: true as const,
        unknownSettlementPolicy: "freeze_campaign" as const,
      },
    }),
  );
  NATIVE_APPLY(NATIVE_WEAK_SET_ADD, TRUSTED_ATTESTATIONS, [attestation]);
  return attestation;
}

export function isTrustedRemainingTextNativeExecutionAttestation(
  value: unknown,
): value is RemainingTextNativeExecutionAttestation {
  return (
    !!value &&
    typeof value === "object" &&
    NATIVE_OBJECT_IS_FROZEN(value) &&
    (NATIVE_APPLY(NATIVE_WEAK_SET_HAS, TRUSTED_ATTESTATIONS, [
      value,
    ]) as boolean)
  );
}

function trustedAttestation(
  value: unknown,
): RemainingTextNativeExecutionAttestation {
  if (!isTrustedRemainingTextNativeExecutionAttestation(value)) {
    throw new Error("remaining text native dispatch is not authorized");
  }
  return value;
}

function pricingEntry(
  attestation: RemainingTextNativeExecutionAttestation,
  alias: string,
  protocol: NativeProtocol,
) {
  return nativeArrayFind(
    attestation.pricing.entries,
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
}

export function remainingTextNativeSettlementRoute(
  value: unknown,
  input: { alias: string; protocol: NativeProtocol },
): Readonly<{ alias: string; protocol: NativeProtocol; channelId: number }> {
  const attestation = trustedAttestation(value);
  const route = nativeArrayFind(
    attestation.credential.gatewaySettlement.routes,
    (entry) => entry.alias === input.alias && entry.protocol === input.protocol,
  );
  if (!route) {
    throw new Error("remaining text native settlement route is not attested");
  }
  return route;
}

export function assertRemainingTextNativeDispatch(
  value: unknown,
  input: {
    alias: string;
    protocol: NativeProtocol;
    wireAttempt: "initial" | "repair";
    maxOutputTokens: number;
  },
): void {
  const attestation = trustedAttestation(value);
  const entry = pricingEntry(attestation, input.alias, input.protocol);
  const allowed = nativeArraySome(
    attestation.credential.allowedDispatches,
    (dispatch) =>
      dispatch.alias === input.alias && dispatch.protocol === input.protocol,
  );
  let routeBound: boolean;
  try {
    remainingTextNativeSettlementRoute(attestation, input);
    routeBound = true;
  } catch {
    routeBound = false;
  }
  if (!entry || !allowed || !routeBound) {
    throw new Error("remaining text native dispatch is not authorized");
  }
  if (
    (input.wireAttempt !== "initial" && input.wireAttempt !== "repair") ||
    !positiveSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens > attestation.limits.maxOutputTokensPerWire
  ) {
    throw new Error(
      "remaining text native dispatch exceeds the attested envelope",
    );
  }
}

export function remainingTextNativeMaximumPicoUnitsForWire(
  value: unknown,
  input: {
    alias: string;
    protocol: NativeProtocol;
    wireAttempt: "initial" | "repair";
  },
): { currency: NativeCurrency; nativePicoUnits: string } {
  const attestation = trustedAttestation(value);
  assertRemainingTextNativeDispatch(attestation, {
    ...input,
    maxOutputTokens: attestation.limits.maxOutputTokensPerWire,
  });
  const entry = pricingEntry(attestation, input.alias, input.protocol)!;
  const inputTokens =
    input.wireAttempt === "initial"
      ? attestation.limits.maxInputTokensInitialWire
      : attestation.limits.maxInputTokensRepairWire;
  const nativePicoUnits =
    nativeBigInt(inputTokens) *
      nativeBigInt(entry.inputRateMicrounitsPerMillionTokens) +
    nativeBigInt(attestation.limits.maxOutputTokensPerWire) *
      nativeBigInt(entry.outputRateMicrounitsPerMillionTokens);
  return NATIVE_OBJECT_FREEZE({
    currency: entry.currency,
    nativePicoUnits: nativeBigIntToString(nativePicoUnits),
  });
}

export function remainingTextNativePicoUnitsForUsage(
  value: unknown,
  input: {
    executionId: string;
    alias: string;
    protocol: NativeProtocol;
    wireAttempt: "initial" | "repair";
    inputTokens: number;
    outputTokens: number;
  },
): {
  state: "settled";
  executionId: string;
  currency: NativeCurrency;
  nativePicoUnits: string;
  basis: `frozen_openox_native_pricing@${string}`;
} {
  const attestation = trustedAttestation(value);
  assertRemainingTextNativeDispatch(attestation, {
    alias: input.alias,
    protocol: input.protocol,
    wireAttempt: input.wireAttempt,
    maxOutputTokens: NATIVE_MATH_MAX(input.outputTokens, 1),
  });
  const maxInputTokens =
    input.wireAttempt === "initial"
      ? attestation.limits.maxInputTokensInitialWire
      : attestation.limits.maxInputTokensRepairWire;
  if (
    !nativeRegExpTest(IDENTIFIER, input.executionId) ||
    !NATIVE_NUMBER_IS_SAFE_INTEGER(input.inputTokens) ||
    input.inputTokens < 0 ||
    input.inputTokens > maxInputTokens ||
    !NATIVE_NUMBER_IS_SAFE_INTEGER(input.outputTokens) ||
    input.outputTokens < 0 ||
    input.outputTokens > attestation.limits.maxOutputTokensPerWire
  ) {
    throw new Error(
      "remaining text native usage exceeds the attested envelope",
    );
  }
  const entry = pricingEntry(attestation, input.alias, input.protocol)!;
  const nativePicoUnits =
    nativeBigInt(input.inputTokens) *
      nativeBigInt(entry.inputRateMicrounitsPerMillionTokens) +
    nativeBigInt(input.outputTokens) *
      nativeBigInt(entry.outputRateMicrounitsPerMillionTokens);
  return NATIVE_OBJECT_FREEZE({
    state: "settled" as const,
    executionId: input.executionId,
    currency: entry.currency,
    nativePicoUnits: nativeBigIntToString(nativePicoUnits),
    basis:
      `frozen_openox_native_pricing@${attestation.pricing.capturedAt}` as const,
  });
}
