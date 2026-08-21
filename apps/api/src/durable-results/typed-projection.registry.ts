import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import type { TypedProjectionSchema } from './durable-result-strategy';
import {
  TYPED_PROJECTION_ENVELOPE_VERSION,
  type PostgresJsonbByteExecutor,
  type TypedProjectionDefinition,
  type TypedProjectionEnvelope,
} from './typed-projection.types';

const APPLICATION_MAX_BYTES = 120 * 1024;
const POSTGRES_JSONB_MAX_BYTES = 128 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const PROHIBITED_FIELD_NAMES = new Set([
  'authorization',
  'attributes',
  'apikey',
  'credential',
  'credentials',
  'cookie',
  'headers',
  'password',
  'prompt',
  'rawresponse',
  'responsebody',
  'secret',
  'token',
]);

interface RegisteredDefinition {
  readonly validate: ValidateFunction;
  readonly project: (raw: unknown) => unknown;
  readonly restore: (projected: unknown) => unknown;
}

function invalid(): never {
  throw new Error('TYPED_PROJECTION_INVALID');
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(canonicalize));
  }
  if (!plainRecord(value)) invalid();

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) invalid();
    result[key] = canonicalize(entry);
  }
  return Object.freeze(result);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function assertClosedBoundedSchema(
  value: unknown,
  path = '$',
): void {
  if (!plainRecord(value)) {
    throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}`);
  }

  const type = value.type;
  const types = Array.isArray(type) ? type : [type];
  const hasType = (expected: string) => types.includes(expected);
  const properties = value.properties;

  if (hasType('object') || properties !== undefined) {
    if (value.additionalProperties !== false || !plainRecord(properties)) {
      throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}`);
    }
    for (const [key, property] of Object.entries(properties)) {
      if (PROHIBITED_FIELD_NAMES.has(key.toLowerCase().replace(/[_-]/g, ''))) {
        throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}.${key}`);
      }
      assertClosedBoundedSchema(property, `${path}.${key}`);
    }
  }

  if (hasType('string') && !Number.isSafeInteger(value.maxLength)) {
    throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}`);
  }
  if (
    hasType('array') &&
    (!Number.isSafeInteger(value.maxItems) || value.items === undefined)
  ) {
    throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}`);
  }
  if (hasType('array')) {
    assertClosedBoundedSchema(value.items, `${path}[]`);
  }
  if (
    (hasType('number') || hasType('integer')) &&
    (!Number.isFinite(value.minimum) || !Number.isFinite(value.maximum))
  ) {
    throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}`);
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'properties' ||
      key === 'items' ||
      key === 'additionalProperties' ||
      key === 'type'
    ) {
      continue;
    }
    if (key === '$defs' || key === 'definitions') {
      if (!plainRecord(child)) {
        throw new Error(`TYPED_PROJECTION_SCHEMA_INVALID: ${path}.${key}`);
      }
      for (const [definitionName, definition] of Object.entries(child)) {
        assertClosedBoundedSchema(definition, `${path}.${key}.${definitionName}`);
      }
    }
  }
}

function envelopeBase(schema: TypedProjectionSchema, data: unknown) {
  return Object.freeze({
    schemaVersion: TYPED_PROJECTION_ENVELOPE_VERSION,
    schema,
    data: canonicalize(data),
  });
}

function envelopeDigest(base: ReturnType<typeof envelopeBase>): string {
  return createHash('sha256').update(canonicalJson(base)).digest('hex');
}

function projectionSize(envelope: TypedProjectionEnvelope): number {
  return Buffer.byteLength(canonicalJson(envelope), 'utf8');
}

/**
 * Registry construction is additive.  Call freeze after bootstrap to make
 * the declaration set immutable before any durable result is processed.
 */
export class TypedProjectionRegistry {
  private readonly definitions = new Map<TypedProjectionSchema, RegisteredDefinition>();
  private registrationsFrozen = false;

  register<Raw, Projected>(
    definition: TypedProjectionDefinition<Raw, Projected>,
  ): this {
    if (this.registrationsFrozen) {
      throw new Error('DURABLE_RESULT_REGISTRY_FROZEN');
    }
    if (this.definitions.has(definition.schema)) {
      throw new Error('DURABLE_RESULT_SCHEMA_DUPLICATE');
    }
    if (
      typeof definition.project !== 'function' ||
      typeof definition.restore !== 'function'
    ) {
      throw new Error('TYPED_PROJECTION_SCHEMA_INVALID');
    }

    assertClosedBoundedSchema(definition.jsonSchema);
    let validate: ValidateFunction;
    try {
      validate = new Ajv({ allErrors: true, strict: true }).compile(
        definition.jsonSchema,
      );
    } catch {
      throw new Error('TYPED_PROJECTION_SCHEMA_INVALID');
    }
    this.definitions.set(
      definition.schema,
      Object.freeze({
        validate,
        project: definition.project as (raw: unknown) => unknown,
        restore: definition.restore as (projected: unknown) => unknown,
      }),
    );
    return this;
  }

  freeze(): void {
    this.registrationsFrozen = true;
  }

  project(schema: TypedProjectionSchema, raw: unknown): TypedProjectionEnvelope {
    const definition = this.definitions.get(schema);
    if (!definition) invalid();

    let data: unknown;
    try {
      data = definition.project(raw);
    } catch {
      invalid();
    }
    if (!definition.validate(data)) invalid();

    const base = envelopeBase(schema, data);
    const envelope = Object.freeze({
      ...base,
      digest: envelopeDigest(base),
    });
    if (projectionSize(envelope) > APPLICATION_MAX_BYTES) {
      throw new Error('TYPED_PROJECTION_TOO_LARGE');
    }
    return envelope;
  }

  restore(envelope: unknown): unknown {
    if (!plainRecord(envelope)) invalid();
    if (
      Object.keys(envelope).sort().join(',') !== 'data,digest,schema,schemaVersion' ||
      envelope.schemaVersion !== TYPED_PROJECTION_ENVELOPE_VERSION ||
      typeof envelope.schema !== 'string' ||
      typeof envelope.digest !== 'string' ||
      !DIGEST.test(envelope.digest)
    ) {
      invalid();
    }

    const schema = envelope.schema as TypedProjectionSchema;
    const definition = this.definitions.get(schema);
    if (!definition) invalid();
    if (!definition.validate(envelope.data)) invalid();

    const base = envelopeBase(schema, envelope.data);
    if (envelopeDigest(base) !== envelope.digest) invalid();
    const canonicalData = base.data;
    try {
      return definition.restore(canonicalData);
    } catch {
      invalid();
    }
  }
}

/**
 * Integration-only physical byte gate.  It does no persistence and callers
 * must pass a result already projected by this registry.
 */
export async function assertPostgresJsonbEnvelopeByteLimit(
  executor: PostgresJsonbByteExecutor,
  envelope: TypedProjectionEnvelope,
): Promise<number> {
  const rows = await executor.$queryRaw<readonly { byteLength: number | bigint }[]>`
    SELECT octet_length(${JSON.stringify(envelope)}::jsonb::text) AS "byteLength"
  `;
  const byteLength = rows[0]?.byteLength;
  if (
    (typeof byteLength !== 'number' && typeof byteLength !== 'bigint') ||
    byteLength > POSTGRES_JSONB_MAX_BYTES
  ) {
    throw new Error('TYPED_PROJECTION_POSTGRES_TOO_LARGE');
  }
  return Number(byteLength);
}
