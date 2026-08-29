import { createHash } from "node:crypto";
import { types } from "node:util";
import { validateRawSourceProviderPayload } from "./raw-source-provider-schema";

export const RAW_SOURCE_INGEST_VERSION = "raw-source/v2" as const;

export type RawSourceIngestStatus =
  "ACCEPTED" | "QUARANTINED" | "REJECTED" | "EXPIRED";

export type RawSourceDispositionCode =
  | "INVALID_JSON"
  | "MALFORMED_PAYLOAD"
  | "UNKNOWN_PAYLOAD_FIELD"
  | "UNGOVERNED_PROVIDER_PAYLOAD"
  | "PROVIDER_PAYLOAD_SCHEMA_INVALID"
  | "INVALID_PROVENANCE"
  | "SOURCE_POLICY_MISSING"
  | "SOURCE_POLICY_PURPOSE_NOT_ALLOWED"
  | "SOURCE_POLICY_SUSPENDED"
  | "PAYLOAD_TOO_LARGE"
  | "BATCH_LIMIT_EXCEEDED"
  | "PROCESSING_KEY_DRIFT";

export interface RawSourceIngestLimits {
  maxRecordBytes: number;
  maxBatchBytes: number;
  defaultRetentionDays: number;
}

export interface RawSourcePolicySnapshot {
  id: string;
  domain: string;
  retentionDays: number;
  reviewStatus: string;
  allowedPurpose?: unknown;
  updatedAt: Date;
}

export interface PreparedRawSourceRow {
  externalId: string | null;
  payload: unknown;
  sourceUrl: string | null;
  fetchedAt: Date | null;
  contentHash: string | null;
  parserVersion: string | null;
  ingestKey: string;
  payloadHash: string;
  payloadBytes: number;
  ingestVersion: typeof RAW_SOURCE_INGEST_VERSION;
  ingestStatus: Exclude<RawSourceIngestStatus, "EXPIRED">;
  dispositionCode: RawSourceDispositionCode | null;
  retentionDays: number;
  expiresAt: Date;
  sourcePolicySnapshot: Record<string, unknown>;
}

export interface ExistingRawSourceReceipt {
  id: string;
  externalId: string | null;
  ingestKey: string | null;
  payloadHash: string | null;
  payload: unknown;
}

export type RawSourceIndexedResolution =
  | Readonly<{
      recordIndex: number;
      kind: "WRITE";
      row: PreparedRawSourceRow;
    }>
  | Readonly<{
      recordIndex: number;
      kind: "EXISTING";
      rawRecordId: string;
    }>
  | Readonly<{
      recordIndex: number;
      kind: "REUSE_BATCH";
      sourceRecordIndex: number;
    }>;

const DEFAULT_LIMITS: RawSourceIngestLimits = Object.freeze({
  maxRecordBytes: 512 * 1024,
  maxBatchBytes: 5 * 1024 * 1024,
  defaultRetentionDays: 365,
});
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_RETENTION_DAYS = 3_650;
const MAX_EXTERNAL_ID_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2_048;
const MAX_PROVENANCE_TOKEN_BYTES = 256;
class InvalidCanonicalJsonError extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

interface BoundedTraversal {
  ancestors: Set<object>;
  remaining: number;
}

