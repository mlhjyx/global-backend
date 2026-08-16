import { createHash } from 'node:crypto';

export const RAW_SOURCE_INGEST_VERSION = 'raw-source/v2' as const;

export type RawSourceIngestStatus = 'ACCEPTED' | 'QUARANTINED' | 'REJECTED' | 'EXPIRED';

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
  ingestStatus: Exclude<RawSourceIngestStatus, 'EXPIRED'>;
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

const DEFAULT_MAX_RECORD_BYTES = 512 * 1024;
const DEFAULT_MAX_BATCH_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 365;
const MAX_CONFIGURED_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_CONFIGURED_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_RETENTION_DAYS = 3_650;
const MAX_EXTERNAL_ID_BYTES = 512;
const MAX_SOURCE_URL_BYTES = 2_048;
const MAX_PROVENANCE_TOKEN_BYTES = 256;

class InvalidRawJsonError extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedPositiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

export function rawSourceIngestLimits(env: NodeJS.ProcessEnv = process.env): RawSourceIngestLimits {
  return {
    maxRecordBytes: boundedPositiveInteger(env.RAW_SOURCE_MAX_RECORD_BYTES, DEFAULT_MAX_RECORD_BYTES, MAX_CONFIGURED_RECORD_BYTES),
    maxBatchBytes: boundedPositiveInteger(env.RAW_SOURCE_MAX_BATCH_BYTES, DEFAULT_MAX_BATCH_BYTES, MAX_CONFIGURED_BATCH_BYTES),
    defaultRetentionDays: boundedPositiveInteger(env.RAW_SOURCE_DEFAULT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS),
  };
}

function strictCanonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidRawJsonError('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new InvalidRawJsonError(`unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new InvalidRawJsonError('cyclic object');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return '[' + value.map((item) => strictCanonicalJson(item, ancestors)).join(',') + ']';
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidRawJsonError('non-plain object');
    }
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + strictCanonicalJson(item, ancestors))
        .join(',') +
      '}'
    );
  } finally {
    ancestors.delete(value);
  }
}

function diagnosticDescriptor(value: unknown, seen = new Map<object, number>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `[number:${String(value)}]`;
  if (typeof value === 'bigint') return `[bigint:${value.toString()}]`;
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return `[symbol:${value.description ?? ''}]`;
  if (typeof value !== 'object') return `[${typeof value}]`;
  const prior = seen.get(value);
  if (prior !== undefined) return `[cycle:${prior}]`;
  seen.set(value, seen.size);
  if (Array.isArray(value)) return '[' + value.map((item) => diagnosticDescriptor(item, seen)).join(',') + ']';
  return (
    '{' +
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + diagnosticDescriptor(item, seen))
      .join(',') +
    '}'
  );
}

export function rawPayloadHash(value: unknown): string {
  return sha256(strictCanonicalJson(payloadHashBasis(value)));
}

function payloadHashBasis(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return value;
  const { fetchedAt: _fetchedAt, ...stableProvenance } = provenance as Record<string, unknown>;
  return { ...record, provenance: stableProvenance };
}

function normalizedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  return normalized || null;
}

function trimmedText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized || null;
}

function normalizedDomain(value: unknown): string | null {
  const raw = trimmedText(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./u, '') || null;
  } catch {
    return null;
  }
}

function identifierBasis(record: Record<string, unknown>): string[] {
  const values: unknown[] = [];
  if (record.identifier) values.push(record.identifier);
  if (Array.isArray(record.identifiers)) values.push(...record.identifiers);
  return values
    .flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      const scheme = normalizedText(item.scheme);
      const identifierValue = trimmedText(item.value);
      if (!scheme || !identifierValue) return [];
      return [`${scheme}:${trimmedText(item.jurisdiction)?.toUpperCase() ?? 'GLOBAL'}:${identifierValue}`];
    })
    .sort();
}

function deriveIngestKey(record: unknown, payloadHash: string): string {
  if (!record || typeof record !== 'object') return `payload:${payloadHash}`;
  const item = record as Record<string, unknown>;
  const externalId = trimmedText(item.externalId);
  if (externalId) return `external:${sha256(externalId)}`;

  const domain = normalizedDomain(item.domain);
  const identifiers = identifierBasis(item);
  const name = normalizedText(item.name);
  const country = trimmedText(item.country)?.toUpperCase() ?? null;
  if (domain || identifiers.length || name) {
    return `identity:${sha256(strictCanonicalJson({ country, domain, identifiers, name }))}`;
  }
  return `payload:${payloadHash}`;
}

function boundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes) return null;
  return normalized;
}

