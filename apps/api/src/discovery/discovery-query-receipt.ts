import { createHash } from "node:crypto";
import { DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL } from "./discovery-query-receipt-contract";

export {
  DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL,
  DISCOVERY_QUERY_RECEIPT_MODE,
} from "./discovery-query-receipt-contract";

export const DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES = 128;
const MAX_RECEIPT_STORE_BYTES = 64 * 1024;
const MAX_COUNT = 1_000_000;
const MAX_COST_CENTS = 1_000_000_000;
const MAX_FILTER_BYTES = 32 * 1024;
const MAX_FILTER_NODES = 1_024;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RECEIPT_KEYS = [
  "accepted",
  "costCents",
  "duplicate",
  "governanceDenied",
  "providers",
  "quarantined",
  "queryKey",
  "queryOrdinal",
  "rejected",
  "schemaVersion",
  "sourceClass",
  "usageQuantity",
] as const;

export interface DiscoveryQueryIdentityInput {
  runId: string;
  planId: string;
  queryOrdinal: number;
  query: {
    source_class: string;
    filters: Record<string, unknown>;
    keywords: string[];
    priority: number;
  };
}

export interface DiscoveryQueryReceipt {
  readonly schemaVersion: "discovery-query-receipt/v1";
  readonly queryKey: string;
  readonly queryOrdinal: number;
  readonly sourceClass: string;
  readonly providers: readonly string[];
  readonly accepted: number;
  readonly quarantined: number;
  readonly rejected: number;
  readonly governanceDenied: number;
  readonly duplicate: number;
  readonly usageQuantity: number;
  readonly costCents: number;
}

interface CanonicalState {
  nodes: number;
}

function invalid(code = "DISCOVERY_QUERY_RECEIPT_INVALID"): never {
  throw new Error(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function boundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFC") === value &&
    SAFE_IDENTIFIER.test(value)
  );
}

function canonicalJson(
  value: unknown,
  state: CanonicalState,
  depth = 0,
): string {
  state.nodes += 1;
  if (state.nodes > MAX_FILTER_NODES || depth > 8) invalid();
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    if (
      value.normalize("NFC") !== value ||
      Buffer.byteLength(value, "utf8") > 1_024
    ) {
      invalid();
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 128) invalid();
    return `[${value
      .map((item) => canonicalJson(item, state, depth + 1))
      .join(",")}]`;
  }
  const object = record(value);
  if (!object || Object.keys(object).length > 128) invalid();
  const entries = Object.keys(object)
    .sort()
    .map((key) => {
      if (
        key.normalize("NFC") !== key ||
        Buffer.byteLength(key, "utf8") > 128 ||
        object[key] === undefined
      ) {
        invalid();
      }
      return `${JSON.stringify(key)}:${canonicalJson(
        object[key],
        state,
        depth + 1,
      )}`;
    });
  return `{${entries.join(",")}}`;
}

function canonicalQuery(input: DiscoveryQueryIdentityInput): string {
  const filters = input.query.filters ?? {};
  const keywords = input.query.keywords ?? [];
  const priority = input.query.priority ?? 99;
  if (
    !safeIdentifier(input.runId) ||
    !safeIdentifier(input.planId) ||
    !boundedInteger(
      input.queryOrdinal,
      DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL,
    ) ||
    !safeIdentifier(input.query.source_class) ||
    !boundedInteger(priority, 1_000_000) ||
    !Array.isArray(keywords) ||
    keywords.length > 64 ||
    !keywords.every(
      (keyword) =>
        typeof keyword === "string" &&
        keyword.normalize("NFC") === keyword &&
        Buffer.byteLength(keyword, "utf8") <= 256,
    ) ||
    !record(filters)
  ) {
    invalid();
  }
  const material = canonicalJson(
    {
      runId: input.runId,
      planId: input.planId,
      queryOrdinal: input.queryOrdinal,
      normalizedQuery: {
        sourceClass: input.query.source_class,
        filters,
        keywords,
        priority,
      },
    },
    { nodes: 0 },
  );
  if (Buffer.byteLength(material, "utf8") > MAX_FILTER_BYTES) invalid();
  return material;
}

