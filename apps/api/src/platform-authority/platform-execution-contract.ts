/**
 * Workflow-safe product bounds shared by Platform schedules and the pure
 * technical quote. This module deliberately has no Node, Nest, database,
 * Temporal, Provider, or network import.
 */
export const PLATFORM_ACQUISITION_DUE_SOURCE_MAX = 50 as const;
export const PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX = 10_000 as const;
export const PLATFORM_INTENT_DUE_SOURCE_MAX = 50 as const;
export const PLATFORM_INTENT_PAGES_PER_SOURCE_MAX = 20 as const;

export class PlatformExecutionContractError extends Error {
  readonly code = "PLATFORM_EXECUTION_CONTRACT_INVALID" as const;

  constructor() {
    super("PLATFORM_EXECUTION_CONTRACT_INVALID");
    this.name = "PlatformExecutionContractError";
  }
}

export function boundedPlatformDueSourceLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, PLATFORM_ACQUISITION_DUE_SOURCE_MAX)
    : PLATFORM_ACQUISITION_DUE_SOURCE_MAX;
}

export function boundedPlatformIntentDueSourceLimit(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, PLATFORM_INTENT_DUE_SOURCE_MAX)
    : PLATFORM_INTENT_DUE_SOURCE_MAX;
}

export function boundedPlatformAcquisitionFetchLimit(value: unknown): number {
  if (value === undefined) return PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PlatformExecutionContractError();
  }
  return Math.min(
    value as number,
    PLATFORM_ACQUISITION_SOURCE_FETCH_ITEM_MAX,
  );
}