function parseProvenance(record: unknown): {
  sourceUrl: string | null;
  fetchedAt: Date | null;
  contentHash: string | null;
  parserVersion: string | null;
  invalid: boolean;
  domain: string | null;
} {
  if (!record || typeof record !== 'object') {
    return {
      sourceUrl: null,
      fetchedAt: null,
      contentHash: null,
      parserVersion: null,
      invalid: false,
      domain: null,
    };
  }
  const provenance = (record as Record<string, unknown>).provenance;
  if (provenance === undefined) {
    return {
      sourceUrl: null,
      fetchedAt: null,
      contentHash: null,
      parserVersion: null,
      invalid: false,
      domain: null,
    };
  }
  if (!provenance || typeof provenance !== 'object') {
    return {
      sourceUrl: null,
      fetchedAt: null,
      contentHash: null,
      parserVersion: null,
      invalid: true,
      domain: null,
    };
  }
  const item = provenance as Record<string, unknown>;
  const sourceUrl = boundedString(item.sourceUrl, MAX_SOURCE_URL_BYTES);
  const fetchedAtText = boundedString(item.fetchedAt, 128);
  const fetchedAt = fetchedAtText ? new Date(fetchedAtText) : null;
  const contentHash = boundedString(item.contentHash, MAX_PROVENANCE_TOKEN_BYTES);
  const parserVersion = boundedString(item.parserVersion, MAX_PROVENANCE_TOKEN_BYTES);
  let domain: string | null = null;
  try {
    if (sourceUrl) {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      domain = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    }
  } catch {
    domain = null;
  }
  const invalid = !sourceUrl || !fetchedAt || Number.isNaN(fetchedAt.getTime()) || !contentHash || !parserVersion || !domain;
  return { sourceUrl, fetchedAt, contentHash, parserVersion, invalid, domain };
}

function retentionFor(
  domain: string | null,
  policies: RawSourcePolicySnapshot[],
  limits: RawSourceIngestLimits,
): { retentionDays: number; snapshot: Record<string, unknown> } {
  const policy = domain
    ? policies
        .filter((candidate) => {
          const policyDomain = candidate.domain.toLowerCase().replace(/^www\./u, '');
          return policyDomain === domain || domain.endsWith(`.${policyDomain}`);
        })
        .sort((left, right) => right.domain.length - left.domain.length)[0]
    : undefined;
  const retentionDays = Math.min(Math.max(1, policy?.retentionDays ?? limits.defaultRetentionDays), MAX_RETENTION_DAYS);
  if (!policy) return { retentionDays, snapshot: { kind: 'default', retentionDays } };
  return {
    retentionDays,
    snapshot: {
      kind: 'source_policy',
      id: policy.id,
      domain: policy.domain,
      retentionDays,
      reviewStatus: policy.reviewStatus,
      updatedAt: policy.updatedAt.toISOString(),
    },
  };
}

function receipt(status: 'QUARANTINED' | 'REJECTED', reason: string, extra?: Record<string, unknown>) {
  return {
    _rawReceipt: status === 'QUARANTINED' ? 'raw-source/quarantine-v1' : 'raw-source/rejected-v1',
    reason,
    ...extra,
  };
}

export function prepareRawSourceBatch(args: {
  providerKey: string;
  records: unknown[];
  policies: RawSourcePolicySnapshot[];
  limits?: RawSourceIngestLimits;
  now?: Date;
}): { rows: PreparedRawSourceRow[] } {
  const limits = args.limits ?? rawSourceIngestLimits();
  const now = args.now ?? new Date();
  let batchBytes = 0;
  const rows = args.records.map((record): PreparedRawSourceRow => {
    let canonical: string;
    let normalizedPayload: unknown = null;
    let invalidJson = false;
    try {
      canonical = strictCanonicalJson(record);
      normalizedPayload = JSON.parse(canonical) as unknown;
    } catch {
      invalidJson = true;
      canonical = diagnosticDescriptor(record);
    }
    const payloadBytes = Buffer.byteLength(canonical, 'utf8');
    const payloadHash = invalidJson ? sha256(canonical) : rawPayloadHash(normalizedPayload);
    const ingestKey = deriveIngestKey(record, payloadHash);
    batchBytes += payloadBytes;

    const externalIdValue = record && typeof record === 'object' ? (record as Record<string, unknown>).externalId : undefined;
    const externalId = boundedString(externalIdValue, MAX_EXTERNAL_ID_BYTES);
    const externalIdTooLong =
      typeof externalIdValue === 'string' && Buffer.byteLength(externalIdValue.trim(), 'utf8') > MAX_EXTERNAL_ID_BYTES;
    const provenance = parseProvenance(record);
    const retention = retentionFor(provenance.domain, args.policies, limits);

    let ingestStatus: PreparedRawSourceRow['ingestStatus'] = 'ACCEPTED';
    let dispositionCode: string | null = null;
    if (invalidJson) {
      ingestStatus = 'REJECTED';
      dispositionCode = 'INVALID_JSON';
    } else if (externalIdTooLong) {
      ingestStatus = 'QUARANTINED';
      dispositionCode = 'EXTERNAL_ID_TOO_LONG';
    } else if (retention.snapshot.reviewStatus === 'SUSPENDED') {
      ingestStatus = 'QUARANTINED';
      dispositionCode = 'SOURCE_POLICY_SUSPENDED';
    } else if (provenance.invalid) {
      ingestStatus = 'QUARANTINED';
      dispositionCode = 'INVALID_PROVENANCE';
    } else if (payloadBytes > limits.maxRecordBytes) {
      ingestStatus = 'QUARANTINED';
      dispositionCode = 'PAYLOAD_TOO_LARGE';
    } else if (batchBytes > limits.maxBatchBytes) {
      ingestStatus = 'QUARANTINED';
      dispositionCode = 'BATCH_LIMIT_EXCEEDED';
    }

    const payload =
      ingestStatus === 'ACCEPTED'
        ? normalizedPayload
        : receipt(ingestStatus, dispositionCode!, {
            originalPayloadHash: payloadHash,
            originalPayloadBytes: payloadBytes,
          });
    return {
      externalId: ingestStatus === 'ACCEPTED' ? externalId : null,
      payload,
      sourceUrl: provenance.sourceUrl,
      fetchedAt: provenance.fetchedAt,
      contentHash: provenance.contentHash,
      parserVersion: provenance.parserVersion,
      ingestKey,
      payloadHash,
      payloadBytes,
      ingestVersion: RAW_SOURCE_INGEST_VERSION,
      ingestStatus,
      dispositionCode,
      retentionDays: retention.retentionDays,
      expiresAt: new Date(now.getTime() + retention.retentionDays * 24 * 60 * 60 * 1_000),
      sourcePolicySnapshot: retention.snapshot,
    };
  });
  return { rows };
}