export function discoveryQueryKey(input: DiscoveryQueryIdentityInput): string {
  return createHash("sha256").update(canonicalQuery(input)).digest("hex");
}

export function parseDiscoveryQueryReceipt(
  value: unknown,
): DiscoveryQueryReceipt {
  const input = record(value);
  if (!input || !exactKeys(input, RECEIPT_KEYS)) invalid();
  const providers = input.providers;
  if (
    input.schemaVersion !== "discovery-query-receipt/v1" ||
    typeof input.queryKey !== "string" ||
    !SHA256.test(input.queryKey) ||
    !boundedInteger(
      input.queryOrdinal,
      DISCOVERY_QUERY_RECEIPT_MAX_ORDINAL,
    ) ||
    !safeIdentifier(input.sourceClass) ||
    !Array.isArray(providers) ||
    providers.length > 16 ||
    !providers.every(safeIdentifier) ||
    new Set(providers).size !== providers.length ||
    providers.some((provider, index) => index > 0 && providers[index - 1]! > provider) ||
    !boundedInteger(input.accepted, MAX_COUNT) ||
    !boundedInteger(input.quarantined, MAX_COUNT) ||
    !boundedInteger(input.rejected, MAX_COUNT) ||
    !boundedInteger(input.governanceDenied, MAX_COUNT) ||
    input.governanceDenied !== input.quarantined + input.rejected ||
    !boundedInteger(input.duplicate, MAX_COUNT) ||
    !boundedInteger(input.usageQuantity, MAX_COUNT) ||
    input.usageQuantity !== input.accepted ||
    !boundedInteger(input.costCents, MAX_COST_CENTS)
  ) {
    invalid();
  }
  return Object.freeze({
    schemaVersion: "discovery-query-receipt/v1" as const,
    queryKey: input.queryKey,
    queryOrdinal: input.queryOrdinal,
    sourceClass: input.sourceClass,
    providers: Object.freeze([...providers]),
    accepted: input.accepted,
    quarantined: input.quarantined,
    rejected: input.rejected,
    governanceDenied: input.governanceDenied,
    duplicate: input.duplicate,
    usageQuantity: input.usageQuantity,
    costCents: input.costCents,
  });
}

function receiptMap(stats: unknown): Record<string, DiscoveryQueryReceipt> {
  const input = stats == null ? {} : record(stats);
  if (!input) invalid("DISCOVERY_QUERY_RECEIPT_STORE_INVALID");
  const raw = input.perQuery === undefined ? {} : record(input.perQuery);
  if (!raw) invalid("DISCOVERY_QUERY_RECEIPT_STORE_INVALID");
  const entries = Object.entries(raw);
  if (entries.length > DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES) {
    invalid("DISCOVERY_QUERY_RECEIPT_STORE_LIMIT");
  }
  const parsed = Object.fromEntries(
    entries.map(([key, value]) => {
      const receipt = parseDiscoveryQueryReceipt(value);
      if (key !== receipt.queryKey) {
        invalid("DISCOVERY_QUERY_RECEIPT_STORE_INVALID");
      }
      return [key, receipt];
    }),
  );
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_RECEIPT_STORE_BYTES) {
    invalid("DISCOVERY_QUERY_RECEIPT_STORE_LIMIT");
  }
  return parsed;
}

function receiptBytes(receipt: DiscoveryQueryReceipt): string {
  return JSON.stringify(receipt);
}

export function readDiscoveryQueryReceipt(
  stats: unknown,
  queryKey: string,
): DiscoveryQueryReceipt | null {
  if (!SHA256.test(queryKey)) invalid();
  return receiptMap(stats)[queryKey] ?? null;
}

