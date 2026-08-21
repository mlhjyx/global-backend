import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PRIVACY_CLASSES,
  isDurableResultStrategy,
  TYPED_PROJECTION_SCHEMAS,
  type DurableResultStrategy,
} from './durable-result-strategy';

const validArtifact = Object.freeze({
  kind: 'artifact_reference',
  schema: 'sanctions-download/v1',
  maxBytes: 1,
  mediaTypes: Object.freeze(['application/xml']),
  privacyClass: 'PUBLIC_ORGANIZATION',
  ttlSeconds: 1,
} as const satisfies DurableResultStrategy);

function withoutArtifactKey(key: string): Record<string, unknown> {
  const candidate = { ...validArtifact } as Record<string, unknown>;
  delete candidate[key];
  return candidate;
}

function artifactProperty(
  key: string | symbol,
  descriptor: PropertyDescriptor,
): Record<string | symbol, unknown> {
  const candidate = { ...validArtifact } as Record<string | symbol, unknown>;
  Object.defineProperty(candidate, key, descriptor);
  return candidate;
}

function mediaProperty(
  key: string | symbol,
  descriptor: PropertyDescriptor,
): unknown {
  const mediaTypes = ['application/xml'];
  Object.defineProperty(mediaTypes, key, descriptor);
  return { ...validArtifact, mediaTypes };
}

function mediaWithCustomPrototype(): unknown {
  const mediaTypes = ['application/xml'];
  Object.setPrototypeOf(mediaTypes, Object.create(Array.prototype));
  return { ...validArtifact, mediaTypes };
}

const invalidArtifactCases: ReadonlyArray<readonly [string, () => unknown]> = [
  ['incomplete declaration', () => ({ kind: 'artifact_reference', schema: 'x/v1' })],
  ['maxBytes zero', () => ({ ...validArtifact, maxBytes: 0 })],
  ['maxBytes negative', () => ({ ...validArtifact, maxBytes: -1 })],
  ['maxBytes fractional', () => ({ ...validArtifact, maxBytes: 1.5 })],
  ['maxBytes NaN', () => ({ ...validArtifact, maxBytes: Number.NaN })],
  ['maxBytes Infinity', () => ({ ...validArtifact, maxBytes: Number.POSITIVE_INFINITY })],
  ['maxBytes unsafe', () => ({ ...validArtifact, maxBytes: Number.MAX_SAFE_INTEGER + 1 })],
  ['maxBytes wrong type', () => ({ ...validArtifact, maxBytes: '1' })],
  ['maxBytes BigInt', () => ({ ...validArtifact, maxBytes: 1n })],
  ['ttlSeconds zero', () => ({ ...validArtifact, ttlSeconds: 0 })],
  ['ttlSeconds negative', () => ({ ...validArtifact, ttlSeconds: -1 })],
  ['ttlSeconds fractional', () => ({ ...validArtifact, ttlSeconds: 1.5 })],
  ['ttlSeconds NaN', () => ({ ...validArtifact, ttlSeconds: Number.NaN })],
  ['ttlSeconds Infinity', () => ({ ...validArtifact, ttlSeconds: Number.POSITIVE_INFINITY })],
  ['ttlSeconds unsafe', () => ({ ...validArtifact, ttlSeconds: Number.MAX_SAFE_INTEGER + 1 })],
  ['ttlSeconds wrong type', () => ({ ...validArtifact, ttlSeconds: '1' })],
  ['ttlSeconds BigInt', () => ({ ...validArtifact, ttlSeconds: 1n })],
  ['privacy missing', () => withoutArtifactKey('privacyClass')],
  ['privacy null', () => ({ ...validArtifact, privacyClass: null })],
  ['privacy number', () => ({ ...validArtifact, privacyClass: 1 })],
  ['privacy object', () => ({ ...validArtifact, privacyClass: {} })],
  ['privacy unknown', () => ({ ...validArtifact, privacyClass: 'PUBLIC' })],
  ['schema blank', () => ({ ...validArtifact, schema: '' })],
  ['schema whitespace-only', () => ({ ...validArtifact, schema: '   ' })],
  ['schema untrimmed', () => ({ ...validArtifact, schema: ' schema/v1' })],
  ['schema over 256 characters', () => ({ ...validArtifact, schema: 's'.repeat(257) })],
  ['media empty', () => ({ ...validArtifact, mediaTypes: [] })],
  ['media blank', () => ({ ...validArtifact, mediaTypes: [''] })],
  ['media whitespace-only', () => ({ ...validArtifact, mediaTypes: ['   '] })],
  ['media untrimmed', () => ({ ...validArtifact, mediaTypes: [' text/plain'] })],
  ['media over 128 characters', () => ({ ...validArtifact, mediaTypes: ['m'.repeat(129)] })],
  ['unexpected top-level key', () => ({ ...validArtifact, unexpected: true })],
  ['top-level nonenumerable', () => artifactProperty('schema', {
    enumerable: false, value: 'sanctions-download/v1',
  })],
  ['top-level accessor', () => artifactProperty('schema', {
    enumerable: true, get: () => 'sanctions-download/v1',
  })],
  ['top-level symbol', () => artifactProperty(Symbol('hidden'), {
    enumerable: true, value: true,
  })],
  ['top-level custom prototype', () => Object.assign(
    Object.create({ custom: true }), validArtifact,
  )],
  ['top-level null prototype', () => Object.assign(Object.create(null), validArtifact)],
  ['top-level Proxy', () => new Proxy(validArtifact, {})],
  ['media sparse', () => ({ ...validArtifact, mediaTypes: new Array<string>(1) })],
  ['media extra property', () => mediaProperty('extra', { enumerable: true, value: true })],
  ['media accessor', () => mediaProperty('0', {
    configurable: true, enumerable: true, get: () => 'application/xml',
  })],
  ['media nonenumerable', () => mediaProperty('0', {
    configurable: true, enumerable: false, value: 'application/xml',
  })],
  ['media symbol', () => mediaProperty(Symbol('hidden'), { enumerable: true, value: true })],
  ['media custom prototype', mediaWithCustomPrototype],
  ['media Proxy', () => ({
    ...validArtifact, mediaTypes: new Proxy(['application/xml'], {}),
  })],
];

