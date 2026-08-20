import { createHash } from 'node:crypto';

export const GENERIC_OPERATION_PROJECTION_VERSION =
  'generic-operation-projection/v1' as const;

const MAX_BYTES = 128 * 1024;
const MAX_STRING = 64 * 1024;
const MAX_ARRAY = 256;
const MAX_FIELDS = 512;
const MAX_DEPTH = 8;
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
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) invalid();
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
    count.fields += 1;
    if (count.fields > MAX_FIELDS) invalid();
    output[key] = normalize((value as Record<string, unknown>)[key], depth + 1, count);
  }
  return Object.freeze(output);
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
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
  const bytes = canonical(base);
  if (Buffer.byteLength(bytes, 'utf8') > MAX_BYTES) invalid();
  return Object.freeze({
    ...base,
    digest: createHash('sha256').update(bytes).digest('hex'),
  });
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
