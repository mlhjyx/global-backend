import { describe, expect, it } from 'vitest';
import { parseArtifactReference } from './artifact-reference.schema';

const VALID_REFERENCE = {
  schemaVersion: 'generic-operation-artifact-ref/v1',
  artifactId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  operationId: '120a4e9f-0c06-4cb4-8364-b7df51c45a88',
  resultSchema: 'sanctions-download/v1',
  sha256: 'ab'.padEnd(64, '0'),
  sizeBytes: '1234567',
  mediaType: 'application/xml',
  expiresAt: '2026-08-22T00:00:00.000Z',
} as const;

function expectInvalid(value: unknown): void {
  expect(() => parseArtifactReference(value)).toThrow(
    'GENERIC_OPERATION_ARTIFACT_INVALID',
  );
}

describe('parseArtifactReference', () => {
  it('accepts the exact small reference shape without a body or storage key', () => {
    expect(parseArtifactReference(VALID_REFERENCE)).toEqual(VALID_REFERENCE);
  });

  it.each([
    ['an object key', { objectKey: 'caller-controlled' }],
    ['a body', { body: 'sensitive result' }],
    ['request headers', { headers: { authorization: 'secret' } }],
    ['a prompt', { prompt: 'private instruction' }],
    ['model tokens', { tokens: 'secret' }],
    ['an email address', { email: 'person@example.test' }],
  ])('rejects an extra caller-controlled field carrying %s', (_label, extra) => {
    expectInvalid({ ...VALID_REFERENCE, ...extra });
  });

  it.each([
    ['a non-UUID artifact id', { artifactId: 'not-a-uuid' }],
    ['an uppercase UUID', { artifactId: VALID_REFERENCE.artifactId.toUpperCase() }],
    ['a non-UUID operation id', { operationId: 'not-a-uuid' }],
    ['an uppercase SHA-256 digest', { sha256: VALID_REFERENCE.sha256.toUpperCase() }],
    ['a short SHA-256 digest', { sha256: 'a'.repeat(63) }],
    ['a size with a leading zero', { sizeBytes: '012' }],
    ['a signed size', { sizeBytes: '+12' }],
    ['a size beyond signed 64-bit range', { sizeBytes: '9223372036854775808' }],
    ['an invalid media type', { mediaType: 'not a media type' }],
    ['an oversized media type', { mediaType: `application/${'a'.repeat(160)}` }],
    ['an invalid RFC3339 expiry', { expiresAt: '2026-02-30T00:00:00.000Z' }],
  ])('rejects %s', (_label, mutation) => {
    expectInvalid({ ...VALID_REFERENCE, ...mutation });
  });

  it.each([
    ['an offset UTC representation', '2026-08-22T08:00:00.000+08:00'],
    ['a UTC representation without milliseconds', '2026-08-22T00:00:00Z'],
    ['a lowercase RFC3339 representation', '2026-08-22t00:00:00.000z'],
  ])('rejects a non-canonical expiry representation: %s', (_label, expiresAt) => {
    expectInvalid({ ...VALID_REFERENCE, expiresAt });
  });

  it.each([
    ['a Proxy', new Proxy({ ...VALID_REFERENCE }, {})],
    ['a null-prototype object', Object.assign(Object.create(null), VALID_REFERENCE)],
    [
      'a custom-prototype object',
      Object.assign(Object.create({}), VALID_REFERENCE),
    ],
  ])('rejects %s before schema validation', (_label, value) => {
    expectInvalid(value);
  });

  it.each([
    ['objectKey', 'caller-controlled'],
    ['body', 'sensitive result'],
  ])('rejects a non-enumerable forbidden %s', (key, value) => {
    const input = { ...VALID_REFERENCE };
    Object.defineProperty(input, key, {
      configurable: true,
      enumerable: false,
      value,
    });

    expectInvalid(input);
  });

  it('rejects symbol and non-enumerable toJSON own keys', () => {
    const input = { ...VALID_REFERENCE };
    Object.defineProperty(input, Symbol('body'), {
      configurable: true,
      enumerable: false,
      value: 'sensitive result',
    });
    Object.defineProperty(input, 'toJSON', {
      configurable: true,
      enumerable: false,
      value: () => VALID_REFERENCE,
    });

    expectInvalid(input);
  });

  it('rejects an alternating accessor without reading it', () => {
    const input = { ...VALID_REFERENCE };
    let reads = 0;
    Object.defineProperty(input, 'sha256', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return reads % 2 === 0 ? 'not-a-digest' : VALID_REFERENCE.sha256;
      },
    });

    expectInvalid(input);
    expect(reads).toBe(0);
  });

  it('contains a throwing accessor behind the bounded invalid error', () => {
    const input = { ...VALID_REFERENCE };
    let reads = 0;
    Object.defineProperty(input, 'expiresAt', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error('untrusted getter error');
      },
    });

    expectInvalid(input);
    expect(reads).toBe(0);
  });

  it('rejects cyclic input without surfacing a reflection or validator error', () => {
    const input: Record<string, unknown> = { ...VALID_REFERENCE };
    input.resultSchema = input;

    expectInvalid(input);
  });
});