describe('isDurableResultStrategy', () => {
  it('accepts an exact artifact declaration', () => {
    expect(isDurableResultStrategy(validArtifact)).toBe(true);
  });

  it.each(invalidArtifactCases)('rejects malformed artifact declaration: %s', (_name, make) => {
    expect(isDurableResultStrategy(make())).toBe(false);
  });

  it.each(['01', '4294967295', '9007199254740991'])(
    'rejects a media array with non-index own key %s',
    (key) => {
      const candidate = mediaProperty(key, {
        enumerable: true,
        value: { hidden: true },
      });
      let result: boolean | undefined;

      expect(() => {
        result = isDurableResultStrategy(candidate);
      }).not.toThrow();
      expect(result).toBe(false);
    },
  );

  it('does not execute an inherited Object.prototype.kind getter', () => {
    const originalKind = Object.getOwnPropertyDescriptor(Object.prototype, 'kind');
    let calls = 0;
    let result: boolean | undefined;
    Object.defineProperty(Object.prototype, 'kind', {
      configurable: true,
      get: () => {
        calls += 1;
        throw new Error('inherited kind getter executed');
      },
    });
    try {
      expect(() => {
        result = isDurableResultStrategy({ schema: 'taxonomy-code/v1' });
      }).not.toThrow();
      expect(result).toBe(false);
      expect(calls).toBe(0);
    } finally {
      if (originalKind) Object.defineProperty(Object.prototype, 'kind', originalKind);
      else delete (Object.prototype as { kind?: unknown }).kind;
    }
  });

  it('rejects unknown typed projection schemas', () => {
    expect(isDurableResultStrategy({
      kind: 'typed_projection', schema: 'unknown/v1',
    })).toBe(false);
  });

  it('freezes exported schema and privacy tuples without weakening private validation', () => {
    expect(Object.isFrozen(TYPED_PROJECTION_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(ARTIFACT_PRIVACY_CLASSES)).toBe(true);
    expect(() => (TYPED_PROJECTION_SCHEMAS as unknown as string[]).push('unknown/v1')).toThrow();
    expect(() => (ARTIFACT_PRIVACY_CLASSES as unknown as string[]).pop()).toThrow();
    expect(isDurableResultStrategy({
      kind: 'typed_projection', schema: 'taxonomy-code/v1',
    })).toBe(true);
  });
});
