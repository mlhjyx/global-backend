import { createHash } from 'node:crypto';
import { types } from 'node:util';
import Ajv, { type AnySchema, type ValidateFunction } from 'ajv';
import {
  isTypedProjectionSchema,
  type TypedProjectionSchema,
} from './durable-result-strategy';
import {
  TYPED_PROJECTION_ENVELOPE_VERSION,
  type PostgresJsonbByteExecutor,
  type TypedProjectionDefinition,
  type TypedProjectionEnvelope,
} from './typed-projection.types';

const APPLICATION_MAX_BYTES = 120 * 1024;
const POSTGRES_JSONB_MAX_BYTES = 128 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_LENGTH = 65_536;
const DIGEST = /^[0-9a-f]{64}$/;
const SCHEMA_KEYS = new Set([
  '$defs', 'additionalProperties', 'allOf', 'anyOf', 'const', 'enum',
  'items', 'maxItems', 'maxLength', 'maximum', 'minItems', 'minLength',
  'minimum', 'oneOf', 'properties', 'required', 'type',
]);
const JSON_TYPES = new Set([
  'array', 'boolean', 'integer', 'null', 'number', 'object', 'string',
]);
const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

interface RegisteredDefinition {
  readonly validate: ValidateFunction;
  readonly project: (raw: unknown) => unknown;
  readonly restore: (projected: unknown) => unknown;
}

type StrictJsonArray = readonly StrictJson[];

interface StrictJsonObject {
  readonly [key: string]: StrictJson;
}

type StrictJson = null | boolean | number | string | StrictJsonArray | StrictJsonObject;

function invalid(): never {
  throw new Error('TYPED_PROJECTION_INVALID');
}

function schemaInvalid(): never {
  throw new Error('TYPED_PROJECTION_SCHEMA_INVALID');
}

function tooLarge(): never {
  throw new Error('TYPED_PROJECTION_TOO_LARGE');
}

function isCanonicalRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === null,
  );
}

function assertUnicode(value: string): void {
  if (value.includes('\0') || value !== value.normalize('NFC')) invalid();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid();
    }
  }
}

function assertSafePropertyName(value: string): void {
  assertUnicode(value);
  if (RESERVED_PROPERTY_NAMES.has(value)) invalid();
}

function frozenRecord(entries: readonly (readonly [string, StrictJson])[]): StrictJsonObject {
  const result = Object.create(null) as Record<string, StrictJson>;
  for (const [key, value] of entries) {
    assertSafePropertyName(key);
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value,
      writable: false,
    });
  }
  return Object.freeze(result);
}

function strictJson(value: unknown, seen = new WeakSet<object>(), depth = 0): StrictJson {
  try {
    if (depth > MAX_JSON_DEPTH) invalid();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      assertUnicode(value);
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) invalid();
      return value;
    }
    if (
      typeof value === 'undefined' || typeof value === 'bigint' ||
      typeof value === 'function' || typeof value === 'symbol' ||
      !value || typeof value !== 'object'
    ) {
      invalid();
    }
    if (types.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_JSON_ARRAY_LENGTH) {
          invalid();
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) invalid();
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === 'length') continue;
          if (!/^(0|[1-9][0-9]*)$/.test(key) || !descriptor.enumerable || !('value' in descriptor)) {
            invalid();
          }
        }
        const result: StrictJson[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
          result.push(strictJson(descriptor.value, seen, depth + 1));
        }
        return Object.freeze(result);
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== 'string')) invalid();
      const entries: [string, StrictJson][] = [];
      for (const key of (keys as string[]).sort()) {
        assertSafePropertyName(key);
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        entries.push([key, strictJson(descriptor.value, seen, depth + 1)]);
      }
      return frozenRecord(entries);
    } finally {
      seen.delete(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'TYPED_PROJECTION_INVALID') throw error;
    invalid();
  }
}

