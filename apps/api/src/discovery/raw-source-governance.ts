export const RAW_SOURCE_RESTRICT_PROCESSING_EFFECT =
  "RESTRICT_PROCESSING" as const;
export const HISTORICAL_USASPENDING_PERSONAL_DATA_REASON =
  "HISTORICAL_USASPENDING_PERSONAL_DATA_FIELDS" as const;

export type HistoricalUsaSpendingRestrictedField =
  "recipient_name" | "description";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Detects only the two retired USAspending procurement keys. Their values are
 * deliberately neither returned nor copied into the governance ledger.
 */
export function detectHistoricalUsaSpendingRestrictedFields(
  payload: unknown,
): HistoricalUsaSpendingRestrictedField[] {
  const procurement = asRecord(
    asRecord(asRecord(payload)?.attributes)?.procurement,
  );
  if (!procurement) return [];

  const fields: HistoricalUsaSpendingRestrictedField[] = [];
  if (Object.prototype.hasOwnProperty.call(procurement, "recipient_name")) {
    fields.push("recipient_name");
  }
  if (Object.prototype.hasOwnProperty.call(procurement, "description")) {
    fields.push("description");
  }
  return fields;
}

/** Owner/BYPASSRLS defense in depth for canonicalization and replay callers. */
export function partitionGovernedRawRecords<T extends { id: string }>(
  records: readonly T[],
  restrictedRawRecordIds: ReadonlySet<string>,
): { consumable: T[]; restricted: T[] } {
  const consumable: T[] = [];
  const restricted: T[] = [];
  for (const record of records) {
    (restrictedRawRecordIds.has(record.id) ? restricted : consumable).push(
      record,
    );
  }
  return { consumable, restricted };
}
