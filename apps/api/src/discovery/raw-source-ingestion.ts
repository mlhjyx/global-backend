import { createHash } from "node:crypto";

export const RAW_SOURCE_INGEST_VERSION = "raw-source/v2" as const;

export type RawSourceIngestStatus =
  "ACCEPTED" | "QUARANTINED" | "REJECTED" | "EXPIRED";

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
  dispositionCode: string | null;
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
const COMPANY_PAYLOAD_KEYS = new Set([
  "externalId",
  "name",
  "domain",
  "country",
  "region",
  "industry",
  "employeeCount",
  "revenueUsd",
  "attributes",
  "identifier",
  "license",
  "provenance",
  "monitoredSource",
]);
const ATTRIBUTE_ALLOWLISTS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    registry: new Set([
      "company_text",
      "employee_band",
      "employees",
      "products",
      "public_email",
    ]),
    directory: new Set([
      "detail_url",
      "listing_location",
      "source_class",
      "source_directory",
      "source_kind",
    ]),
    wikidata: new Set([
      "latitude",
      "longitude",
      "source_class",
      "wikidata_qid",
    ]),
    openstreetmap: new Set([
      "city",
      "latitude",
      "longitude",
      "osm_id",
      "osm_tags",
      "source_class",
    ]),
    trade_fair: new Set([
      "description",
      "hall",
      "hiring_signal",
      "products",
      "public_email",
      "public_phone",
      "source_class",
      "source_fair",
      "source_fair_name",
      "source_kind",
      "stand",
    ]),
    ted: new Set(["ted"]),
    openfda: new Set(["fda", "products"]),
    public_web: new Set([
      "extraction_confidence",
      "extraction_evidence",
      "keywords",
      "products",
      "source_class",
    ]),
  });
