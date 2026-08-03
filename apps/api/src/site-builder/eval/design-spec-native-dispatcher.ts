import {
  DesignSpecNativeCurrencyBudgetGuard,
  type DesignSpecNativeCurrency,
} from "./design-spec-native-currency-budget";
import {
  DESIGN_SPEC_NATIVE_FEE_CARD_ID,
  DESIGN_SPEC_NATIVE_FEE_CARD_SCHEMA_VERSION,
  DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES,
  type DesignSpecNativeFeeCard,
  type DesignSpecNativeTargetProtocol,
} from "./design-spec-native-fee-card";
import { sha256CanonicalJson } from "./eval-provenance";

const PICO_UNITS = /^(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REQUIRED_NATIVE_FEE_CARD_SHA256 =
  "de3f778561ce1cc630629b8674ca7932b991a9ded61fa02a3220aa13578dd869";
const NATIVE_MAP_GET = Map.prototype.get;
const NATIVE_MAP_SET = Map.prototype.set;
const NATIVE_MAP_HAS = Map.prototype.has;
const NATIVE_MAP_DELETE = Map.prototype.delete;
const NATIVE_SET_HAS = Set.prototype.has;
const NATIVE_SET_ADD = Set.prototype.add;
const NATIVE_APPLY = Reflect.apply;

type NativeFeeCardEntry = DesignSpecNativeFeeCard["entries"][number];
type NativeWireAttempt = "initial" | "repair";

function nativeMapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  return NATIVE_APPLY(NATIVE_MAP_GET, map, [key]) as V | undefined;
}

function nativeMapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  NATIVE_APPLY(NATIVE_MAP_SET, map, [key, value]);
}

function nativeMapHas<K, V>(map: Map<K, V>, key: K): boolean {
  return NATIVE_APPLY(NATIVE_MAP_HAS, map, [key]) as boolean;
}

function nativeMapDelete<K, V>(map: Map<K, V>, key: K): void {
  NATIVE_APPLY(NATIVE_MAP_DELETE, map, [key]);
}

function nativeSetHas<T>(set: Set<T>, value: T): boolean {
  return NATIVE_APPLY(NATIVE_SET_HAS, set, [value]) as boolean;
}

function nativeSetAdd<T>(set: Set<T>, value: T): void {
  NATIVE_APPLY(NATIVE_SET_ADD, set, [value]);
}

function canonicalPicoUnits(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !PICO_UNITS.test(value)) {
    throw new Error(
      `${label} must be a canonical non-negative pico-unit string`,
    );
  }
  return BigInt(value);
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function assertExactNativeFeeCardDispatchSet(
  feeCard: Pick<DesignSpecNativeFeeCard, "entries">,
): void {
  const expected = DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES.map((entry) =>
    [entry.alias, entry.protocol, entry.currency, entry.executionCount].join(
      ":",
    ),
  ).sort();
  const actual = feeCard.entries
    .map((entry) =>
      [entry.alias, entry.protocol, entry.currency, entry.executionCount].join(
        ":",
      ),
    )
    .sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("design_spec native fee card dispatch set drifted");
  }
}