function canonicalJson(
  value: unknown,
  state: BoundedTraversal = { ancestors: new Set<object>(), remaining: 1_000 },
  depth = 0,
): string {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > 32) {
    throw new InvalidCanonicalJsonError("canonical JSON bounds exceeded");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new InvalidCanonicalJsonError("non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new InvalidCanonicalJsonError(`unsupported ${typeof value}`);
  }
  if (state.ancestors.has(value)) {
    throw new InvalidCanonicalJsonError("cyclic value");
  }

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        value.length > 1_000 ||
        Object.getOwnPropertySymbols(value).length > 0 ||
        Object.keys(value).length !== value.length
      ) {
        throw new InvalidCanonicalJsonError("invalid array container");
      }
      const items = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new InvalidCanonicalJsonError("array accessor");
        }
        return canonicalJson(descriptor.value, state, depth + 1);
      });
      return `[${items.join(",")}]`;
    }
    const record = plainRecord(value);
    if (!record) throw new InvalidCanonicalJsonError("non-plain object");
    const ownKeys = Reflect.ownKeys(record);
    if (
      ownKeys.length > 128 ||
      ownKeys.some((key) => typeof key === "symbol")
    ) {
      throw new InvalidCanonicalJsonError("invalid object keys");
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(record))
      .flatMap(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new InvalidCanonicalJsonError("object accessor");
        }
        return descriptor.value === undefined
          ? []
          : ([[key, descriptor.value]] as [string, unknown][]);
      })
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, state, depth + 1)}`,
      )
      .join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function diagnosticShape(
  value: unknown,
  state: BoundedTraversal = { ancestors: new Set<object>(), remaining: 256 },
  depth = 0,
): string {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > 8) return "[bounded]";
  if (value === null) return "null";
  if (typeof value === "string")
    return `[string:${Buffer.byteLength(value, "utf8")}]`;
  if (
    ["number", "boolean", "bigint", "undefined", "function", "symbol"].includes(
      typeof value,
    )
  ) {
    return `[${typeof value}]`;
  }
  if (typeof value !== "object") return "[unknown]";
  if (state.ancestors.has(value)) return "[cycle]";
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    try {
      if (value.length > 100) return `[array:${value.length}]`;
      return `[${Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        return descriptor && "value" in descriptor
          ? diagnosticShape(descriptor.value, state, depth + 1)
          : "[accessor]";
      }).join(",")}]`;
    } finally {
      state.ancestors.delete(value);
    }
  }
  const record = plainRecord(value);
  if (!record) {
    state.ancestors.delete(value);
    return "[object]";
  }
  try {
    const keys = Reflect.ownKeys(record);
    if (keys.length > 64) return `{keys:${keys.length}}`;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    return `{${keys
      .map(String)
      .sort()
      .map((key) => {
        const descriptor = descriptors[key];
        return `${key}:${
          descriptor && "value" in descriptor
            ? diagnosticShape(descriptor.value, state, depth + 1)
            : "[accessor]"
        }`;
      })
      .join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

function hashBasis(value: unknown): unknown {
  const record = plainRecord(value);
  if (!record) return value;
  const recordDescriptors = Object.getOwnPropertyDescriptors(record);
  const provenanceDescriptor = recordDescriptors.provenance;
  if (!provenanceDescriptor || !("value" in provenanceDescriptor)) return value;
  const provenance = plainRecord(provenanceDescriptor.value);
  if (!record || !provenance) return value;
  const provenanceDescriptors = Object.getOwnPropertyDescriptors(provenance);
  if (
    Object.getOwnPropertySymbols(record).length > 0 ||
    Object.getOwnPropertySymbols(provenance).length > 0 ||
    Object.values(recordDescriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    ) ||
    Object.values(provenanceDescriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  ) {
    return value;
  }
  const stableRecord = Object.fromEntries(
    Object.entries(recordDescriptors).flatMap(([key, descriptor]) =>
      descriptor.enumerable && "value" in descriptor
        ? [[key, descriptor.value]]
        : [],
    ),
  );
  const stableProvenance = Object.fromEntries(
    Object.entries(provenanceDescriptors).flatMap(([key, descriptor]) =>
      key !== "fetchedAt" && descriptor.enumerable && "value" in descriptor
        ? [[key, descriptor.value]]
        : [],
    ),
  );
  return { ...stableRecord, provenance: stableProvenance };
}

export function rawPayloadHash(value: unknown): string {
  return sha256(canonicalJson(hashBasis(value)));
}

function sanitizePayload(
  value: unknown,
  providerKey: string,
): {
  value: unknown;
  minimizedFields: string[];
  error:
    | "MALFORMED_PAYLOAD"
    | "UNKNOWN_PAYLOAD_FIELD"
    | "UNGOVERNED_PROVIDER_PAYLOAD"
    | "PROVIDER_PAYLOAD_SCHEMA_INVALID"
    | null;
} {
  const validated = validateRawSourceProviderPayload(providerKey, value);
  return validated.ok
    ? { value: validated.value, minimizedFields: [], error: null }
    : { value: {}, minimizedFields: [], error: validated.reason };
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  return trimmed && Buffer.byteLength(trimmed, "utf8") <= maxBytes
    ? trimmed
    : null;
}

function provenanceOf(value: unknown): {
  sourceUrl: string | null;
  fetchedAt: Date | null;
  contentHash: string | null;
  parserVersion: string | null;
  hostname: string | null;
  invalid: boolean;
} {
  const record = plainRecord(value);
  const provenance = plainRecord(record?.provenance);
  const exact = provenance
    ? Object.keys(provenance).sort().join(",") ===
      "contentHash,fetchedAt,parserVersion,sourceUrl"
    : false;
  const sourceUrl = boundedString(provenance?.sourceUrl, MAX_SOURCE_URL_BYTES);
  const fetchedAtText = boundedString(provenance?.fetchedAt, 128);
  const fetchedAt = fetchedAtText ? new Date(fetchedAtText) : null;
  const contentHash = boundedString(
    provenance?.contentHash,
    MAX_PROVENANCE_TOKEN_BYTES,
  );
  const parserVersion = boundedString(
    provenance?.parserVersion,
    MAX_PROVENANCE_TOKEN_BYTES,
  );
  let hostname: string | null = null;
  try {
    if (sourceUrl) {
      const parsed = new URL(sourceUrl);
      if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("unsupported protocol");
      hostname = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    }
  } catch {
    hostname = null;
  }
  return {
    sourceUrl,
    fetchedAt,
    contentHash,
    parserVersion,
    hostname,
    invalid:
      !exact ||
      !sourceUrl ||
      !fetchedAt ||
      Number.isNaN(fetchedAt.getTime()) ||
      !contentHash ||
      !parserVersion ||
      !hostname,
  };
}

function policyFor(
  hostname: string | null,
  policies: readonly RawSourcePolicySnapshot[],
  minimizedFields: readonly string[],
  fallbackDays: number,
): {
  retentionDays: number;
  snapshot: Record<string, unknown>;
  missing: boolean;
  purposeAllowed: boolean;
} {
  const policy = hostname
    ? [...policies]
        .filter((candidate) => {
          const domain = candidate.domain.toLowerCase().replace(/^www\./u, "");
          return domain === hostname || hostname.endsWith(`.${domain}`);
        })
        .sort((left, right) => right.domain.length - left.domain.length)[0]
    : undefined;
  const retentionDays = Math.min(
    MAX_RETENTION_DAYS,
    Math.max(1, policy?.retentionDays ?? fallbackDays),
  );
  if (!policy) {
    return {
      retentionDays,
      missing: true,
      purposeAllowed: false,
      snapshot: {
        kind: "missing",
        retentionDays,
        allowedPurpose: [],
        minimizedFields: [...minimizedFields],
      },
    };
  }
  const allowedPurpose = policy.allowedPurpose;
  const purposeAllowed =
    Array.isArray(allowedPurpose) &&
    allowedPurpose.length > 0 &&
    allowedPurpose.every((purpose) => typeof purpose === "string") &&
    allowedPurpose.includes("discovery");
  return {
    retentionDays,
    missing: false,
    purposeAllowed,
    snapshot: {
      kind: "source_policy",
      id: policy.id,
      domain: policy.domain,
      retentionDays,
      reviewStatus: policy.reviewStatus,
      allowedPurpose: purposeAllowed ? ["discovery"] : [],
      updatedAt: policy.updatedAt.toISOString(),
      minimizedFields: [...minimizedFields],
    },
  };
}

function ingestKeyFor(payload: unknown, payloadHash: string): string {
  const record = plainRecord(payload);
  const externalId = boundedString(record?.externalId, MAX_EXTERNAL_ID_BYTES);
  if (externalId) return `external:${sha256(externalId)}`;
  const identifier = plainRecord(record?.identifier);
  const scheme = boundedString(identifier?.scheme, 64)?.toLowerCase();
  const identifierValue = boundedString(identifier?.value, 256);
  const domain = boundedString(record?.domain, 512)?.toLowerCase();
  const name = boundedString(record?.name, 512)
    ?.toLowerCase()
    .replaceAll(/\s+/gu, " ");
  const country = boundedString(record?.country, 32)?.toUpperCase();
  if (scheme && identifierValue) {
    return `identity:${sha256(canonicalJson({ scheme, value: identifierValue }))}`;
  }
  if (domain || name)
    return `identity:${sha256(canonicalJson({ country, domain, name }))}`;
  return `payload:${payloadHash}`;
}

function boundedLimit(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

export function rawSourceIngestLimits(
  env: NodeJS.ProcessEnv = process.env,
): RawSourceIngestLimits {
  return {
    maxRecordBytes: boundedLimit(
      env.RAW_SOURCE_MAX_RECORD_BYTES,
      DEFAULT_LIMITS.maxRecordBytes,
      MAX_RECORD_BYTES,
    ),
    maxBatchBytes: boundedLimit(
      env.RAW_SOURCE_MAX_BATCH_BYTES,
      DEFAULT_LIMITS.maxBatchBytes,
      MAX_BATCH_BYTES,
    ),
    defaultRetentionDays: boundedLimit(
      env.RAW_SOURCE_DEFAULT_RETENTION_DAYS,
      DEFAULT_LIMITS.defaultRetentionDays,
      MAX_RETENTION_DAYS,
    ),
  };
}

function minimalReceipt(
  status: "QUARANTINED" | "REJECTED",
  reason: RawSourceDispositionCode,
  payloadHash: string,
  payloadBytes: number,
  conflictWithRawId?: string,
): Record<string, unknown> {
  return {
    _rawReceipt:
      status === "REJECTED"
        ? "raw-source/rejected/v1"
        : "raw-source/quarantine/v1",
    reason,
    originalPayloadHash: payloadHash,
    originalPayloadBytes: payloadBytes,
    ...(conflictWithRawId ? { conflictWithRawId } : {}),
  };
}

export function prepareRawSourceBatch(args: {
  providerKey: string;
  records: readonly unknown[];
  policies: readonly RawSourcePolicySnapshot[];
  limits?: RawSourceIngestLimits;
  now?: Date;
}): { rows: PreparedRawSourceRow[] } {
  const limits = args.limits ?? rawSourceIngestLimits();
  const now = args.now ?? new Date();
  let batchBytes = 0;
  const rows = args.records.map((original): PreparedRawSourceRow => {
    const sanitized = sanitizePayload(original, args.providerKey);
    let canonical: string;
    let normalizedPayload: unknown = sanitized.value;
    let jsonInvalid = false;
    let originalCanonical = "";
    try {
      originalCanonical = canonicalJson(original);
    } catch {
      jsonInvalid = true;
    }
    if (jsonInvalid) {
      canonical = diagnosticShape(original);
    } else if (sanitized.error) {
      canonical = originalCanonical;
      normalizedPayload = {};
    } else {
      try {
        canonical = canonicalJson(sanitized.value);
        normalizedPayload = JSON.parse(canonical) as unknown;
      } catch {
        jsonInvalid = true;
        canonical = diagnosticShape(sanitized.value);
      }
    }
    const originalPayloadBytes = Buffer.byteLength(canonical, "utf8");
    const originalPayloadHash = jsonInvalid
      ? sha256(canonical)
      : sanitized.error
        ? rawPayloadHash(original)
        : rawPayloadHash(normalizedPayload);
    batchBytes += originalPayloadBytes;
    const record = plainRecord(normalizedPayload);
    const provenance = provenanceOf(normalizedPayload);
    const policy = policyFor(
      provenance.hostname,
      args.policies,
      sanitized.minimizedFields,
      limits.defaultRetentionDays,
    );
    const externalId = boundedString(record?.externalId, MAX_EXTERNAL_ID_BYTES);

    let ingestStatus: PreparedRawSourceRow["ingestStatus"] = "ACCEPTED";
    let dispositionCode: RawSourceDispositionCode | null = null;
    if (jsonInvalid) {
      ingestStatus = "REJECTED";
      dispositionCode = "INVALID_JSON";
    } else if (sanitized.error) {
      ingestStatus = "REJECTED";
      dispositionCode = sanitized.error;
    } else if (provenance.invalid) {
      ingestStatus = "QUARANTINED";
      dispositionCode = "INVALID_PROVENANCE";
    } else if (policy.missing) {
      ingestStatus = "QUARANTINED";
      dispositionCode = "SOURCE_POLICY_MISSING";
    } else if (!policy.purposeAllowed) {
      ingestStatus = "QUARANTINED";
      dispositionCode = "SOURCE_POLICY_PURPOSE_NOT_ALLOWED";
    } else if (policy.snapshot.reviewStatus !== "APPROVED") {
      ingestStatus = "QUARANTINED";
      dispositionCode = "SOURCE_POLICY_SUSPENDED";
    } else if (originalPayloadBytes > limits.maxRecordBytes) {
      ingestStatus = "QUARANTINED";
      dispositionCode = "PAYLOAD_TOO_LARGE";
    } else if (batchBytes > limits.maxBatchBytes) {
      ingestStatus = "QUARANTINED";
      dispositionCode = "BATCH_LIMIT_EXCEEDED";
    }

    const payload =
      ingestStatus === "ACCEPTED"
        ? normalizedPayload
        : minimalReceipt(
            ingestStatus,
            dispositionCode!,
            originalPayloadHash,
            originalPayloadBytes,
          );
    const persistedCanonical = canonicalJson(payload);
    const payloadHash = rawPayloadHash(payload);
    const payloadBytes = Buffer.byteLength(persistedCanonical, "utf8");
    const ingestKey = ingestKeyFor(payload, payloadHash);
    return {
      externalId: ingestStatus === "ACCEPTED" ? externalId : null,
      payload,
      sourceUrl: provenance.sourceUrl,
      fetchedAt: provenance.fetchedAt,
      contentHash: provenance.contentHash,
      parserVersion: provenance.parserVersion,
      ingestKey,
      payloadHash,
      payloadBytes: Math.max(payloadBytes, 1),
      ingestVersion: RAW_SOURCE_INGEST_VERSION,
      ingestStatus,
      dispositionCode,
      retentionDays: policy.retentionDays,
      expiresAt: new Date(now.getTime() + policy.retentionDays * 86_400_000),
      sourcePolicySnapshot: policy.snapshot,
    };
  });
  return { rows };
}

function receiptHash(receipt: ExistingRawSourceReceipt): string {
  try {
    return rawPayloadHash(receipt.payload);
  } catch {
    return receipt.payloadHash ?? sha256(diagnosticShape(receipt.payload));
  }
}

const RAW_SOURCE_RECORD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RAW_SOURCE_PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const EXISTING_RECEIPT_KEYS = Object.freeze([
  "externalId",
  "id",
  "ingestKey",
  "payload",
  "payloadHash",
]);
const PREPARED_ROW_KEYS = Object.freeze([
  "externalId",
  "payload",
  "sourceUrl",
  "fetchedAt",
  "contentHash",
  "parserVersion",
  "ingestKey",
  "payloadHash",
  "payloadBytes",
  "ingestVersion",
  "ingestStatus",
  "dispositionCode",
  "retentionDays",
  "expiresAt",
  "sourcePolicySnapshot",
]);
const IMMUTABLE_DATE_EPOCHS = new WeakMap<object, number>();

type IndexedResolutionFact =
  | Readonly<{
      kind: "EXISTING";
      rawRecordId: string;
      receipt: ExistingRawSourceReceipt;
    }>
  | Readonly<{
      kind: "BATCH";
      sourceRecordIndex: number;
      receipt: ExistingRawSourceReceipt;
    }>;

function invalidIndexedResolution(): never {
  throw new Error("RAW_SOURCE_INDEXED_RESOLUTION_INVALID");
}

function exactStringOrNull(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function snapshotDenseArray<T>(
  value: unknown,
  snapshotItem: (item: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    invalidIndexedResolution();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const length = (descriptors as Record<string, PropertyDescriptor>)["length"]
    ?.value;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    keys.length !== length + 1 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9][0-9]*)$/u.test(key)),
    )
  ) {
    invalidIndexedResolution();
  }
  const items = Array.from({ length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalidIndexedResolution();
    }
    return snapshotItem(descriptor.value);
  });
  return Object.freeze(items);
}