export function rawDriftIngestKey(ingestKey: string, payloadHash: string): string {
  return `drift:${sha256(`${ingestKey}:${payloadHash}`)}`;
}

function existingPayloadHash(row: ExistingRawSourceReceipt): string {
  if (row.payloadHash) return row.payloadHash;
  try {
    return rawPayloadHash(row.payload);
  } catch {
    return sha256(diagnosticDescriptor(row.payload));
  }
}

export function reconcileRawSourceBatch(
  prepared: PreparedRawSourceRow[],
  existing: ExistingRawSourceReceipt[],
): {
  rows: PreparedRawSourceRow[];
  acceptedCount: number;
  quarantinedCount: number;
  rejectedCount: number;
  duplicateCount: number;
} {
  const byKey = new Map(existing.flatMap((row) => (row.ingestKey ? [[row.ingestKey, row] as const] : [])));
  const byExternalId = new Map(existing.flatMap((row) => (row.externalId ? [[row.externalId, row] as const] : [])));
  const rows: PreparedRawSourceRow[] = [];
  let duplicateCount = 0;

  for (const candidate of prepared) {
    const prior = byKey.get(candidate.ingestKey) ?? (candidate.externalId ? byExternalId.get(candidate.externalId) : undefined);
    if (!prior) {
      rows.push(candidate);
      byKey.set(candidate.ingestKey, {
        id: 'pending',
        externalId: candidate.externalId,
        ingestKey: candidate.ingestKey,
        payloadHash: candidate.payloadHash,
        payload: candidate.payload,
      });
      if (candidate.externalId) byExternalId.set(candidate.externalId, byKey.get(candidate.ingestKey)!);
      continue;
    }
    if (existingPayloadHash(prior) === candidate.payloadHash) {
      duplicateCount += 1;
      continue;
    }

    const driftKey = rawDriftIngestKey(candidate.ingestKey, candidate.payloadHash);
    if (byKey.has(driftKey)) {
      duplicateCount += 1;
      continue;
    }
    const drift: PreparedRawSourceRow = {
      ...candidate,
      externalId: null,
      ingestKey: driftKey,
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'PROCESSING_KEY_DRIFT',
      payload: receipt('QUARANTINED', 'PROCESSING_KEY_DRIFT', {
        originalPayloadHash: candidate.payloadHash,
        originalPayloadBytes: candidate.payloadBytes,
        conflictWithRawId: prior.id,
      }),
    };
    rows.push(drift);
    byKey.set(driftKey, {
      id: 'pending',
      externalId: null,
      ingestKey: driftKey,
      payloadHash: drift.payloadHash,
      payload: drift.payload,
    });
  }

  return {
    rows,
    acceptedCount: rows.filter((row) => row.ingestStatus === 'ACCEPTED').length,
    quarantinedCount: rows.filter((row) => row.ingestStatus === 'QUARANTINED').length,
    rejectedCount: rows.filter((row) => row.ingestStatus === 'REJECTED').length,
    duplicateCount,
  };
}
