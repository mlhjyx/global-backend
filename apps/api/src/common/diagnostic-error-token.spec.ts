import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { diagnosticErrorToken } from './diagnostic-error-token';

const digest = (value: string): string =>
  `ERROR_TEXT_SHA256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

describe('diagnosticErrorToken', () => {
  it('hashes Error messages without retaining the untrusted diagnostic', () => {
    const token = diagnosticErrorToken(new Error('provider echoed private input'));
    expect(token).toBe(digest('provider echoed private input'));
    expect(token).not.toContain('private input');
  });

  it.each([
    ['string', 'bounded diagnostic', 'bounded diagnostic'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['number', 42, '42'],
  ])('normalizes the %s branch deterministically', (_label, value, normalized) => {
    expect(diagnosticErrorToken(value)).toBe(digest(normalized as string));
  });

  it('preserves an existing diagnostic token so cross-boundary correlation stays stable', () => {
    const token = digest('provider echoed private input');
    expect(diagnosticErrorToken(token)).toBe(token);
  });

  it('fails closed when an arbitrary thrown value has a hostile toString', () => {
    const hostile = {
      toString(): string {
        throw new Error('sensitive toString failure');
      },
    };
    expect(() => diagnosticErrorToken(hostile)).not.toThrow();
    expect(diagnosticErrorToken(hostile)).toBe(digest('unprintable'));
  });
});
