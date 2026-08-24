import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TypedProjectionRegistry,
} from './typed-projection.registry';
import type {
  PostgresJsonbByteExecutor,
  TypedProjectionDefinition,
} from './typed-projection.types';

interface TaxonomyCode {
  code: string;
  provider: string;
}

function taxonomyDefinition(
  schema: 'taxonomy-code/v1' | 'icp-design/v1' | 'icp-query-plan/v1' = 'taxonomy-code/v1',
  maxLength = 80,
): TypedProjectionDefinition<TaxonomyCode, TaxonomyCode> {
  return {
    schema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'provider'],
      properties: {
        code: { type: 'string', maxLength },
        provider: { type: 'string', maxLength: 120 },
      },
    },
    project: (raw) => ({ code: raw.code, provider: raw.provider }),
    restore: (projected) => ({
      code: projected.code,
      provider: projected.provider,
    }),
  };
}

function numberListDefinition(
  schema: 'icp-design/v1' | 'icp-query-plan/v1',
  maxItems: number,
  maximum: number,
): TypedProjectionDefinition<{ values: number[] }, { values: number[] }> {
  return {
    schema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['values'],
      properties: {
        values: {
          type: 'array',
          maxItems,
          items: { type: 'number', minimum: 0, maximum },
        },
      },
    },
    project: (raw) => ({ values: raw.values }),
    restore: (projected) => ({ values: projected.values }),
  };
}

