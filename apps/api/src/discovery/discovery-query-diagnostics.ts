import type { DiscoveryQueryReceipt } from "./discovery-query-receipt";
import { DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL } from "./discovery-query-receipt";

/**
 * S1: bounded, non-PII persistence of provider-reported query outcomes.
 *
 * The strict `discovery-query-receipt/v1` contract and every workflow payload stay
 * unchanged; this namespace rides inside `run.stats.queryDiagnostics` with its own
 * version, identity, bounds and conflict rules.
 */

export const DISCOVERY_QUERY_DIAGNOSTICS_VERSION = 1;
export const DISCOVERY_QUERY_DIAGNOSTICS_MAX_ENTRIES = 128;
const MAX_PROVIDERS_PER_ENTRY = 16;
const MAX_NAMESPACE_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** The only legal errorClass/reasonCode pairs a provider may durably report. */
const ALLOWED_OUTCOMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PARAM_INVALID: Object.freeze(["COUNTRY_INVALID", "COUNTRY_UNRESOLVED", "FILTERS_INVALID"]),
  EMPTY_RESULT: Object.freeze(["NO_ROWS"]),
});

interface ProviderDiagnostic {
  readonly providerKey: string;
  readonly errorClass: string;
  readonly reasonCode: string;
}

interface QueryDiagnosticEntry {
  readonly queryKey: string;
  readonly queryOrdinal: number;
  readonly sourceClass: string;
  readonly providers: readonly ProviderDiagnostic[];
}

function invalid(): never {
  throw new Error("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_INVALID");
}

function limit(): never {
  throw new Error("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_LIMIT");
}

function conflict(): never {
  throw new Error("DISCOVERY_QUERY_RECEIPT_STORE_DIAGNOSTICS_CONFLICT");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Prototype-chain names (`constructor`, `toString`, `__proto__`) must never be
 * mistaken for allowlisted classes: only own keys of the frozen table count.
 */
function allowedReasonCodes(errorClass: string): readonly string[] | null {
  if (!Object.hasOwn(ALLOWED_OUTCOMES, errorClass)) return null;
  return ALLOWED_OUTCOMES[errorClass] ?? null;
}

function parseProvider(raw: unknown): ProviderDiagnostic {
  const value = record(raw);
  if (!value || !exactKeys(value, ["providerKey", "errorClass", "reasonCode"])) invalid();
  const { providerKey, errorClass, reasonCode } = value;
  if (!safeIdentifier(providerKey)) invalid();
  if (typeof errorClass !== "string" || typeof reasonCode !== "string") invalid();
  const allowed = allowedReasonCodes(errorClass);
  if (!allowed || !allowed.includes(reasonCode)) invalid();
  return { providerKey, errorClass, reasonCode };
}

function parseEntry(raw: unknown): QueryDiagnosticEntry {
  const value = record(raw);
  if (!value || !exactKeys(value, ["queryKey", "queryOrdinal", "sourceClass", "providers"])) invalid();
  const { queryKey, queryOrdinal, sourceClass, providers } = value;
  if (typeof queryKey !== "string" || !SHA256.test(queryKey)) invalid();
  if (!boundedInteger(queryOrdinal, DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL)) invalid();
  if (!safeIdentifier(sourceClass)) invalid();
  if (!Array.isArray(providers) || providers.length > MAX_PROVIDERS_PER_ENTRY) invalid();
  const parsed = providers.map(parseProvider);
  for (let index = 1; index < parsed.length; index += 1) {
    if (compareIdentifiers(parsed[index - 1]!.providerKey, parsed[index]!.providerKey) >= 0) invalid();
  }
  return { queryKey, queryOrdinal: queryOrdinal as number, sourceClass, providers: parsed };
}

/** Reads the persisted namespace; `null` when this run never wrote one. */
function storedEntries(value: unknown): readonly QueryDiagnosticEntry[] | null {
  if (value === undefined) return null;
  const namespace = record(value);
  if (!namespace || !exactKeys(namespace, ["version", "entries"])) invalid();
  if (namespace.version !== DISCOVERY_QUERY_DIAGNOSTICS_VERSION) invalid();
  const rawEntries = namespace.entries;
  if (!Array.isArray(rawEntries)) invalid();
  if (rawEntries.length > DISCOVERY_QUERY_DIAGNOSTICS_MAX_ENTRIES) limit();
  const entries = rawEntries.map(parseEntry);
  const seenKeys = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (index > 0 && entries[index - 1]!.queryOrdinal >= entry.queryOrdinal) invalid();
    if (seenKeys.has(entry.queryKey)) invalid();
    seenKeys.add(entry.queryKey);
  }
  if (Buffer.byteLength(JSON.stringify(namespace), "utf8") > MAX_NAMESPACE_BYTES) limit();
  return entries;
}

