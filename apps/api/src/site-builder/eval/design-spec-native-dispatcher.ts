import {
  DesignSpecNativeCurrencyBudgetGuard,
  type DesignSpecNativeCurrency,
} from "./design-spec-native-currency-budget";
import {
  DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES,
  type DesignSpecNativeFeeCard,
  type DesignSpecNativeTargetProtocol,
} from "./design-spec-native-fee-card";

const PICO_UNITS = /^(?:0|[1-9][0-9]*)$/;

type NativeFeeCardEntry = DesignSpecNativeFeeCard["entries"][number];

function canonicalPicoUnits(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !PICO_UNITS.test(value)) {
    throw new Error(`${label} must be a canonical non-negative pico-unit string`);
  }
  return BigInt(value);
}

function assertExactNativeFeeCardDispatchSet(
  feeCard: Pick<DesignSpecNativeFeeCard, "entries">,
): void {
  const expected = DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES.map((entry) =>
    [entry.alias, entry.protocol, entry.currency, entry.executionCount].join(":"),
  ).sort();
  const actual = feeCard.entries.map((entry) =>
    [entry.alias, entry.protocol, entry.currency, entry.executionCount].join(":"),
  ).sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("design_spec native fee card dispatch set drifted");
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
    throw new Error("design_spec dispatch is not admitted by the native fee card");
  }
  const entry = matches[0]!;
  if (
    entry.currency !== admitted.currency ||
    entry.executionCount !== admitted.executionCount ||
    !Number.isSafeInteger(entry.effectiveInputRateMicrounitsPerMillionTokens) ||
    entry.effectiveInputRateMicrounitsPerMillionTokens <= 0 ||
    !Number.isSafeInteger(entry.effectiveOutputRateMicrounitsPerMillionTokens) ||
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
    canonicalPicoUnits(entry.maximumCost.nativePicoUnits, "native fee card maximum")
  ) {
    throw new Error("design_spec native fee card maximum is inconsistent");
  }
  return entry;
}

/**
 * Computes an observed physical wire cost from the fee card's frozen OpenOx
 * native-unit rates. CNY and USD remain distinct; no NewAPI amount or FX
 * conversion participates in this calculation.
 */
export function nativePicoUnitsForUsage(
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
    throw new Error("native settlement usage must contain non-negative safe integers");
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
 * Native-currency execution gate for the real dispatcher. The durable
 * authorization ledger is composed by the runner; this object owns the exact
 * fee-card reservation and settlement invariant for each execution.
 */
export class DesignSpecNativeSettlementCampaign {
  readonly #feeCard: Pick<DesignSpecNativeFeeCard, "entries">;
  readonly #budget: DesignSpecNativeCurrencyBudgetGuard;

  constructor(input: {
    feeCard: Pick<DesignSpecNativeFeeCard, "entries">;
    caps: Readonly<Record<DesignSpecNativeCurrency, string>>;
  }) {
    if (!input?.feeCard || !Array.isArray(input.feeCard.entries)) {
      throw new Error("design_spec native fee card is required");
    }
    this.#feeCard = input.feeCard;
    this.#budget = new DesignSpecNativeCurrencyBudgetGuard(input.caps);
  }

  reserve(input: {
    executionId: string;
    alias: string;
    protocol: DesignSpecNativeTargetProtocol;
  }): void {
    const entry = nativeFeeCardEntry(
      this.#feeCard,
      input.alias,
      input.protocol,
    );
    const maximumPicoUnits =
      canonicalPicoUnits(
        entry.initialCallMaximum.nativePicoUnits,
        "native fee card initial maximum",
      ) +
      canonicalPicoUnits(
        entry.repairCallMaximum.nativePicoUnits,
        "native fee card repair maximum",
      );
    this.#budget.reserve({
      ...input,
      maximumPicoUnits: maximumPicoUnits.toString(),
    });
  }

  settle(input: {
    executionId: string;
    currency: DesignSpecNativeCurrency;
    actualPicoUnits: string;
  }): void {
    this.#budget.settle(input);
  }

  freezeUnknownSettlement(executionId: string): void {
    this.#budget.freezeUnknownSettlement(executionId);
  }

  snapshot() {
    return this.#budget.snapshot();
  }
}
