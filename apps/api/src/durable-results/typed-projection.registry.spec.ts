import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertPostgresJsonbEnvelopeByteLimit,
  TypedProjectionRegistry,
} from './typed-projection.registry';
import type {
  TypedProjectionDefinition,
  TypedProjectionEnvelope,
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

describe('TypedProjectionRegistry', () => {
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
});

const APP_DATABASE_URL = process.env.APP_DATABASE_URL;
const databaseDescribe = APP_DATABASE_URL == null ? describe.skip : describe;

databaseDescribe('TypedProjectionRegistry PostgreSQL JSONB byte gate', () => {
  let database: PrismaClient;

  beforeAll(async () => {
    database = new PrismaClient({
      datasources: { db: { url: APP_DATABASE_URL! } },
    });
    await database.$connect();
  });
  afterAll(async () => database.$disconnect());

  it('accepts an application-valid envelope and rejects JSONB text over 128 KiB', async () => {
    const registry = new TypedProjectionRegistry();
    registry.register(taxonomyDefinition());
    const projected = registry.project('taxonomy-code/v1', {
      code: 'A',
      provider: 'catalog',
    });

    await expect(
      assertPostgresJsonbEnvelopeByteLimit(database, projected),
    ).resolves.toBeLessThanOrEqual(128 * 1024);

    const oversizedStoredEnvelope = Object.freeze({
      schemaVersion: 'generic-operation-projection/v2' as const,
      schema: 'icp-query-plan/v1' as const,
      data: Object.freeze({ value: 'x'.repeat(130_897) }),
      digest: '0'.repeat(64),
    }) as TypedProjectionEnvelope;

    await expect(
      assertPostgresJsonbEnvelopeByteLimit(database, oversizedStoredEnvelope),
    ).rejects.toThrow('TYPED_PROJECTION_POSTGRES_TOO_LARGE');
  });
});