function snapshotJsonValue(
  value: unknown,
  state: BoundedTraversal = { ancestors: new Set<object>(), remaining: 1_000 },
  depth = 0,
): unknown {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > 32) invalidIndexedResolution();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidIndexedResolution();
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value)) {
    invalidIndexedResolution();
  }
  if (state.ancestors.has(value)) invalidIndexedResolution();
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return snapshotDenseArray(value, (item) =>
        snapshotJsonValue(item, state, depth + 1),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidIndexedResolution();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > 128 ||
      keys.some((key) => typeof key !== "string") ||
      Object.values(descriptors).some(
        (descriptor) => !descriptor.enumerable || !("value" in descriptor),
      )
    ) {
      invalidIndexedResolution();
    }
    const snapshot = Object.create(prototype) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const item = descriptors[key];
      if (!item || !("value" in item)) invalidIndexedResolution();
      snapshot[key] = snapshotJsonValue(item.value, state, depth + 1);
    }
    return Object.freeze(snapshot);
  } finally {
    state.ancestors.delete(value);
  }
}

function immutableDateSnapshot(epoch: number): Date {
  const target = new Date(epoch);
  Object.freeze(target);
  const immutableDateMutation = () => {
    throw new TypeError("immutable Raw Source Date");
  };
  const snapshot = new Proxy(target, {
    defineProperty: immutableDateMutation,
    deleteProperty: immutableDateMutation,
    get(date, property) {
      if (typeof property === "string" && property.startsWith("set")) {
        return immutableDateMutation;
      }
      if (property === "constructor") return Date;
      const member = Reflect.get(date, property, date) as unknown;
      return typeof member === "function" ? member.bind(date) : member;
    },
    set: immutableDateMutation,
    setPrototypeOf: immutableDateMutation,
  });
  IMMUTABLE_DATE_EPOCHS.set(snapshot, epoch);
  return snapshot;
}