describe('TypedProjectionRegistry', () => {
  it('rejects every schema escape hatch instead of only validating direct properties', () => {
    const validLeaf = { type: 'string', maxLength: 20 };
    const bypasses: readonly [string, Record<string, unknown>][] = [
      ['oneOf branch with unbounded string', {
        oneOf: [{
          type: 'object', additionalProperties: false,
          properties: { code: { type: 'string' }, provider: validLeaf },
        }],
      }],
      ['prompt patternProperties', {
        type: 'object', additionalProperties: false, properties: {},
        patternProperties: { '^prompt$': validLeaf },
      }],
      ['$ref cycle', {
        $ref: '#/$defs/cycle',
        $defs: { cycle: { $ref: '#/$defs/cycle' } },
      }],
      ['conditional branch', {
        type: 'object', additionalProperties: false, properties: {},
        if: { type: 'object', additionalProperties: false, properties: {} },
      }],
    ];

    for (const [_name, jsonSchema] of bypasses) {
      expect(() => new TypedProjectionRegistry().register({
        ...taxonomyDefinition(), jsonSchema,
      })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');
    }
  });

  it.each(['api.key', 'credentialRef', 'systemPrompt', 'rawModelResponse'])(
    'rejects a sensitive field-name bypass: %s',
    (fieldName) => {
      expect(() => new TypedProjectionRegistry().register({
        ...taxonomyDefinition(),
        jsonSchema: {
          type: 'object', additionalProperties: false,
          properties: { [fieldName]: { type: 'string', maxLength: 20 } },
        },
      })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');
    },
  );

  it.each([
    'apikey', 'APIKey', 'api_key', 'api.key', 'x.api.key', 'credentials',
    'accessToken', 'rawresponse', 'responsebody', 'authorization', 'headers',
    'password', 'secret', 'cookie', 'ａｐｉｋｅｙ', '𝗮𝗽𝗶𝗸𝗲𝘆',
  ])('rejects normalized sensitive or confusable property name: %s', (fieldName) => {
    expect(() => new TypedProjectionRegistry().register({
      ...taxonomyDefinition(),
      jsonSchema: {
        type: 'object', additionalProperties: false,
        properties: { [fieldName]: { type: 'string', maxLength: 20 } },
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');
  });

  it('keeps its schema allowlist and frozen registrations private at runtime', () => {
    const registry = new TypedProjectionRegistry();
    expect(() => registry.register({
      ...taxonomyDefinition(), schema: 'unknown/v1',
    } as unknown as TypedProjectionDefinition<TaxonomyCode, TaxonomyCode>)).toThrow(
      'TYPED_PROJECTION_SCHEMA_INVALID',
    );
    registry.register(taxonomyDefinition());
    registry.freeze();

    const invasive = registry as unknown as {
      registrationsFrozen: boolean;
      definitions: Map<string, unknown>;
    };
    invasive.registrationsFrozen = false;
    invasive.definitions = new Map();

    expect(() => registry.register(taxonomyDefinition('icp-design/v1'))).toThrow(
      'DURABLE_RESULT_REGISTRY_FROZEN',
    );
    expect(registry.project('taxonomy-code/v1', {
      code: 'A', provider: 'catalog',
    })).toMatchObject({ schema: 'taxonomy-code/v1' });
  });

  it('rejects non-JSON, non-canonical, accessor, and trap-backed projected values', () => {
    const cases: readonly [string, () => unknown][] = [
      ['NUL string', () => ({ code: 'A\0', provider: 'catalog' })],
      ['unpaired surrogate', () => ({
        code: String.fromCharCode(0xd800), provider: 'catalog',
      })],
      ['non-NFC string', () => ({ code: 'e\u0301', provider: 'catalog' })],
      ['accessor', () => Object.defineProperties({}, {
        code: { enumerable: true, get: () => 'A' },
        provider: { enumerable: true, value: 'catalog' },
      })],
      ['non-enumerable property', () => {
        const value = { code: 'A', provider: 'catalog' };
        Object.defineProperty(value, 'hidden', { value: true });
        return value;
      }],
      ['proxy trap', () => new Proxy(
        { code: 'A', provider: 'catalog' },
        { ownKeys: () => { throw new Error('trap'); } },
      )],
      ['transparent object proxy', () => new Proxy(
        { code: 'A', provider: 'catalog' }, {},
      )],
    ];

    for (const [_name, produce] of cases) {
      const registry = new TypedProjectionRegistry();
      if (_name === 'unpaired surrogate') {
        expect((produce() as { code: string }).code.charCodeAt(0)).toBe(0xd800);
      }
      registry.register({ ...taxonomyDefinition(), project: () => produce() as TaxonomyCode });
      try {
        registry.project('taxonomy-code/v1', {});
      } catch (error) {
        expect(error).toMatchObject({ message: 'TYPED_PROJECTION_INVALID' });
        continue;
      }
      throw new Error(`expected ${_name} to be rejected`);
    }

    const numeric = new TypedProjectionRegistry();
    numeric.register(numberListDefinition('icp-design/v1', 1, 1));
    expect(() => numeric.project('icp-design/v1', { values: [-0] })).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const arrayWithExtraProperty = [1];
    Object.assign(arrayWithExtraProperty, { extra: true });
    const arrays = new TypedProjectionRegistry();
    arrays.register(numberListDefinition('icp-query-plan/v1', 2, 1));
    expect(() => arrays.project('icp-query-plan/v1', {
      values: arrayWithExtraProperty,
    })).toThrow('TYPED_PROJECTION_INVALID');
    const transparentArrayProxy = new Proxy([1], {});
    expect(() => arrays.project('icp-query-plan/v1', {
      values: transparentArrayProxy,
    })).toThrow('TYPED_PROJECTION_INVALID');
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects reserved own key %s in both schemas and projected data',
    (reservedKey) => {
      const projected = { code: 'A', provider: 'catalog' } as Record<string, unknown>;
      Object.defineProperty(projected, reservedKey, {
        enumerable: true, value: 'forbidden',
      });
      const registry = new TypedProjectionRegistry();
      registry.register({
        ...taxonomyDefinition(), project: () => projected as unknown as TaxonomyCode,
      });
      expect(() => registry.project('taxonomy-code/v1', {})).toThrow(
        'TYPED_PROJECTION_INVALID',
      );

      const properties = { code: { type: 'string', maxLength: 20 } };
      Object.defineProperty(properties, reservedKey, {
        enumerable: true, value: { type: 'string', maxLength: 20 },
      });
      expect(() => new TypedProjectionRegistry().register({
        ...taxonomyDefinition(),
        jsonSchema: { type: 'object', additionalProperties: false, properties },
      })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');
    },
  );

  it('isolates digest, restore, application, and PostgreSQL gates from inherited facts', async () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());
    const baseline = registry.project('taxonomy-code/v1', {
      code: 'A', provider: 'catalog',
    });
    const inheritedOnly = new TypedProjectionRegistry();
    inheritedOnly.register({
      ...taxonomyDefinition(), project: () => ({}) as TaxonomyCode,
    });
    const originalCode = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
    const originalProvider = Object.getOwnPropertyDescriptor(Object.prototype, 'provider');
    Object.defineProperty(Object.prototype, 'code', {
      configurable: true, enumerable: false, value: 'x'.repeat(130 * 1024),
    });
    Object.defineProperty(Object.prototype, 'provider', {
      configurable: true, enumerable: false, value: 'polluted-provider',
    });
    try {
      expect(() => inheritedOnly.project('taxonomy-code/v1', {})).toThrow(
        'TYPED_PROJECTION_INVALID',
      );

      const underPollution = registry.project('taxonomy-code/v1', {
        code: 'A', provider: 'catalog',
      });
      expect(underPollution.digest).toBe(baseline.digest);
      expect(registry.restore(baseline)).toEqual({ code: 'A', provider: 'catalog' });
      expect(registry.restore(underPollution)).toEqual({ code: 'A', provider: 'catalog' });

      const inheritedDataEnvelope = { ...baseline, data: {} };
      expect(() => registry.restore(inheritedDataEnvelope)).toThrow(
        'TYPED_PROJECTION_INVALID',
      );
      let queryCalls = 0;
      const mustNotQuery: PostgresJsonbByteExecutor = {
        async $queryRaw<T>(): Promise<T> {
          queryCalls += 1;
          throw new Error('PostgreSQL must not observe inherited content');
        },
      };
      await expect(
        registry.assertPostgresJsonbEnvelopeByteLimit(mustNotQuery, inheritedDataEnvelope),
      ).rejects.toThrow('TYPED_PROJECTION_INVALID');
      expect(queryCalls).toBe(0);
    } finally {
      if (originalCode) Object.defineProperty(Object.prototype, 'code', originalCode);
      else delete (Object.prototype as { code?: unknown }).code;
      if (originalProvider) Object.defineProperty(Object.prototype, 'provider', originalProvider);
      else delete (Object.prototype as { provider?: unknown }).provider;
    }
  });

  it('uses its own canonical encoder when Object and Array prototypes gain toJSON', () => {
    const originalObjectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
    const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => 'poisoned-object',
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value: () => [],
    });
    try {
      const registry = new TypedProjectionRegistry();
      registry.register(taxonomyDefinition());
      const projected = registry.project('taxonomy-code/v1', {
        code: 'A', provider: 'catalog',
      });
      expect(projected.digest).toBe(
        '1103fbe3a173cf37ec1e011ad432d54c3bd290a4baa745d544d0e1c64751a197',
      );
      const arrayRegistry = new TypedProjectionRegistry();
      arrayRegistry.register(numberListDefinition('icp-query-plan/v1', 1, 1));
      expect(arrayRegistry.project('icp-query-plan/v1', { values: [1] }).digest).toBe(
        'f6237cfb2c6e781d2c3ca9214e6d66de313aaa3b272686a68e98884cacd5d985',
      );
      const oversized = new TypedProjectionRegistry();
      oversized.register(taxonomyDefinition('icp-design/v1', 130_000));
      expect(() => oversized.project('icp-design/v1', {
        code: 'x'.repeat(130_000), provider: 'catalog',
      })).toThrow('TYPED_PROJECTION_TOO_LARGE');
    } finally {
      if (originalObjectToJson) Object.defineProperty(Object.prototype, 'toJSON', originalObjectToJson);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
      if (originalArrayToJson) Object.defineProperty(Array.prototype, 'toJSON', originalArrayToJson);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
    }
  });
  it('rejects a duplicate schema registration so one schema has one projector', () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());

    expect(() => registry.register(taxonomyDefinition())).toThrow(
      'DURABLE_RESULT_SCHEMA_DUPLICATE',
    );
  });

  it('rejects a projection that contains a field outside its closed schema', () => {
    const registry = new TypedProjectionRegistry();
    registry.register({
      ...taxonomyDefinition(),
      project: (raw) => raw,
    });

    expect(() =>
      registry.project('taxonomy-code/v1', {
        code: 'A',
        provider: 'catalog',
        unexpected: true,
      }),
    ).toThrow('TYPED_PROJECTION_INVALID');
  });

  it('rejects open, unbounded, and secret-bearing schema definitions at registration', () => {
    const openRegistry = new TypedProjectionRegistry();
    expect(() => openRegistry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');

    const unboundedRegistry = new TypedProjectionRegistry();
    expect(() => unboundedRegistry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { code: { type: 'string' } },
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');

    const secretRegistry = new TypedProjectionRegistry();
    expect(() => secretRegistry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { prompt: { type: 'string', maxLength: 20 } },
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');

    const rawResponseRegistry = new TypedProjectionRegistry();
    expect(() => rawResponseRegistry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { raw_response: { type: 'string', maxLength: 20 } },
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');

    const missingProjectorRegistry = new TypedProjectionRegistry();
    expect(() => missingProjectorRegistry.register({
      ...taxonomyDefinition(),
      project: undefined,
    } as unknown as TypedProjectionDefinition<TaxonomyCode, TaxonomyCode>)).toThrow(
      'TYPED_PROJECTION_SCHEMA_INVALID',
    );

    const ajvRejectedRegistry = new TypedProjectionRegistry();
    expect(() => ajvRejectedRegistry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        ...taxonomyDefinition().jsonSchema,
        unsupportedKeyword: true,
      },
    })).toThrow('TYPED_PROJECTION_SCHEMA_INVALID');
  });

  it('accepts bounded closed definitions stored under $defs', () => {
    const registry = new TypedProjectionRegistry();
    expect(() => registry.register({
      ...taxonomyDefinition(),
      jsonSchema: {
        ...taxonomyDefinition().jsonSchema,
        $defs: {
          source: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string', maxLength: 20 } },
          },
        },
      },
    })).not.toThrow();
  });

  it('rejects unknown schemas and a projector that cannot produce a projection', () => {
    const unknownRegistry = new TypedProjectionRegistry();
    expect(() => unknownRegistry.project('fit-judgment/v1', {})).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const throwingRegistry = new TypedProjectionRegistry();
    throwingRegistry.register({
      ...taxonomyDefinition(),
      project: () => {
        throw new Error('raw result unavailable');
      },
    });
    expect(() => throwingRegistry.project('taxonomy-code/v1', {})).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('seals registrations after bootstrap without disabling registered projections', () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());
    registry.freeze();

    expect(() => registry.register(taxonomyDefinition('icp-design/v1'))).toThrow(
      'DURABLE_RESULT_REGISTRY_FROZEN',
    );
    expect(registry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    })).toMatchObject({ schema: 'taxonomy-code/v1' });
  });

  it('canonicalizes data before using its hand-derived v2 digest', () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());

    const first = registry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    });
    const second = registry.project('taxonomy-code/v1', {
      provider: 'catalog',
      code: 'A',
    });

    expect(first.digest).toBe(
      '1103fbe3a173cf37ec1e011ad432d54c3bd290a4baa745d544d0e1c64751a197',
    );
    expect(second.digest).toBe(first.digest);
    expect(first.data).toEqual({ code: 'A', provider: 'catalog' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.data)).toBe(true);
  });

  it('restores only an untampered immutable envelope without mutating stored data', () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());
    const projected = registry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    });
    const stored = Object.freeze({
      digest: projected.digest,
      data: Object.freeze({ provider: 'catalog', code: 'A' }),
      schema: 'taxonomy-code/v1' as const,
      schemaVersion: 'generic-operation-projection/v2' as const,
    });

    expect(registry.restore(stored)).toEqual({ code: 'A', provider: 'catalog' });
    expect(stored.data).toEqual({ provider: 'catalog', code: 'A' });
    expect(() => registry.restore({ ...stored, digest: '0'.repeat(64) })).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    expect(() => registry.restore([])).toThrow('TYPED_PROJECTION_INVALID');
    expect(() => registry.restore({ ...stored, extra: true })).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    expect(() => registry.restore({ ...stored, data: { code: 'A' } })).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
    const inheritedEnvelope = Object.create({
      ...stored,
      data: { code: 'changed-through-prototype', provider: 'catalog' },
    });
    expect(() => registry.restore(inheritedEnvelope)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('rejects an envelope for an unregistered schema and a failing restorer', () => {
    const sourceRegistry = new TypedProjectionRegistry();
    sourceRegistry.register(taxonomyDefinition());
    const projected = sourceRegistry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    });
    const unknownRegistry = new TypedProjectionRegistry();
    expect(() => unknownRegistry.restore(projected)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );

    const throwingRegistry = new TypedProjectionRegistry();
    throwingRegistry.register({
      ...taxonomyDefinition(),
      restore: () => {
        throw new Error('stored projection cannot be restored');
      },
    });
    const failingEnvelope = throwingRegistry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    });
    expect(() => throwingRegistry.restore(failingEnvelope)).toThrow(
      'TYPED_PROJECTION_INVALID',
    );
  });

  it('accepts a hand-sized 120 KiB envelope and rejects one byte beyond it', () => {
    const maximum = new TypedProjectionRegistry();
    maximum.register(taxonomyDefinition('icp-design/v1', 122_688));
    const maxProjected = maximum.project('icp-design/v1', {
      code: 'x'.repeat(122_688),
      provider: 'catalog',
    });

    expect(Buffer.byteLength(JSON.stringify(maxProjected), 'utf8')).toBe(120 * 1024);

    const over = new TypedProjectionRegistry();
    over.register(taxonomyDefinition('icp-query-plan/v1', 122_685));
    const oneByteOver = {
      schemaVersion: 'generic-operation-projection/v2',
      schema: 'icp-query-plan/v1',
      data: { code: 'x'.repeat(122_685), provider: 'catalog' },
      digest: '0'.repeat(64),
    };
    expect(Buffer.byteLength(JSON.stringify(oneByteOver), 'utf8')).toBe(
      120 * 1024 + 1,
    );
    expect(() => over.project('icp-query-plan/v1', {
      code: 'x'.repeat(122_685),
      provider: 'catalog',
    })).toThrow('TYPED_PROJECTION_TOO_LARGE');
  });

  it('rejects a digest-valid stored envelope that is one byte over the application cap', () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition('icp-design/v1', 122_689));
    const data = { code: 'x'.repeat(122_689), provider: 'catalog' };
    const base = JSON.stringify({
      data,
      schema: 'icp-design/v1',
      schemaVersion: 'generic-operation-projection/v2',
    });
    const stored = {
      schemaVersion: 'generic-operation-projection/v2' as const,
      schema: 'icp-design/v1' as const,
      data,
      digest: createHash('sha256').update(base).digest('hex'),
    };

    expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBe(120 * 1024 + 1);
    expect(() => registry.restore(stored)).toThrow('TYPED_PROJECTION_TOO_LARGE');
  });
});

