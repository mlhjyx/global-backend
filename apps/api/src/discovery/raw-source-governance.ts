export const RAW_SOURCE_RESTRICT_PROCESSING_EFFECT =
  "RESTRICT_PROCESSING" as const;
export const HISTORICAL_USASPENDING_PERSONAL_DATA_REASON =
  "HISTORICAL_USASPENDING_PERSONAL_DATA_FIELDS" as const;

export type HistoricalUsaSpendingRestrictedField =
  "recipient_name" | "description";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Detects key presence only. Values never cross this governance boundary. */
export function detectHistoricalUsaSpendingRestrictedFields(
  payload: unknown,
): HistoricalUsaSpendingRestrictedField[] {
  const procurement = record(record(record(payload)?.attributes)?.procurement);
  if (!procurement) return [];
  const detected: HistoricalUsaSpendingRestrictedField[] = [];
  if (Object.hasOwn(procurement, "recipient_name"))
    detected.push("recipient_name");
  if (Object.hasOwn(procurement, "description")) detected.push("description");
  return detected;
}

/** Defense in depth for any privileged/static caller that is not subject to app_user RLS. */
export function partitionGovernedRawRecords<T extends { readonly id: string }>(
  records: readonly T[],
  restrictedRawRecordIds: ReadonlySet<string>,
): { consumable: T[]; restricted: T[] } {
  const consumable: T[] = [];
  const restricted: T[] = [];
  for (const row of records) {
    if (restrictedRawRecordIds.has(row.id)) restricted.push(row);
    else consumable.push(row);
  }
  return { consumable, restricted };
}
