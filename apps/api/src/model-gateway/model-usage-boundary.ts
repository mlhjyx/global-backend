import type { ModelUsage } from './types';

export const MODEL_USAGE_TOKEN_MAXIMUM = 1_000_000_000;

export function boundedModelTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= MODEL_USAGE_TOKEN_MAXIMUM ? value : undefined;
}

/** Invalid provider counters are absent facts, never a reason to discard output. */
export function boundedModelUsage(usage: ModelUsage): ModelUsage {
  return {
    ...usage,
    inputTokens: boundedModelTokenCount(usage.inputTokens),
    outputTokens: boundedModelTokenCount(usage.outputTokens),
  };
}