const PERSONAL_FIELD_KEYS = new Set([
  "address",
  "addresses",
  "contact",
  "contactemail",
  "contactname",
  "email",
  "emailkind",
  "ein",
  "firstname",
  "formername",
  "formernames",
  "fullname",
  "lastname",
  "person",
  "phone",
  "publicemail",
  "publicphone",
  "recipientname",
]);

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

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
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
  if (ancestors.has(value)) throw new InvalidCanonicalJsonError("cyclic value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const record = plainRecord(value);
    if (!record) throw new InvalidCanonicalJsonError("non-plain object");
    const entries = Object.entries(record)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function diagnosticShape(value: unknown, seen = new Set<object>()): string {
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
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((item) => diagnosticShape(item, seen)).join(",")}]`;
  const record = plainRecord(value);
  if (!record) return "[object]";
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}:${diagnosticShape(record[key], seen)}`)
    .join(",")}}`;
}

function hashBasis(value: unknown): unknown {
  const record = plainRecord(value);
  const provenance = plainRecord(record?.provenance);
  if (!record || !provenance) return value;
  const { fetchedAt: _observationTime, ...stableProvenance } = provenance;
  return { ...record, provenance: stableProvenance };
}

export function rawPayloadHash(value: unknown): string {
  return sha256(canonicalJson(hashBasis(value)));
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function minimizePersonalFields(
  value: unknown,
  path: string,
  removed: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      minimizePersonalFields(item, `${path}[${index}]`, removed),
    );
  }
  const record = plainRecord(value);
  if (!record) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (PERSONAL_FIELD_KEYS.has(normalizedKey(key))) {
      removed.push(itemPath);
      continue;
    }
    clean[key] = minimizePersonalFields(item, itemPath, removed);
  }
  return clean;
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
    | null;
} {
  const record = plainRecord(value);
  if (!record)
    return { value: {}, minimizedFields: [], error: "MALFORMED_PAYLOAD" };
  const attributeAllowlist = ATTRIBUTE_ALLOWLISTS[providerKey];
  if (!attributeAllowlist) {
    return {
      value: {},
      minimizedFields: [],
      error: "UNGOVERNED_PROVIDER_PAYLOAD",
    };
  }
  const unknown = Object.keys(record).filter(
    (key) =>
      !COMPANY_PAYLOAD_KEYS.has(key) ||
      (key === "monitoredSource" && providerKey !== "trade_fair"),
  );
  const allowed = Object.fromEntries(
    Object.entries(record).filter(([key]) => COMPANY_PAYLOAD_KEYS.has(key)),
  );
  const minimizedFields: string[] = [];
  if (allowed.attributes !== undefined) {
    const attributes = plainRecord(allowed.attributes);
    if (!attributes) {
      return {
        value: allowed,
        minimizedFields,
        error: "MALFORMED_PAYLOAD",
      };
    }
    allowed.attributes = Object.fromEntries(
      Object.entries(attributes).filter(([key]) => {
        if (attributeAllowlist.has(key)) return true;
        minimizedFields.push(`attributes.${key}`);
        return false;
      }),
    );
  }
  const sanitized = minimizePersonalFields(allowed, "", minimizedFields);
  const normalized = plainRecord(sanitized);
  const name = normalized?.name;
  if (typeof name !== "string" || !name.trim()) {
    return {
      value: sanitized,
      minimizedFields: minimizedFields.sort(),
      error: "MALFORMED_PAYLOAD",
    };
  }
  return {
    value: sanitized,
    minimizedFields: minimizedFields.sort(),
    error: unknown.length ? "UNKNOWN_PAYLOAD_FIELD" : null,
  };
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
      snapshot: {
        kind: "missing",
        retentionDays,
        minimizedFields: [...minimizedFields],
      },
    };
  }
  return {
    retentionDays,
    missing: false,
    snapshot: {
      kind: "source_policy",
      id: policy.id,
      domain: policy.domain,
      retentionDays,
      reviewStatus: policy.reviewStatus,
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
  reason: string,
  payloadHash: string,
  payloadBytes: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _rawReceipt:
      status === "REJECTED"
        ? "raw-source/rejected/v1"
        : "raw-source/quarantine/v1",
    reason,
    originalPayloadHash: payloadHash,
    originalPayloadBytes: payloadBytes,
    ...extra,
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
    try {
      canonicalJson(original);
    } catch {
      jsonInvalid = true;
    }
    if (jsonInvalid) {
      canonical = diagnosticShape(original);
    } else {
      try {
        canonical = canonicalJson(sanitized.value);
        normalizedPayload = JSON.parse(canonical) as unknown;
      } catch {
        jsonInvalid = true;
        canonical = diagnosticShape(sanitized.value);
      }
    }
    const payloadBytes = Buffer.byteLength(canonical, "utf8");
    const payloadHash = jsonInvalid
      ? sha256(canonical)
      : rawPayloadHash(normalizedPayload);
    const ingestKey = ingestKeyFor(normalizedPayload, payloadHash);
    batchBytes += payloadBytes;
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
    let dispositionCode: string | null = null;
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
    } else if (policy.snapshot.reviewStatus !== "APPROVED") {
      ingestStatus = "QUARANTINED";
      dispositionCode = "SOURCE_POLICY_SUSPENDED";
    } else if (payloadBytes > limits.maxRecordBytes) {
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
            payloadHash,
            payloadBytes,
          );
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

export function rawDriftIngestKey(
  ingestKey: string,
  payloadHash: string,
): string {
  return `drift:${sha256(`${ingestKey}\0${payloadHash}`)}`;
}

function receiptHash(receipt: ExistingRawSourceReceipt): string {
  if (receipt.payloadHash) return receipt.payloadHash;
  try {
    return rawPayloadHash(receipt.payload);
  } catch {
    return sha256(diagnosticShape(receipt.payload));
  }
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
    const driftKey = rawDriftIngestKey(
      candidate.ingestKey,
      candidate.payloadHash,
    );
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
      payload: minimalReceipt(
        "QUARANTINED",
        "PROCESSING_KEY_DRIFT",
        candidate.payloadHash,
        candidate.payloadBytes,
        { conflictWithRawId: prior.id },
      ),
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
