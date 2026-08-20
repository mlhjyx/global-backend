import { describe, expect, it } from 'vitest';
import {
  parseGenericOperationProjection,
  projectGenericOperationResult,
} from './generic-operation-projection';

describe('generic durable operation projection', () => {
  it('round-trips only a closed, versioned, digest-bound projection', () => {
    const projected = projectGenericOperationResult({
      kind: 'tool',
      schema: 'searxng-search/v1',
      data: { results: [{ url: 'https://example.test/', score: 1 }] },
    });
    expect(projected).toMatchObject({
      schemaVersion: 'generic-operation-projection/v1',
      kind: 'tool',
      schema: 'searxng-search/v1',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(parseGenericOperationProjection(projected)).toEqual(projected);
  });

  it.each(['prompt', 'authorization', 'token', 'headers', 'rawResponse'])(
    'rejects sensitive key %s at any nesting depth',
    (key) => {
      expect(() =>
        projectGenericOperationResult({
          kind: 'model',
          schema: 'fit-judgment/v1',
          data: { safe: { [key]: 'must-not-persist' } },
        }),
      ).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
    },
  );

  it('rejects oversized strings, arrays and unknown envelope fields', () => {
    expect(() => projectGenericOperationResult({
      kind: 'tool', schema: 'bounded/v1', data: { value: 'x'.repeat(65_537) },
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
    expect(() => projectGenericOperationResult({
      kind: 'tool', schema: 'bounded/v1', data: { values: Array.from({ length: 257 }, (_, i) => i) },
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
    expect(() => parseGenericOperationProjection({
      schemaVersion: 'generic-operation-projection/v1', kind: 'tool', schema: 'bounded/v1', data: {}, digest: 'a'.repeat(64), extra: true,
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
  });

  it('reserves envelope and PostgreSQL JSONB overhead below the 128 KiB database cap', () => {
    expect(() => projectGenericOperationResult({
      kind: 'tool', schema: 'bounded/v1',
      data: { values: Array.from({ length: 256 }, () => 'x'.repeat(490)) },
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
  });
});