function parseOutcome(providerKey: string, outcome: unknown): ProviderDiagnostic | null {
  const value = record(outcome);
  if (!value) return null;
  const { errorClass, reasonCode } = value;
  if (typeof errorClass !== "string" || typeof reasonCode !== "string") return null;
  const allowed = allowedReasonCodes(errorClass);
  if (!allowed || !allowed.includes(reasonCode)) return null;
  return { providerKey, errorClass, reasonCode };
}

function collectDiagnostics(
  receipt: DiscoveryQueryReceipt,
  settled: readonly PromiseSettledResult<{ key: string; r: { outcome?: unknown } }>[],
): ProviderDiagnostic[] {
  const known = new Set(receipt.providers);
  const outcomesByKey = new Map<string, ProviderDiagnostic>();
  for (const item of settled) {
    if (!item || item.status !== "fulfilled") continue;
    const value = record((item as PromiseFulfilledResult<unknown>).value);
    if (!value) continue;
    const key = value.key;
    if (typeof key !== "string" || !known.has(key)) continue;
    const payload = record(value.r);
    if (!payload) continue;
    const diagnostic = parseOutcome(key, payload.outcome);
    if (!diagnostic) continue;
    // A provider dispatch is unique per query; a duplicated key keeps the first
    // explicit outcome deterministically instead of persisting a union.
    if (!outcomesByKey.has(key)) outcomesByKey.set(key, diagnostic);
  }
  return [...outcomesByKey.values()].sort((left, right) =>
    compareIdentifiers(left.providerKey, right.providerKey),
  );
}

function sameProviders(left: readonly ProviderDiagnostic[], right: readonly ProviderDiagnostic[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (provider, index) =>
      provider.providerKey === right[index]!.providerKey &&
      provider.errorClass === right[index]!.errorClass &&
      provider.reasonCode === right[index]!.reasonCode,
  );
}

function validateReceiptIdentity(receipt: DiscoveryQueryReceipt): void {
  if (!receipt || typeof receipt !== "object") invalid();
  if (typeof receipt.queryKey !== "string" || !SHA256.test(receipt.queryKey)) invalid();
  if (!boundedInteger(receipt.queryOrdinal, DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL)) invalid();
  if (!safeIdentifier(receipt.sourceClass)) invalid();
  if (
    !Array.isArray(receipt.providers) ||
    receipt.providers.length > MAX_PROVIDERS_PER_ENTRY ||
    !receipt.providers.every(safeIdentifier) ||
    new Set(receipt.providers).size !== receipt.providers.length
  ) {
    invalid();
  }
}

/**
 * Merges explicit, allowlisted provider outcomes for this query into the run's
 * persisted stats. Returns the input object unchanged when there is nothing to
 * persist (unknown stays unknown). Never mutates the input and never persists
 * free text, issues, query values or provider payloads.
 */
export function mergeDiscoveryQueryDiagnostics(
  stats: unknown,
  receipt: DiscoveryQueryReceipt,
  settled: readonly PromiseSettledResult<{ key: string; r: { outcome?: unknown } }>[],
): Record<string, unknown> {
  const base: Record<string, unknown> = stats == null ? {} : (record(stats) ?? invalid());
  validateReceiptIdentity(receipt);
  const providers = collectDiagnostics(receipt, settled);
  if (providers.length === 0) return base;
  const entries = storedEntries(base.queryDiagnostics);
  const sameKey = entries?.find((entry) => entry.queryKey === receipt.queryKey);
  if (sameKey) {
    if (
      sameKey.queryOrdinal !== receipt.queryOrdinal ||
      sameKey.sourceClass !== receipt.sourceClass ||
      !sameProviders(sameKey.providers, providers)
    ) {
      conflict();
    }
    return base;
  }
  if (entries?.some((entry) => entry.queryOrdinal === receipt.queryOrdinal)) conflict();
  if ((entries?.length ?? 0) >= DISCOVERY_QUERY_DIAGNOSTICS_MAX_ENTRIES) limit();
  const incoming: QueryDiagnosticEntry = {
    queryKey: receipt.queryKey,
    queryOrdinal: receipt.queryOrdinal,
    sourceClass: receipt.sourceClass,
    providers,
  };
  const next = [...(entries ?? []), incoming].sort(
    (left, right) => left.queryOrdinal - right.queryOrdinal,
  );
  const namespace = { version: DISCOVERY_QUERY_DIAGNOSTICS_VERSION, entries: next };
  if (Buffer.byteLength(JSON.stringify(namespace), "utf8") > MAX_NAMESPACE_BYTES) limit();
  return { ...base, queryDiagnostics: namespace };
}