function snapshotDate(value: unknown): Date {
  if (value && typeof value === "object") {
    const knownEpoch = IMMUTABLE_DATE_EPOCHS.get(value);
    if (knownEpoch !== undefined) return immutableDateSnapshot(knownEpoch);
  }
  if (
    !(value instanceof Date) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    invalidIndexedResolution();
  }
  let epoch: number;
  try {
    epoch = Date.prototype.getTime.call(value);
  } catch {
    invalidIndexedResolution();
  }
  if (!Number.isFinite(epoch)) invalidIndexedResolution();
  return immutableDateSnapshot(epoch);
}

function closedRecordDescriptors(
  value: unknown,
  requiredKeys: readonly string[],
): Record<string, PropertyDescriptor> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalidIndexedResolution();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string") ||
    keys.length !== requiredKeys.length ||
    !requiredKeys.every((key) => keys.includes(key)) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  ) {
    invalidIndexedResolution();
  }
  return descriptors;
}

function snapshotPreparedRawSourceRow(value: unknown): PreparedRawSourceRow {
  const descriptors = closedRecordDescriptors(value, PREPARED_ROW_KEYS);
  const fetchedAt = descriptors.fetchedAt?.value;
  const snapshot = {
    externalId: descriptors.externalId?.value,
    payload: snapshotJsonValue(descriptors.payload?.value),
    sourceUrl: descriptors.sourceUrl?.value,
    fetchedAt: fetchedAt === null ? null : snapshotDate(fetchedAt),
    contentHash: descriptors.contentHash?.value,
    parserVersion: descriptors.parserVersion?.value,
    ingestKey: descriptors.ingestKey?.value,
    // This is opaque database evidence. PostgreSQL JSONB canonicalization can
    // differ from JavaScript JSON; never compare it to the cloned payload here.
    payloadHash: descriptors.payloadHash?.value,
    payloadBytes: descriptors.payloadBytes?.value,
    ingestVersion: descriptors.ingestVersion?.value,
    ingestStatus: descriptors.ingestStatus?.value,
    dispositionCode: descriptors.dispositionCode?.value,
    retentionDays: descriptors.retentionDays?.value,
    expiresAt: snapshotDate(descriptors.expiresAt?.value),
    sourcePolicySnapshot: snapshotJsonValue(
      descriptors.sourcePolicySnapshot?.value,
    ),
  };
  if (
    !exactStringOrNull(snapshot.externalId) ||
    !exactStringOrNull(snapshot.sourceUrl) ||
    !exactStringOrNull(snapshot.contentHash) ||
    !exactStringOrNull(snapshot.parserVersion) ||
    typeof snapshot.ingestKey !== "string" ||
    snapshot.ingestKey.length === 0 ||
    typeof snapshot.payloadHash !== "string" ||
    !RAW_SOURCE_PAYLOAD_HASH_PATTERN.test(snapshot.payloadHash) ||
    !Number.isSafeInteger(snapshot.payloadBytes) ||
    snapshot.payloadBytes < 1 ||
    snapshot.ingestVersion !== RAW_SOURCE_INGEST_VERSION ||
    !["ACCEPTED", "QUARANTINED", "REJECTED"].includes(
      snapshot.ingestStatus,
    ) ||
    (snapshot.dispositionCode !== null &&
      typeof snapshot.dispositionCode !== "string") ||
    !Number.isSafeInteger(snapshot.retentionDays) ||
    snapshot.retentionDays < 1 ||
    !plainRecord(snapshot.sourcePolicySnapshot)
  ) {
    invalidIndexedResolution();
  }
  return Object.freeze(snapshot) as PreparedRawSourceRow;
}