function assertFeeCardIntegrity(feeCard: DesignSpecNativeFeeCard): void {
  const { cardSha256, ...unsignedCard } = feeCard;
  if (
    feeCard.schemaVersion !== DESIGN_SPEC_NATIVE_FEE_CARD_SCHEMA_VERSION ||
    feeCard.feeCardId !== DESIGN_SPEC_NATIVE_FEE_CARD_ID ||
    feeCard.status !== "READY_FOR_CREDENTIAL_ATTESTATION" ||
    feeCard.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    feeCard.noForeignExchangeConversion !== true ||
    feeCard.fixedSourceCommitSha !==
      "e493ba1d09fe37feea927f70d12f17aadadc5c6a" ||
    feeCard.manifestSha256 !==
      "83dedcb2057d4e375114c42b5c03becbc9b057b1bfa1f3fc511bfec600827e72" ||
    feeCard.suite.suiteId !==
      "site-builder.design-spec-evaluation-suite/2026-08-01-v14" ||
    feeCard.suite.sourceBundleContractId !==
      "design-spec-evaluation-source-bundle/v14" ||
    feeCard.suite.sourceBundleSha256 !==
      "3e95d15837d7ad6ea234a67211b3a7564f92e9c3826911024b767de222df9528" ||
    feeCard.pricing.authority !== "openox_model_marketplace" ||
    feeCard.pricing.catalogEndpoint !==
      "https://openox.tech/api/public/pricing-catalog" ||
    !canonicalInstant(feeCard.pricing.capturedAt) ||
    !SHA256.test(feeCard.pricing.catalogResponseSha256) ||
    feeCard.tokenEnvelope.initialInputTokens !== 6438 ||
    feeCard.tokenEnvelope.repairInputTokens !== 10745 ||
    feeCard.tokenEnvelope.outputTokensPerWireCall !== 4000 ||
    feeCard.expectedCost !== "not_known_before_usage" ||
    feeCard.mechanicalPolicyCeiling.amountCents !== 2920 ||
    feeCard.mechanicalPolicyCeiling.meaning !==
      "mechanical_only_not_a_native_currency_budget" ||
    !PICO_UNITS.test(feeCard.totalsByCurrency.CNY.nativePicoUnits) ||
    !PICO_UNITS.test(feeCard.totalsByCurrency.USD.nativePicoUnits) ||
    !SHA256.test(cardSha256) ||
    cardSha256 !== REQUIRED_NATIVE_FEE_CARD_SHA256 ||
    cardSha256 !== sha256CanonicalJson(unsignedCard)
  ) {
    throw new Error("design_spec native fee card integrity is invalid");
  }
  assertExactNativeFeeCardDispatchSet(feeCard);
  const totals = feeCard.entries.reduce(
    (result, entry) => {
      const maximum = canonicalPicoUnits(
        entry.maximumCost.nativePicoUnits,
        "native fee card maximum",
      );
      return {
        ...result,
        [entry.currency]: result[entry.currency] + maximum,
      };
    },
    { CNY: 0n, USD: 0n } as Record<DesignSpecNativeCurrency, bigint>,
  );
  for (const entry of feeCard.entries) {
    const admitted = DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES.find(
      (candidate) =>
        candidate.alias === entry.alias &&
        candidate.protocol === entry.protocol,
    );
    if (
      !admitted ||
      entry.groupName !== admitted.groupName ||
      entry.currency !== admitted.currency ||
      entry.executionCount !== admitted.executionCount ||
      entry.maximumWireCalls !== admitted.executionCount * 2 ||
      !SHA256.test(entry.pricingVersion)
    ) {
      throw new Error("design_spec native fee card provenance drifted");
    }
  }
  if (
    totals.CNY !== BigInt(feeCard.totalsByCurrency.CNY.nativePicoUnits) ||
    totals.USD !== BigInt(feeCard.totalsByCurrency.USD.nativePicoUnits)
  ) {
    throw new Error("design_spec native fee card totals drifted");
  }
}

