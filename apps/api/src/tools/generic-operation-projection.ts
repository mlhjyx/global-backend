import { createHash } from 'node:crypto';

export const GENERIC_OPERATION_PROJECTION_VERSION =
  'generic-operation-projection/v1' as const;

// Typed projections reserve one KiB for this wrapper. Compact JSON remains
// below 120 KiB, while a second structural estimate accounts for PostgreSQL
// jsonb::text separator spacing up to the durable 128 KiB contract.
const MAX_BYTES = 120 * 1024;
const MAX_POSTGRES_JSONB_TEXT_BYTES = 128 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_ARRAY = 256;
// The widest registered typed shape is bounded below this value (including
// maximum arrays and every optional domain field). Bytes remain the ultimate
// aggregate bound for generic tool results.
const MAX_FIELDS = 4_096;
// Model replay wraps a typed projection inside the generic envelope. The
// provider-wire observation adds one bounded probe object below that typed
// result; total bytes (128 KiB), fields (4,096), and arrays (256, wire probes 2)
// remain independently capped.
const MAX_DEPTH = 10;
const SCHEMA = /^[a-z][a-z0-9_-]{1,63}\/v[1-9][0-9]{0,3}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SENSITIVE_KEYS = new Set([
  'authorization',
  'headers',
  'prompt',
  'rawresponse',
  'token',
]);

export interface GenericOperationProjection {
  schemaVersion: typeof GENERIC_OPERATION_PROJECTION_VERSION;
  kind: 'model' | 'tool';
  schema: string;
  data: unknown;
  digest: string;
}

function invalid(): never {
  throw new Error('GENERIC_OPERATION_PROJECTION_INVALID');
}

function normalize(value: unknown, depth: number, count: { fields: number }): unknown {
  if (depth > MAX_DEPTH) invalid();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_STRING) invalid();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) invalid();
    return Object.freeze(value.map((entry) => normalize(entry, depth + 1, count)));
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid();
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (!key || key.length > 128 || SENSITIVE_KEYS.has(key.toLowerCase())) invalid();
    const entry = (value as Record<string, unknown>)[key];
    // Match JSON object semantics for optional fields while keeping arrays
    // strict: optional provider facts are omitted, never converted to null.
    if (entry === undefined) continue;
    count.fields += 1;
    if (count.fields > MAX_FIELDS) invalid();
    output[key] = normalize(entry, depth + 1, count);
  }
  return Object.freeze(output);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function postgresJsonbTextUpperBoundBytes(value: unknown): number {
  if (value === null || typeof value === 'boolean') {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  if (typeof value === 'string') {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  if (typeof value === 'number') {
    const encoded = JSON.stringify(value);
    // PostgreSQL numeric expands exponent notation. Every accepted JavaScript
    // number is finite; 400 bytes safely covers the longest subnormal decimal.
    return /e/iu.test(encoded) ? Math.max(400, encoded.length) : encoded.length;
  }
  if (Array.isArray(value)) {
    return 2 + value.reduce(
      (total, entry, index) =>
        total + postgresJsonbTextUpperBoundBytes(entry) + (index === 0 ? 0 : 2),
      0,
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return 2 + entries.reduce(
    (total, [key, entry], index) =>
      total +
      Buffer.byteLength(JSON.stringify(key), 'utf8') +
      2 +
      postgresJsonbTextUpperBoundBytes(entry) +
      (index === 0 ? 0 : 2),
    0,
  );
}

export function projectGenericOperationResult(input: {
  kind: 'model' | 'tool';
  schema: string;
  data: unknown;
}): GenericOperationProjection {
  if ((input.kind !== 'model' && input.kind !== 'tool') || !SCHEMA.test(input.schema)) invalid();
  const data = normalize(input.data, 0, { fields: 0 });
  const base = Object.freeze({
    schemaVersion: GENERIC_OPERATION_PROJECTION_VERSION,
    kind: input.kind,
    schema: input.schema,
    data,
  });
  const projected = Object.freeze({
    ...base,
    digest: createHash('sha256').update(canonical(base)).digest('hex'),
  });
  if (
    Buffer.byteLength(canonical(projected), 'utf8') > MAX_BYTES ||
    postgresJsonbTextUpperBoundBytes(projected) > MAX_POSTGRES_JSONB_TEXT_BYTES
  ) invalid();
  return projected;
}

export function parseGenericOperationProjection(
  value: unknown,
): GenericOperationProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'data,digest,kind,schema,schemaVersion' ||
    record.schemaVersion !== GENERIC_OPERATION_PROJECTION_VERSION ||
    typeof record.digest !== 'string' ||
    !DIGEST.test(record.digest)
  ) invalid();
  const projected = projectGenericOperationResult({
    kind: record.kind as 'model' | 'tool',
    schema: String(record.schema ?? ''),
    data: record.data,
  });
  if (projected.digest !== record.digest) invalid();
  return projected;
}