function snapshotExistingRawSourceReceipts(
  existing: unknown,
): readonly ExistingRawSourceReceipt[] {
  const ids = new Set<string>();
  const ingestKeys = new Set<string>();
  const externalIds = new Set<string>();

  try {
    return snapshotDenseArray(existing, (value) => {
      const descriptors = closedRecordDescriptors(value, EXISTING_RECEIPT_KEYS);
      const id = descriptors.id?.value;
      const externalId = descriptors.externalId?.value;
      const ingestKey = descriptors.ingestKey?.value;
      const payloadHash = descriptors.payloadHash?.value;
      if (
        typeof id !== "string" ||
        !RAW_SOURCE_RECORD_ID_PATTERN.test(id) ||
        !exactStringOrNull(externalId) ||
        !exactStringOrNull(ingestKey) ||
        (payloadHash !== null &&
          (typeof payloadHash !== "string" ||
            !RAW_SOURCE_PAYLOAD_HASH_PATTERN.test(payloadHash))) ||
        (externalId === null && ingestKey === null) ||
        ids.has(id) ||
        (ingestKey !== null && ingestKeys.has(ingestKey)) ||
        (externalId !== null && externalIds.has(externalId))
      ) {
        invalidIndexedResolution();
      }
      const payload = snapshotJsonValue(descriptors.payload?.value);
      rawPayloadHash(payload);
      ids.add(id);
      if (ingestKey !== null) ingestKeys.add(ingestKey);
      if (externalId !== null) externalIds.add(externalId);
      return Object.freeze({ id, externalId, ingestKey, payloadHash, payload });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RAW_SOURCE_INDEXED_RESOLUTION_INVALID"
    ) {
      throw error;
    }
    invalidIndexedResolution();
  }
}

function sameResolutionFact(
  left: IndexedResolutionFact,
  right: IndexedResolutionFact,
): boolean {
  return left.kind === "EXISTING" && right.kind === "EXISTING"
    ? left.rawRecordId === right.rawRecordId
    : left.kind === "BATCH" && right.kind === "BATCH"
      ? left.sourceRecordIndex === right.sourceRecordIndex
      : false;
}

function resolutionForFact(
  recordIndex: number,
  fact: IndexedResolutionFact,
): RawSourceIndexedResolution {
  return fact.kind === "EXISTING"
    ? Object.freeze({
        recordIndex,
        kind: "EXISTING" as const,
        rawRecordId: fact.rawRecordId,
      })
    : Object.freeze({
        recordIndex,
        kind: "REUSE_BATCH" as const,
        sourceRecordIndex: fact.sourceRecordIndex,
      });
}

function driftRowForIndexedResolution(
  candidate: PreparedRawSourceRow,
  prior: IndexedResolutionFact,
): PreparedRawSourceRow {
  const driftPayload = minimalReceipt(
    "QUARANTINED",
    "PROCESSING_KEY_DRIFT",
    candidate.payloadHash,
    candidate.payloadBytes,
    prior.kind === "EXISTING" ? prior.rawRecordId : undefined,
  );
  const payloadHash = rawPayloadHash(driftPayload);
  return {
    ...candidate,
    externalId: null,
    ingestKey: ingestKeyFor(driftPayload, payloadHash),
    ingestStatus: "QUARANTINED",
    dispositionCode: "PROCESSING_KEY_DRIFT",
    payload: driftPayload,
    payloadHash,
    payloadBytes: Buffer.byteLength(canonicalJson(driftPayload), "utf8"),
  };
}

export function resolveRawSourceBatchByIndex(
  prepared: readonly PreparedRawSourceRow[],
  existing: readonly ExistingRawSourceReceipt[],
): readonly RawSourceIndexedResolution[] {
  const byKey = new Map<string, IndexedResolutionFact>();
  const byExternalId = new Map<string, IndexedResolutionFact>();
  let preparedSnapshot: readonly PreparedRawSourceRow[];
  let existingSnapshot: readonly ExistingRawSourceReceipt[];
  try {
    preparedSnapshot = snapshotDenseArray(prepared, snapshotPreparedRawSourceRow);
    existingSnapshot = snapshotExistingRawSourceReceipts(existing);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "RAW_SOURCE_INDEXED_RESOLUTION_INVALID"
    ) {
      throw error;
    }
    invalidIndexedResolution();
  }

  for (const receipt of existingSnapshot) {
    const fact: IndexedResolutionFact = Object.freeze({
      kind: "EXISTING",
      rawRecordId: receipt.id,
      receipt,
    });
    if (receipt.ingestKey) byKey.set(receipt.ingestKey, fact);
    if (receipt.externalId) byExternalId.set(receipt.externalId, fact);
  }

  const lookup = (candidate: PreparedRawSourceRow) => {
    const byIngestKey = byKey.get(candidate.ingestKey);
    const byExternal = candidate.externalId
      ? byExternalId.get(candidate.externalId)
      : undefined;
    if (
      byIngestKey &&
      byExternal &&
      !sameResolutionFact(byIngestKey, byExternal)
    ) {
      invalidIndexedResolution();
    }
    return byIngestKey ?? byExternal;
  };

  const rememberWrite = (recordIndex: number, row: PreparedRawSourceRow) => {
    const fact: IndexedResolutionFact = Object.freeze({
      kind: "BATCH",
      sourceRecordIndex: recordIndex,
      receipt: {
        id: "pending",
        externalId: row.externalId,
        ingestKey: row.ingestKey,
        payloadHash: row.payloadHash,
        payload: row.payload,
      },
    });
    byKey.set(row.ingestKey, fact);
    if (row.externalId) byExternalId.set(row.externalId, fact);
  };

  const resolutions = preparedSnapshot.map((candidate, recordIndex) => {
    const prior = lookup(candidate);
    if (!prior) {
      rememberWrite(recordIndex, candidate);
      return Object.freeze({
        recordIndex,
        kind: "WRITE" as const,
        row: candidate,
      });
    }
    if (receiptHash(prior.receipt) === candidate.payloadHash) {
      return resolutionForFact(recordIndex, prior);
    }

    const drift = snapshotPreparedRawSourceRow(
      driftRowForIndexedResolution(candidate, prior),
    );
    const priorDrift = lookup(drift);
    if (priorDrift) {
      if (receiptHash(priorDrift.receipt) !== drift.payloadHash) {
        invalidIndexedResolution();
      }
      return resolutionForFact(recordIndex, priorDrift);
    }
    rememberWrite(recordIndex, drift);
    return Object.freeze({
      recordIndex,
      kind: "WRITE" as const,
      row: drift,
    });
  });

  return Object.freeze(resolutions);
}

