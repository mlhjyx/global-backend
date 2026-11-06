import { afterEach, describe, expect, it, vi } from 'vitest';

import { centsFromTokens } from './model-token-cost';

describe('model token cost (upper-bound estimate)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prices tokens at the shared upper-bound rate with a one-cent floor', () => {
    expect(centsFromTokens({})).toBeNull();
    expect(centsFromTokens({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(centsFromTokens({ inputTokens: 7, outputTokens: 3 })).toBe(1);
    expect(centsFromTokens({ inputTokens: 600_000, outputTokens: 400_000 })).toBe(100);
  });

  it('reads LLM_CENTS_PER_MTOK and falls back on invalid values', () => {
    vi.stubEnv('LLM_CENTS_PER_MTOK', '50');
    expect(centsFromTokens({ inputTokens: 1_000_000 })).toBe(50);
    vi.stubEnv('LLM_CENTS_PER_MTOK', 'banana');
    expect(centsFromTokens({ inputTokens: 1_000_000 })).toBe(100);
    vi.stubEnv('LLM_CENTS_PER_MTOK', '0');
    expect(centsFromTokens({ inputTokens: 1_000_000 })).toBe(100);
  });
});