function nativeFeeCardEntry(
  feeCard: Pick<DesignSpecNativeFeeCard, "entries">,
  alias: string,
  protocol: DesignSpecNativeTargetProtocol,
): NativeFeeCardEntry {
  assertExactNativeFeeCardDispatchSet(feeCard);
  const admitted = DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES.find(
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
  const matches = feeCard.entries.filter(
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
  if (!admitted || matches.length !== 1) {
    throw new Error(
      "design_spec dispatch is not admitted by the native fee card",
    );
  }
  const entry = matches[0]!;
  if (
    entry.currency !== admitted.currency ||
    entry.executionCount !== admitted.executionCount ||
    !Number.isSafeInteger(entry.effectiveInputRateMicrounitsPerMillionTokens) ||
    entry.effectiveInputRateMicrounitsPerMillionTokens <= 0 ||
    !Number.isSafeInteger(
      entry.effectiveOutputRateMicrounitsPerMillionTokens,
    ) ||
    entry.effectiveOutputRateMicrounitsPerMillionTokens <= 0
  ) {
    throw new Error("design_spec native fee card entry drifted");
  }
  const maximumPerExecution =
    canonicalPicoUnits(
      entry.initialCallMaximum.nativePicoUnits,
      "native fee card initial maximum",
    ) +
    canonicalPicoUnits(
      entry.repairCallMaximum.nativePicoUnits,
      "native fee card repair maximum",
    );
  if (
    maximumPerExecution * BigInt(entry.executionCount) !==
    canonicalPicoUnits(
      entry.maximumCost.nativePicoUnits,
      "native fee card maximum",
    )
  ) {
    throw new Error("design_spec native fee card maximum is inconsistent");
  }
  return entry;
}

function nativeWireAttemptMaximum(
  entry: NativeFeeCardEntry,
  wireAttempt: NativeWireAttempt,
): bigint {
  switch (wireAttempt) {
    case "initial":
      return canonicalPicoUnits(
        entry.initialCallMaximum.nativePicoUnits,
        "native fee card initial maximum",
      );
    case "repair":
      return canonicalPicoUnits(
        entry.repairCallMaximum.nativePicoUnits,
        "native fee card repair maximum",
      );
  }
}

function nativeWireReservationId(
  executionId: unknown,
  wireAttempt: unknown,
): string {
  if (typeof executionId !== "string") {
    throw new Error("native reservation execution id is invalid");
  }
  if (wireAttempt !== "initial" && wireAttempt !== "repair") {
    throw new Error("native wire attempt is invalid");
  }
  return `${executionId}:${wireAttempt}`;
}

function nativeDispatchKey(
  alias: string,
  protocol: DesignSpecNativeTargetProtocol,
): string {
  return `${alias}:${protocol}`;
}

/**
 * Computes an observed physical wire cost from the fee card's frozen OpenOx
 * native-unit rates. CNY and USD remain distinct; no NewAPI amount or FX
 * conversion participates in this calculation.
 */
export function nativePicoUnitsForUsage(
  feeCard: DesignSpecNativeFeeCard,
  input: {
    alias: string;
    protocol: DesignSpecNativeTargetProtocol;
    inputTokens: number;
    outputTokens: number;
  },
): Readonly<{
  currency: DesignSpecNativeCurrency;
  nativePicoUnits: string;
}> {
  assertFeeCardIntegrity(feeCard);
  return nativePicoUnitsForEntry(feeCard, input);
}

function nativePicoUnitsForEntry(
  feeCard: Pick<DesignSpecNativeFeeCard, "entries">,
  input: {
    alias: string;
    protocol: DesignSpecNativeTargetProtocol;
    inputTokens: number;
    outputTokens: number;
  },
): Readonly<{
  currency: DesignSpecNativeCurrency;
  nativePicoUnits: string;
}> {
  if (
    !Number.isSafeInteger(input.inputTokens) ||
    input.inputTokens < 0 ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens < 0
  ) {
    throw new Error(
      "native settlement usage must contain non-negative safe integers",
    );
  }
  const entry = nativeFeeCardEntry(feeCard, input.alias, input.protocol);
  const nativePicoUnits =
    BigInt(input.inputTokens) *
      BigInt(entry.effectiveInputRateMicrounitsPerMillionTokens) +
    BigInt(input.outputTokens) *
      BigInt(entry.effectiveOutputRateMicrounitsPerMillionTokens);
  return Object.freeze({
    currency: entry.currency,
    nativePicoUnits: nativePicoUnits.toString(),
  });
}

/**
 * Local native-currency reservation and settlement accounting for a future
 * dispatcher. It neither authorizes credentials nor sends a model request.
 */
export class DesignSpecNativeSettlementCampaign {
  readonly #feeCard: Pick<DesignSpecNativeFeeCard, "entries" | "tokenEnvelope">;
  readonly #budget: DesignSpecNativeCurrencyBudgetGuard;
  readonly #reservations = new Map<
    string,
    Readonly<{ alias: string; protocol: DesignSpecNativeTargetProtocol }>
  >();
  readonly #completedWireReservations = new Set<string>();
  readonly #executionDispatches = new Map<
    string,
    Readonly<{ alias: string; protocol: DesignSpecNativeTargetProtocol }>
  >();
  readonly #executionCountsByDispatch = new Map<string, number>();

  constructor(input: { feeCard: DesignSpecNativeFeeCard }) {
    if (!input?.feeCard || !Array.isArray(input.feeCard.entries)) {
      throw new Error("design_spec native fee card is required");
    }
    assertFeeCardIntegrity(input.feeCard);
    this.#feeCard = Object.freeze({
      entries: Object.freeze(
        input.feeCard.entries.map((entry) =>
          Object.freeze({
            ...entry,
            initialCallMaximum: Object.freeze({ ...entry.initialCallMaximum }),
            repairCallMaximum: Object.freeze({ ...entry.repairCallMaximum }),
            maximumCost: Object.freeze({ ...entry.maximumCost }),
          }),
        ),
      ),
      tokenEnvelope: Object.freeze({ ...input.feeCard.tokenEnvelope }),
    });
    this.#budget = new DesignSpecNativeCurrencyBudgetGuard({
      CNY: input.feeCard.totalsByCurrency.CNY.nativePicoUnits,
      USD: input.feeCard.totalsByCurrency.USD.nativePicoUnits,
    });
  }

  reserve(input: {
    executionId: string;
    wireAttempt: NativeWireAttempt;
    alias: string;
    protocol: DesignSpecNativeTargetProtocol;
  }): void {
    const wireReservationId = nativeWireReservationId(
      input.executionId,
      input.wireAttempt,
    );
    const entry = nativeFeeCardEntry(
      this.#feeCard,
      input.alias,
      input.protocol,
    );
    const dispatch = Object.freeze({
      alias: input.alias,
      protocol: input.protocol,
    });
    const priorDispatch = nativeMapGet(
      this.#executionDispatches,
      input.executionId,
    );
    if (
      priorDispatch &&
      (priorDispatch.alias !== dispatch.alias ||
        priorDispatch.protocol !== dispatch.protocol)
    ) {
      throw new Error("native repair dispatch does not match its initial wire");
    }
    if (input.wireAttempt === "repair") {
      const initialReservationId = nativeWireReservationId(
        input.executionId,
        "initial",
      );
      if (
        !nativeSetHas(this.#completedWireReservations, initialReservationId)
      ) {
        throw new Error("native repair requires a settled initial wire");
      }
    }
    if (
      nativeMapHas(this.#reservations, wireReservationId) ||
      nativeSetHas(this.#completedWireReservations, wireReservationId)
    ) {
      throw new Error("native wire attempt is already reserved or settled");
    }
    const maximumPicoUnits = nativeWireAttemptMaximum(entry, input.wireAttempt);
    const dispatchKey = nativeDispatchKey(input.alias, input.protocol);
    const executionCount = nativeMapGet(
      this.#executionCountsByDispatch,
      dispatchKey,
    );
    if (
      input.wireAttempt === "initial" &&
      (executionCount ?? 0) >= entry.executionCount
    ) {
      throw new Error("native fee card execution count is exhausted");
    }
    this.#budget.reserve({
      executionId: wireReservationId,
      alias: input.alias,
      protocol: input.protocol,
      maximumPicoUnits: maximumPicoUnits.toString(),
    });
    nativeMapSet(this.#reservations, wireReservationId, dispatch);
    nativeMapSet(this.#executionDispatches, input.executionId, dispatch);
    if (input.wireAttempt === "initial") {
      nativeMapSet(
        this.#executionCountsByDispatch,
        dispatchKey,
        (executionCount ?? 0) + 1,
      );
    }
  }

  settleObservedUsage(input: {
    executionId: string;
    wireAttempt: NativeWireAttempt;
    inputTokens: number;
    outputTokens: number;
  }): Readonly<{
    currency: DesignSpecNativeCurrency;
    nativePicoUnits: string;
  }> {
    const wireReservationId = nativeWireReservationId(
      input.executionId,
      input.wireAttempt,
    );
    const reservation = nativeMapGet(this.#reservations, wireReservationId);
    if (!reservation) {
      throw new Error("native settlement has no reserved dispatch identity");
    }
    try {
      const inputTokenCap =
        input.wireAttempt === "initial"
          ? this.#feeCard.tokenEnvelope.initialInputTokens
          : this.#feeCard.tokenEnvelope.repairInputTokens;
      if (
        input.inputTokens > inputTokenCap ||
        input.outputTokens > this.#feeCard.tokenEnvelope.outputTokensPerWireCall
      ) {
        throw new Error(
          "native settlement usage exceeds the frozen token envelope",
        );
      }
      const observed = nativePicoUnitsForEntry(this.#feeCard, {
        ...reservation,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      });
      this.#budget.settle({
        executionId: wireReservationId,
        currency: observed.currency,
        actualPicoUnits: observed.nativePicoUnits,
      });
      nativeMapDelete(this.#reservations, wireReservationId);
      nativeSetAdd(this.#completedWireReservations, wireReservationId);
      return observed;
    } catch (error) {
      if (!this.#budget.snapshot().frozen) {
        try {
          this.#budget.freezeUnknownSettlement(wireReservationId);
        } catch {
          // Preserve the settlement failure that already froze or rejected.
        }
      }
      throw error;
    }
  }

  freezeUnknownSettlement(input: {
    executionId: string;
    wireAttempt: NativeWireAttempt;
  }): void {
    this.#budget.freezeUnknownSettlement(
      nativeWireReservationId(input.executionId, input.wireAttempt),
    );
  }

  snapshot() {
    return this.#budget.snapshot();
  }
}
