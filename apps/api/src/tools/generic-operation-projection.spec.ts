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

  it('preserves finite fractional cost facts without changing replay bytes', () => {
    const projected = projectGenericOperationResult({
      kind: 'model',
      schema: 'fit-judgment/v1',
      data: { usage: { costUsd: 0.0017, inputTokens: 11, outputTokens: 7 } },
    });

    expect(parseGenericOperationProjection(projected)).toEqual(projected);
    expect(projected.data).toEqual({
      usage: { costUsd: 0.0017, inputTokens: 11, outputTokens: 7 },
    });
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
      data: { values: Array.from({ length: 256 }, () => 'x'.repeat(510)) },
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
  });

  it('admits the typed-shape field envelope while retaining a finite object-field cap', () => {
    const fields = Object.fromEntries(
      Array.from({ length: 4_096 }, (_, index) => [`f${index}`, index]),
    );
    expect(() => projectGenericOperationResult({
      kind: 'model', schema: 'bounded/v1', data: fields,
    })).not.toThrow();
    expect(() => projectGenericOperationResult({
      kind: 'model', schema: 'bounded/v1', data: { ...fields, overflow: true },
    })).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
  });

  it('permits the bounded provider-wire receipt depth and rejects one level beyond it', () => {
    const nested = (depth: number): unknown =>
      depth === 0 ? 'leaf' : { value: nested(depth - 1) };
    expect(() =>
      projectGenericOperationResult({
        kind: 'model',
        schema: 'bounded/v1',
        data: nested(10),
      }),
    ).not.toThrow();
    expect(() =>
      projectGenericOperationResult({
        kind: 'model',
        schema: 'bounded/v1',
        data: nested(11),
      }),
    ).toThrow(/GENERIC_OPERATION_PROJECTION_INVALID/);
  });
});
