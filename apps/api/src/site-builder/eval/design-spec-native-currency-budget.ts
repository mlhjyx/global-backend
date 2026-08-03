import {
  DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES,
  type DesignSpecNativeCurrency,
  type DesignSpecNativeTargetProtocol,
} from "./design-spec-native-fee-card";

export type { DesignSpecNativeCurrency } from "./design-spec-native-fee-card";

type NativeBudgetFreezeReason =
  | "unknown_settlement"
  | "settlement_currency_mismatch"
  | "settlement_exceeds_reservation"
  | "native_budget_exhausted";

interface NativeBudgetState {
  capPicoUnits: bigint;
  committedPicoUnits: bigint;
  reservedPicoUnits: bigint;
}

interface NativeReservation {
  currency: DesignSpecNativeCurrency;
  maximumPicoUnits: bigint;
}

const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/;
const PICO_UNITS = /^(?:0|[1-9][0-9]*)$/;

function parsePicoUnits(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !PICO_UNITS.test(value)) {
    throw new Error(
      `${label} must be a canonical non-negative pico-unit string`,
    );
  }
  return BigInt(value);
}

function nativeBudgetState(
  capPicoUnits: unknown,
  label: DesignSpecNativeCurrency,
): NativeBudgetState {
  const cap = parsePicoUnits(capPicoUnits, `${label} cap`);
  if (cap <= 0n) throw new Error(`${label} cap must be positive`);
  return { capPicoUnits: cap, committedPicoUnits: 0n, reservedPicoUnits: 0n };
}

function remaining(state: NativeBudgetState): bigint {
  return (
    state.capPicoUnits - state.committedPicoUnits - state.reservedPicoUnits
  );
}

function snapshotState(state: NativeBudgetState) {
  return Object.freeze({
    capPicoUnits: state.capPicoUnits.toString(),
    committedPicoUnits: state.committedPicoUnits.toString(),
    reservedPicoUnits: state.reservedPicoUnits.toString(),
    remainingPicoUnits: remaining(state).toString(),
  });
}

/**
 * Resolves the only admitted design_spec text dispatches to their OpenOx
 * settlement currency. It intentionally has no default or conversion path.
 */
export function designSpecNativeCurrencyForDispatch(
  alias: string,
  protocol: DesignSpecNativeTargetProtocol,
): DesignSpecNativeCurrency {
  const match = DESIGN_SPEC_NATIVE_FEE_CARD_DISPATCHES.find(
    (entry) => entry.alias === alias && entry.protocol === protocol,
  );
  if (!match) {
    throw new Error(
      "design_spec dispatch is not admitted for native settlement",
    );
  }
  return match.currency;
}

/**
 * In-memory no-FX guard for the future design_spec executor. A durable ledger
 * remains mandatory at dispatch time; this guard prevents the executor from
 * combining CNY and USD when reserving or settling a wire call.
 */
export class DesignSpecNativeCurrencyBudgetGuard {
  readonly #states: ReadonlyMap<DesignSpecNativeCurrency, NativeBudgetState>;
  readonly #reservations = new Map<string, NativeReservation>();
  #freezeReason: NativeBudgetFreezeReason | null = null;

  constructor(caps: Readonly<Record<DesignSpecNativeCurrency, string>>) {
    if (
      !caps ||
      typeof caps !== "object" ||
      Object.keys(caps).sort().join(",") !== "CNY,USD"
    ) {
      throw new Error("native budget caps must contain exactly CNY and USD");
    }
    this.#states = new Map<DesignSpecNativeCurrency, NativeBudgetState>([
      ["CNY", nativeBudgetState(caps.CNY, "CNY")],
      ["USD", nativeBudgetState(caps.USD, "USD")],
    ]);
  }

  reserve(input: {
    executionId: string;
    alias: string;
    protocol: DesignSpecNativeTargetProtocol;
    maximumPicoUnits: string;
  }): void {
    if (this.#freezeReason) {
      throw new Error(
        `native-currency campaign is frozen: ${this.#freezeReason}`,
      );
    }
    if (!EXECUTION_ID.test(input.executionId)) {
      throw new Error("native reservation execution id is invalid");
    }
    if (this.#reservations.has(input.executionId)) {
      throw new Error("native reservation execution id is already reserved");
    }
    const currency = designSpecNativeCurrencyForDispatch(
      input.alias,
      input.protocol,
    );
    const maximumPicoUnits = parsePicoUnits(
      input.maximumPicoUnits,
      "native reservation amount",
    );
    if (maximumPicoUnits <= 0n) {
      throw new Error("native reservation amount must be positive");
    }
    const state = this.#states.get(currency)!;
    if (maximumPicoUnits > remaining(state)) {
      this.#freezeReason = "native_budget_exhausted";
      throw new Error("native-currency budget exhausted before dispatch");
    }
    state.reservedPicoUnits += maximumPicoUnits;
    this.#reservations.set(
      input.executionId,
      Object.freeze({ currency, maximumPicoUnits }),
    );
  }

  settle(input: {
    executionId: string;
    currency: DesignSpecNativeCurrency;
    actualPicoUnits: string;
  }): void {
    if (this.#freezeReason) {
      throw new Error(
        `native-currency campaign is frozen: ${this.#freezeReason}`,
      );
    }
    const reservation = this.#reservations.get(input.executionId);
    if (!reservation) throw new Error("native settlement has no reservation");
    const actualPicoUnits = parsePicoUnits(
      input.actualPicoUnits,
      "native settlement amount",
    );
    if (reservation.currency !== input.currency) {
      this.#freezeReason = "settlement_currency_mismatch";
      throw new Error("native settlement currency does not match reservation");
    }
    if (actualPicoUnits > reservation.maximumPicoUnits) {
      this.#freezeReason = "settlement_exceeds_reservation";
      throw new Error("native settlement exceeds reservation");
    }
    const state = this.#states.get(reservation.currency)!;
    state.reservedPicoUnits -= reservation.maximumPicoUnits;
    state.committedPicoUnits += actualPicoUnits;
    this.#reservations.delete(input.executionId);
  }

  freezeUnknownSettlement(executionId: string): void {
    if (!this.#reservations.has(executionId)) {
      throw new Error("unknown settlement has no reservation");
    }
    this.#freezeReason = "unknown_settlement";
  }

  snapshot() {
    return Object.freeze({
      frozen: this.#freezeReason !== null,
      ...(this.#freezeReason ? { freezeReason: this.#freezeReason } : {}),
      totalsByCurrency: Object.freeze({
        CNY: snapshotState(this.#states.get("CNY")!),
        USD: snapshotState(this.#states.get("USD")!),
      }),
    });
  }
}
