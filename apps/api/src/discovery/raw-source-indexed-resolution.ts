import { types } from "node:util";
import type {
  ExistingRawSourceReceipt,
  PreparedRawSourceRow,
} from "./raw-source-ingestion";

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
const DATE_READ_METHODS = Object.freeze([
  "getDate",
  "getDay",
  "getFullYear",
  "getHours",
  "getMilliseconds",
  "getMinutes",
  "getMonth",
  "getSeconds",
  "getTime",
  "getTimezoneOffset",
  "getUTCDate",
  "getUTCDay",
  "getUTCFullYear",
  "getUTCHours",
  "getUTCMilliseconds",
  "getUTCMinutes",
  "getUTCMonth",
  "getUTCSeconds",
  "getYear",
  "toDateString",
  "toISOString",
  "toJSON",
  "toLocaleDateString",
  "toLocaleString",
  "toLocaleTimeString",
  "toString",
  "toTimeString",
  "toUTCString",
  "valueOf",
] as const);

type DateReadMethod = (typeof DATE_READ_METHODS)[number];
type DateIntrinsic = (this: Date, ...args: unknown[]) => unknown;

function captureDateIntrinsic(property: string | symbol): DateIntrinsic {
  const descriptor = Object.getOwnPropertyDescriptor(Date.prototype, property);
  const method = descriptor && "value" in descriptor ? descriptor.value : null;
  if (typeof method !== "function") {
    throw new Error("RAW_SOURCE_DATE_INTRINSIC_UNAVAILABLE");
  }
  return method as DateIntrinsic;
}

const CAPTURED_DATE_METHODS = Object.freeze(
  Object.fromEntries(
    DATE_READ_METHODS.map((method) => [method, captureDateIntrinsic(method)]),
  ),
) as Readonly<Record<DateReadMethod, DateIntrinsic>>;
const CAPTURED_DATE_TO_PRIMITIVE = captureDateIntrinsic(Symbol.toPrimitive);
const IMMUTABLE_DATE_EPOCHS = new WeakMap<object, number>();

interface BoundedTraversal {
  ancestors: Set<object>;
  remaining: number;
}

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

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
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
  const bindCaptured = (method: DateIntrinsic) => method.bind(target) as unknown;
  const snapshot = new Proxy(target, {
    defineProperty: immutableDateMutation,
    deleteProperty: immutableDateMutation,
    get(_date, property) {
      if (typeof property === "string" && property.startsWith("set")) {
        return immutableDateMutation;
      }
      if (property === "constructor") return Date;
      if (property === Symbol.toPrimitive) {
        return bindCaptured(CAPTURED_DATE_TO_PRIMITIVE);
      }
      if (
        typeof property === "string" &&
        DATE_READ_METHODS.includes(property as never)
      ) {
        const method =
          property === "toJSON"
            ? CAPTURED_DATE_METHODS.toISOString
            : CAPTURED_DATE_METHODS[property as DateReadMethod];
        return bindCaptured(method);
      }
      return undefined;
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
    epoch = CAPTURED_DATE_METHODS.getTime.call(value) as number;
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
    snapshot.ingestVersion !== "raw-source/v2" ||
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
  rawPayloadHash: (payload: unknown) => string,
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

/** @internal Kept behind raw-source-ingestion.ts's stable public wrapper. */
export function createRawSourceIndexedResolver(deps: Readonly<{
  rawPayloadHash: (payload: unknown) => string;
  receiptHash: (receipt: ExistingRawSourceReceipt) => string;
  driftRow: (
    candidate: PreparedRawSourceRow,
    conflictWithRawId: string | undefined,
  ) => PreparedRawSourceRow;
}>): (
  prepared: readonly PreparedRawSourceRow[],
  existing: readonly ExistingRawSourceReceipt[],
) => readonly RawSourceIndexedResolution[] {
  return (prepared, existing) => {
    const byKey = new Map<string, IndexedResolutionFact>();
    const byExternalId = new Map<string, IndexedResolutionFact>();
    let preparedSnapshot: readonly PreparedRawSourceRow[];
    let existingSnapshot: readonly ExistingRawSourceReceipt[];
    try {
      preparedSnapshot = snapshotDenseArray(
        prepared,
        snapshotPreparedRawSourceRow,
      );
      existingSnapshot = snapshotExistingRawSourceReceipts(
        existing,
        deps.rawPayloadHash,
      );
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
      if (deps.receiptHash(prior.receipt) === candidate.payloadHash) {
        return resolutionForFact(recordIndex, prior);
      }

      const drift = snapshotPreparedRawSourceRow(
        deps.driftRow(
          candidate,
          prior.kind === "EXISTING" ? prior.rawRecordId : undefined,
        ),
      );
      const priorDrift = lookup(drift);
      if (priorDrift) {
        if (deps.receiptHash(priorDrift.receipt) !== drift.payloadHash) {
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
  };
}