const APP_DATABASE_URL = process.env.APP_DATABASE_URL?.trim();
const liveDatabaseIt = APP_DATABASE_URL ? it : it.skip;

function readOnlyPostgresExecutor(
  database: PrismaClient | undefined,
): PostgresJsonbByteExecutor {
  return {
    async $queryRaw<T>(strings: TemplateStringsArray, ...values: readonly unknown[]): Promise<T> {
      const statement = strings.join('?').replace(/\s+/g, ' ').trim();
      expect(statement).toBe('SELECT octet_length(?::jsonb::text) AS "byteLength"');
      expect(values).toHaveLength(1);
      if (database) return database.$queryRaw<T>(strings, ...values);
      const serialized = values[0];
      if (typeof serialized !== 'string') throw new Error('expected canonical JSON parameter');
      const byteLength = Buffer.byteLength(JSON.stringify(JSON.parse(serialized)), 'utf8');
      return [{ byteLength }] as unknown as T;
    },
  };
}

describe('TypedProjectionRegistry PostgreSQL JSONB byte gate', () => {
  let database: PrismaClient | undefined;

  beforeAll(async () => {
    if (!APP_DATABASE_URL) return;
    database = new PrismaClient({
      datasources: { db: { url: APP_DATABASE_URL } },
    });
    await database.$connect();
  });
  afterAll(async () => {
    if (database) await database.$disconnect();
  });

  it('carries an explicit null-prototype projection through AJV, restore, and the PG gate', async () => {
    const projectorResult = Object.create(null) as TaxonomyCode;
    Object.defineProperties(projectorResult, {
      code: { enumerable: true, value: 'A' },
      provider: { enumerable: true, value: 'catalog' },
    });
    let restoredDataPrototype: object | null | undefined;
    const registry = new TypedProjectionRegistry();
    registry.register({
      ...taxonomyDefinition(),
      project: () => projectorResult,
      restore: (projected) => {
        restoredDataPrototype = Object.getPrototypeOf(projected);
        return { code: projected.code, provider: projected.provider };
      },
    });
    const envelope = registry.project('taxonomy-code/v1', {});

    expect(Object.getPrototypeOf(projectorResult)).toBeNull();
    expect(Object.getPrototypeOf(envelope)).toBeNull();
    expect(Object.getPrototypeOf(envelope.data)).toBeNull();
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.data)).toBe(true);
    expect(registry.restore(envelope)).toEqual({ code: 'A', provider: 'catalog' });
    expect(restoredDataPrototype).toBeNull();
    await expect(
      registry.assertPostgresJsonbEnvelopeByteLimit(
        readOnlyPostgresExecutor(database), envelope,
      ),
    ).resolves.toBeLessThanOrEqual(128 * 1024);
  });

  liveDatabaseIt('rejects real PostgreSQL JSONB expansion over 128 KiB', async () => {
    if (!database) throw new Error('APP_DATABASE_URL did not produce a database connection');
    const registry = new TypedProjectionRegistry();
    registry.register(numberListDefinition('icp-design/v1', 1_500, 1e100));
    const projected = registry.project('icp-design/v1', {
      values: Array.from({ length: 1_500 }, () => 1e100),
    });

    await expect(
      registry.assertPostgresJsonbEnvelopeByteLimit(
        readOnlyPostgresExecutor(database), projected,
      ),
    ).rejects.toThrow('TYPED_PROJECTION_POSTGRES_TOO_LARGE');
    expect(Buffer.byteLength(JSON.stringify(projected), 'utf8')).toBeLessThanOrEqual(
      120 * 1024,
    );
  });
});
