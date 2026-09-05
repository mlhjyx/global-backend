import { describe, expect, it } from 'vitest';
import { boundedModelTokenCount, boundedModelUsage } from './model-usage-boundary';

describe('durable model token facts', () => {
  it.each([undefined, null, '12', -1, 0.1, NaN, Infinity, 1_000_000_001, Number.MAX_SAFE_INTEGER])(
    'drops invalid or out-of-bound counter %s', (value) => {
      expect(boundedModelTokenCount(value)).toBeUndefined();
    },
  );
  it.each([0, 1, 1_000_000_000])('retains an exact supported counter %s', (value) => {
    expect(boundedModelTokenCount(value)).toBe(value);
  });
  it('preserves settlement observations without mutating provider facts', () => {
    const original = Object.freeze({ inputTokens: 3_000_000_000, outputTokens: 4, gatewaySettlements: [] });
    expect(boundedModelUsage(original)).toEqual({ inputTokens: undefined, outputTokens: 4, gatewaySettlements: [] });
    expect(original.inputTokens).toBe(3_000_000_000);
  });
});
