import { describe, expect, it } from 'vitest';
import {
  MAX_MICROUSD,
  centsToMicrousd,
  parseCanonicalMicrousd,
  usdToMicrousdCeil,
} from './microusd';

describe('microusd amount arithmetic', () => {
  it.each([
    ['1', 1n],
    ['9999', 9_999n],
    ['10000', 10_000n],
    ['9223372036854775807', 9_223_372_036_854_775_807n],
  ])('accepts canonical BIGINT boundary %s without cent truncation', (raw, expected) => {
    expect(parseCanonicalMicrousd('amount', raw)).toBe(expected);
  });

  it.each([
    '9223372036854775808',
    '-1',
    '01',
    '1.0',
    '1e4',
    '',
  ])('rejects overflow or non-canonical amount %j', (raw) => {
    expect(() => parseCanonicalMicrousd('amount', raw)).toThrow();
  });

  it('converts cents without using a lossy division boundary', () => {
    expect(centsToMicrousd(1)).toBe(10_000n);
    expect(centsToMicrousd(0)).toBe(0n);
    expect(() => centsToMicrousd(Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it.each([
    ['0.000001', 1n],
    ['0.0000001', 1n],
    ['0.000009999', 10n],
    ['0.0123456', 12_346n],
    ['1.0000001', 1_000_001n],
    ['9223372036854.775001', 9_223_372_036_854_775_001n],
  ])('converts fractional USD %s conservatively to %s microusd', (usd, expected) => {
    expect(usdToMicrousdCeil(usd)).toBe(expected);
  });

  it('rejects non-decimal, negative and BIGINT-overflow USD amounts', () => {
    for (const value of ['NaN', 'Infinity', '-0.01', '100000000000000000000']) {
      expect(() => usdToMicrousdCeil(value), String(value)).toThrow();
    }
    expect(() => usdToMicrousdCeil(1 as never)).toThrow();
    expect(MAX_MICROUSD).toBe(9_223_372_036_854_775_807n);
  });

});
