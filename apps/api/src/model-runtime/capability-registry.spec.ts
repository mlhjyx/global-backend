import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from './capability-registry';
import type { ModelCapabilityProfile } from './types';

const profile: ModelCapabilityProfile = {
  alias: 'gpt-terra',
  protocol: 'openai_responses',
  contextWindow: 32_000,
  maximumOutputTokens: 4_096,
  tokenizer: 'o200k_base',
  structuredOutput: { supported: true, dialects: ['json-schema-2020-12'] },
  reasoningLevels: ['low', 'medium', 'high'],
  nativeCache: { mechanism: 'openai_prompt_cache', proven: false },
  tools: false,
  vision: false,
  image: false,
  streaming: true,
  reportsUsage: true,
  reportsModel: true,
  reportsRequestId: true,
  settlementObservation: 'gateway_log',
  probe: { version: 'probe/v1', observedAt: '2026-08-04T00:00:00.000Z', result: 'passed' },
};

describe('CapabilityRegistry', () => {
  it('returns the exact compatible alias without deleting unsupported requirements', () => {
    const registry = new CapabilityRegistry([profile]);

    expect(registry.negotiate('gpt-terra', {
      protocols: ['openai_responses'],
      structuredOutput: true,
      minimumContextWindow: 16_000,
      minimumOutputTokens: 1_000,
      reasoning: 'high',
      settlementRequired: true,
    })).toEqual(profile);
  });

  it('fails closed on protocol, reasoning, cache, output or retired alias mismatches', () => {
    const registry = new CapabilityRegistry([profile]);

    expect(() => registry.negotiate('gpt-terra', { protocols: ['anthropic_messages'] })).toThrow(/protocol/);
    expect(() => registry.negotiate('gpt-terra', { reasoning: 'max' })).toThrow(/reasoning/);
    expect(() => registry.negotiate('gpt-terra', { nativeCache: true })).toThrow(/native cache/);
    expect(() => registry.negotiate('gpt-terra', { minimumOutputTokens: 8_000 })).toThrow(/output/);
    expect(() => registry.negotiate('minimax-m3', {})).toThrow(/retired/);
    expect(() => registry.negotiate('doubao-seed-2.0-pro', {})).toThrow(/retired/);
  });
});