function canonicalJson(value: StrictJson): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      entries.push(canonicalJson(value[index]!));
    }
    return `[${entries.join(',')}]`;
  }
  const objectValue = value as StrictJsonObject;
  return `{${Object.keys(objectValue).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key]!)}`,
  ).join(',')}}`;
}

/** AJV accepts ordinary own-data containers; canonical data stays null-prototype. */
function cloneForAjv(value: StrictJson): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) return value.map(cloneForAjv);
  const objectValue = value as StrictJsonObject;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneForAjv(objectValue[key]!),
      writable: true,
    });
  }
  return result;
}

function fieldNameTokens(value: string): readonly string[] {
  const separated = value.normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return separated.split(/[^a-z0-9]+/).filter(Boolean);
}

function hasSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
  return sequence.every((token, index) => tokens[index] === token) ||
    tokens.some((_, offset) => sequence.every((token, index) => tokens[offset + index] === token));
}

function isProhibitedFieldName(value: string): boolean {
  const tokens = fieldNameTokens(value);
  const compact = tokens.join('');
  const prohibitedCompact = new Set([
    'prompt', 'systemprompt', 'apikey', 'credential', 'credentials',
    'credentialref', 'token', 'accesstoken', 'rawresponse',
    'rawmodelresponse', 'responsebody', 'authorization', 'header', 'headers',
    'password', 'secret', 'cookie',
  ]);
  return (
    prohibitedCompact.has(compact) || tokens.includes('prompt') || tokens.includes('authorization') ||
    tokens.includes('header') || tokens.includes('headers') ||
    tokens.includes('password') || tokens.includes('secret') ||
    tokens.includes('cookie') || hasSequence(tokens, ['api', 'key']) ||
    hasSequence(tokens, ['access', 'token']) ||
    hasSequence(tokens, ['credential', 'ref']) ||
    hasSequence(tokens, ['response', 'body']) ||
    hasSequence(tokens, ['raw', 'response']) ||
    hasSequence(tokens, ['raw', 'model', 'response'])
  );
}

function assertSchemaPropertyName(value: string): void {
  const compatibility = value.normalize('NFKC');
  if (value !== compatibility || !/^[A-Za-z][A-Za-z0-9]*$/.test(value) || isProhibitedFieldName(value)) {
    schemaInvalid();
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function schemaRecord(value: StrictJson): Readonly<Record<string, StrictJson>> {
  if (!isCanonicalRecord(value)) schemaInvalid();
  return value;
}

function schemaTypes(node: Readonly<Record<string, StrictJson>>): readonly string[] {
  const type = node.type;
  const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type : undefined;
  if (!types || types.length === 0 || !types.every((entry) => typeof entry === 'string' && JSON_TYPES.has(entry))) {
    schemaInvalid();
  }
  return types;
}

function assertSchema(value: StrictJson): void {
  const node = schemaRecord(value);
  if (Object.keys(node).some((key) => !SCHEMA_KEYS.has(key))) schemaInvalid();
  const combinations = ['oneOf', 'anyOf', 'allOf'] as const;
  for (const key of combinations) {
    if (node[key] === undefined) continue;
    if (!Array.isArray(node[key]) || node[key].length === 0) schemaInvalid();
    for (const branch of node[key]) assertSchema(branch);
  }
  if (node.$defs !== undefined) {
    const definitions = schemaRecord(node.$defs);
    for (const definition of Object.values(definitions)) assertSchema(definition);
  }
  if (node.type === undefined) {
    if (!combinations.some((key) => node[key] !== undefined)) schemaInvalid();
    return;
  }
  const types = schemaTypes(node);
  const has = (type: string) => types.includes(type);
  if (has('object')) {
    if (node.additionalProperties !== false || !isCanonicalRecord(node.properties)) schemaInvalid();
    const properties = schemaRecord(node.properties);
    if (node.required !== undefined) {
      if (!Array.isArray(node.required) || !node.required.every((key) => typeof key === 'string')) schemaInvalid();
      const required = node.required as readonly string[];
      if (new Set(required).size !== required.length || required.some((key) => !Object.hasOwn(properties, key))) schemaInvalid();
    }
    for (const [key, property] of Object.entries(properties)) {
      assertSchemaPropertyName(key);
      assertSchema(property);
    }
  } else if (node.additionalProperties !== undefined || node.properties !== undefined || node.required !== undefined) {
    schemaInvalid();
  }
  if (has('string') && !isNonNegativeSafeInteger(node.maxLength)) schemaInvalid();
  if (has('array')) {
    if (!isNonNegativeSafeInteger(node.maxItems) || node.items === undefined) schemaInvalid();
    assertSchema(node.items);
  } else if (node.maxItems !== undefined || node.items !== undefined) {
    schemaInvalid();
  }
  if (has('number') || has('integer')) {
    if (typeof node.minimum !== 'number' || typeof node.maximum !== 'number' ||
      !Number.isFinite(node.minimum) || !Number.isFinite(node.maximum) || node.minimum > node.maximum) {
      schemaInvalid();
    }
  } else if (node.minimum !== undefined || node.maximum !== undefined) {
    schemaInvalid();
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) schemaInvalid();
}

function envelopeBase(schema: TypedProjectionSchema, data: StrictJson) {
  return frozenRecord([
    ['data', data],
    ['schema', schema],
    ['schemaVersion', TYPED_PROJECTION_ENVELOPE_VERSION],
  ]);
}

function envelopeDigest(base: StrictJsonObject): string {
  return createHash('sha256').update(canonicalJson(base)).digest('hex');
}

function projectionSize(envelope: TypedProjectionEnvelope): number {
  return Buffer.byteLength(canonicalJson(strictJson(envelope)), 'utf8');
}

export class TypedProjectionRegistry {
  #definitions = new Map<TypedProjectionSchema, RegisteredDefinition>();
  #registrationsFrozen = false;

  register<Raw, Projected>(definition: TypedProjectionDefinition<Raw, Projected>): this {
    if (this.#registrationsFrozen) throw new Error('DURABLE_RESULT_REGISTRY_FROZEN');
    try {
      if (!isTypedProjectionSchema(definition.schema)) schemaInvalid();
      if (this.#definitions.has(definition.schema)) throw new Error('DURABLE_RESULT_SCHEMA_DUPLICATE');
      if (typeof definition.project !== 'function' || typeof definition.restore !== 'function') schemaInvalid();
      const schema = strictJson(definition.jsonSchema);
      assertSchema(schema);
      const validate = new Ajv({ allErrors: true, ownProperties: true, strict: true }).compile(
        cloneForAjv(schema) as AnySchema,
      );
      this.#definitions.set(definition.schema, Object.freeze({
        validate,
        project: definition.project as (raw: unknown) => unknown,
        restore: definition.restore as (projected: unknown) => unknown,
      }));
      return this;
    } catch (error) {
      if (error instanceof Error && error.message === 'DURABLE_RESULT_SCHEMA_DUPLICATE') throw error;
      schemaInvalid();
    }
  }

  freeze(): void {
    this.#registrationsFrozen = true;
  }

  project(schema: TypedProjectionSchema, raw: unknown): TypedProjectionEnvelope {
    try {
      if (!isTypedProjectionSchema(schema)) invalid();
      const definition = this.#definitions.get(schema);
      if (!definition) invalid();
      const data = strictJson(definition.project(raw));
      if (!definition.validate(data)) invalid();
      const base = envelopeBase(schema, data);
      const envelope = frozenRecord([
        ['data', base.data!],
        ['digest', envelopeDigest(base)],
        ['schema', base.schema!],
        ['schemaVersion', base.schemaVersion!],
      ]) as unknown as TypedProjectionEnvelope;
      if (projectionSize(envelope) > APPLICATION_MAX_BYTES) tooLarge();
      return envelope;
    } catch (error) {
      if (error instanceof Error && error.message === 'TYPED_PROJECTION_TOO_LARGE') throw error;
      invalid();
    }
  }

  #validatedEnvelope(envelope: unknown): TypedProjectionEnvelope {
    try {
      const stored = schemaRecord(strictJson(envelope));
      if (
        Object.keys(stored).sort().join(',') !== 'data,digest,schema,schemaVersion' ||
        stored.schemaVersion !== TYPED_PROJECTION_ENVELOPE_VERSION ||
        !isTypedProjectionSchema(stored.schema) || typeof stored.digest !== 'string' ||
        !DIGEST.test(stored.digest)
      ) invalid();
      const definition = this.#definitions.get(stored.schema);
      if (!definition || !definition.validate(stored.data)) invalid();
      const base = envelopeBase(stored.schema, stored.data);
      const validated = frozenRecord([
        ['data', base.data!],
        ['digest', stored.digest],
        ['schema', base.schema!],
        ['schemaVersion', base.schemaVersion!],
      ]) as unknown as TypedProjectionEnvelope;
      if (envelopeDigest(base) !== validated.digest) invalid();
      if (projectionSize(validated) > APPLICATION_MAX_BYTES) tooLarge();
      return validated;
    } catch (error) {
      if (error instanceof Error && error.message === 'TYPED_PROJECTION_TOO_LARGE') throw error;
      invalid();
    }
  }

  restore(envelope: unknown): unknown {
    const validated = this.#validatedEnvelope(envelope);
    const definition = this.#definitions.get(validated.schema);
    if (!definition) invalid();
    try {
      return definition.restore(validated.data);
    } catch {
      invalid();
    }
  }

  async assertPostgresJsonbEnvelopeByteLimit(
    executor: PostgresJsonbByteExecutor,
    envelope: unknown,
  ): Promise<number> {
    const validated = this.#validatedEnvelope(envelope);
    try {
      const rows = await executor.$queryRaw<readonly { byteLength: number | bigint }[]>`
        SELECT octet_length(${canonicalJson(strictJson(validated))}::jsonb::text) AS "byteLength"
      `;
      const byteLength = rows[0]?.byteLength;
      const numeric = typeof byteLength === 'bigint' ? Number(byteLength) : byteLength;
      if (
        !Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(numeric) ||
        numeric < 0 || numeric > POSTGRES_JSONB_MAX_BYTES
      ) {
        throw new Error('TYPED_PROJECTION_POSTGRES_TOO_LARGE');
      }
      return numeric;
    } catch (error) {
      if (error instanceof Error && error.message === 'TYPED_PROJECTION_POSTGRES_TOO_LARGE') throw error;
      invalid();
    }
  }
}