export function mergeDiscoveryQueryReceipt(
  stats: unknown,
  value: unknown,
): Record<string, unknown> {
  const base = stats == null ? {} : record(stats);
  if (!base) invalid("DISCOVERY_QUERY_RECEIPT_STORE_INVALID");
  const receipt = parseDiscoveryQueryReceipt(value);
  const current = receiptMap(base);
  const existing = current[receipt.queryKey];
  if (existing) {
    if (receiptBytes(existing) !== receiptBytes(receipt)) {
      invalid("DISCOVERY_QUERY_RECEIPT_DRIFT");
    }
    return base;
  }
  if (
    Object.values(current).some(
      (candidate) => candidate.queryOrdinal === receipt.queryOrdinal,
    )
  ) {
    invalid("DISCOVERY_QUERY_RECEIPT_ORDINAL_CONFLICT");
  }
  if (Object.keys(current).length >= DISCOVERY_QUERY_RECEIPT_MAX_ENTRIES) {
    invalid("DISCOVERY_QUERY_RECEIPT_STORE_LIMIT");
  }
  const entries: Array<[string, DiscoveryQueryReceipt]> = [
    ...Object.entries(current),
    [receipt.queryKey, receipt],
  ];
  const perQuery = Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
  if (Buffer.byteLength(JSON.stringify(perQuery), "utf8") > MAX_RECEIPT_STORE_BYTES) {
    invalid("DISCOVERY_QUERY_RECEIPT_STORE_LIMIT");
  }
  return { ...base, perQuery };
}

export function summarizeDiscoveryQueryReceipts(stats: unknown): {
  perQuery: Record<string, DiscoveryQueryReceipt>;
  perSource: Record<
    string,
    {
      rawCount: number;
      quarantinedCount: number;
      rejectedCount: number;
      governanceDenied: number;
      duplicateCount: number;
      usageQuantity: number;
      costCents: number;
      providers: string[];
      provider: string | null;
    }
  >;
  rawGovernance: {
    accepted: number;
    quarantined: number;
    rejected: number;
    governanceDenied: number;
    duplicate: number;
    usageQuantity: number;
    costCents: number;
  };
} {
  const perQuery = receiptMap(stats);
  const perSource: ReturnType<typeof summarizeDiscoveryQueryReceipts>["perSource"] = {};
  const rawGovernance = {
    accepted: 0,
    quarantined: 0,
    rejected: 0,
    governanceDenied: 0,
    duplicate: 0,
    usageQuantity: 0,
    costCents: 0,
  };
  for (const receipt of Object.values(perQuery).sort(
    (left, right) => left.queryOrdinal - right.queryOrdinal,
  )) {
    const prior = perSource[receipt.sourceClass] ?? {
      rawCount: 0,
      quarantinedCount: 0,
      rejectedCount: 0,
      governanceDenied: 0,
      duplicateCount: 0,
      usageQuantity: 0,
      costCents: 0,
      providers: [],
      provider: null,
    };
    const providers = [
      ...new Set([...prior.providers, ...receipt.providers]),
    ].sort();
    perSource[receipt.sourceClass] = {
      rawCount: prior.rawCount + receipt.accepted,
      quarantinedCount: prior.quarantinedCount + receipt.quarantined,
      rejectedCount: prior.rejectedCount + receipt.rejected,
      governanceDenied: prior.governanceDenied + receipt.governanceDenied,
      duplicateCount: prior.duplicateCount + receipt.duplicate,
      usageQuantity: prior.usageQuantity + receipt.usageQuantity,
      costCents: prior.costCents + receipt.costCents,
      providers,
      provider: providers.join('+') || null,
    };
    rawGovernance.accepted += receipt.accepted;
    rawGovernance.quarantined += receipt.quarantined;
    rawGovernance.rejected += receipt.rejected;
    rawGovernance.governanceDenied += receipt.governanceDenied;
    rawGovernance.duplicate += receipt.duplicate;
    rawGovernance.usageQuantity += receipt.usageQuantity;
    rawGovernance.costCents += receipt.costCents;
  }
  return { perQuery, perSource, rawGovernance };
}