export function reconcileRawSourceBatch(
  prepared: readonly PreparedRawSourceRow[],
  existing: readonly ExistingRawSourceReceipt[],
): {
  rows: PreparedRawSourceRow[];
  acceptedCount: number;
  quarantinedCount: number;
  rejectedCount: number;
  duplicateCount: number;
} {
  const byKey = new Map(
    existing.flatMap((row) =>
      row.ingestKey ? [[row.ingestKey, row] as const] : [],
    ),
  );
  const byExternalId = new Map(
    existing.flatMap((row) =>
      row.externalId ? [[row.externalId, row] as const] : [],
    ),
  );
  const rows: PreparedRawSourceRow[] = [];
  let duplicateCount = 0;

  for (const candidate of prepared) {
    const prior =
      byKey.get(candidate.ingestKey) ??
      (candidate.externalId
        ? byExternalId.get(candidate.externalId)
        : undefined);
    if (!prior) {
      rows.push(candidate);
      const pending: ExistingRawSourceReceipt = {
        id: "pending",
        externalId: candidate.externalId,
        ingestKey: candidate.ingestKey,
        payloadHash: candidate.payloadHash,
        payload: candidate.payload,
      };
      byKey.set(candidate.ingestKey, pending);
      if (candidate.externalId) byExternalId.set(candidate.externalId, pending);
      continue;
    }
    if (receiptHash(prior) === candidate.payloadHash) {
      duplicateCount += 1;
      continue;
    }
    const conflictWithRawId =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        prior.id,
      )
        ? prior.id
        : undefined;
    const driftPayload = minimalReceipt(
      "QUARANTINED",
      "PROCESSING_KEY_DRIFT",
      candidate.payloadHash,
      candidate.payloadBytes,
      conflictWithRawId,
    );
    const driftPayloadHash = rawPayloadHash(driftPayload);
    const driftKey = ingestKeyFor(driftPayload, driftPayloadHash);
    if (byKey.has(driftKey)) {
      duplicateCount += 1;
      continue;
    }
    const drift: PreparedRawSourceRow = {
      ...candidate,
      externalId: null,
      ingestKey: driftKey,
      ingestStatus: "QUARANTINED",
      dispositionCode: "PROCESSING_KEY_DRIFT",
      payload: driftPayload,
      payloadHash: driftPayloadHash,
      payloadBytes: Buffer.byteLength(canonicalJson(driftPayload), "utf8"),
    };
    rows.push(drift);
    byKey.set(driftKey, {
      id: "pending",
      externalId: null,
      ingestKey: driftKey,
      payloadHash: drift.payloadHash,
      payload: drift.payload,
    });
  }

  return {
    rows,
    acceptedCount: rows.filter((row) => row.ingestStatus === "ACCEPTED").length,
    quarantinedCount: rows.filter((row) => row.ingestStatus === "QUARANTINED")
      .length,
    rejectedCount: rows.filter((row) => row.ingestStatus === "REJECTED").length,
    duplicateCount,
  };
}
