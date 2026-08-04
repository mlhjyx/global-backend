import { describe, expect, it } from 'vitest';
import { canonicalDigest, ContextEngine } from './context-engine';
import { PromptCompiler } from './prompt-compiler';
import type { ModelCapabilityProfile, TaskModelContract } from './types';

const contract: TaskModelContract<{ request: string }, { value: string }> = {
  taskId: 'site_builder.copy',
  version: 'copy/v2',
  executionMode: 'generative',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  contextPolicy: { version: 'copy-context/v2', allowedSourceRefs: ['policy:v1', 'request:v1'] },
  capabilityRequirements: { protocols: ['openai_responses'], structuredOutput: true, reasoning: 'medium' },
  reasoningPolicy: { allowed: ['medium'], default: 'medium', reserveTokens: 100 },
  cachePolicy: { mode: 'exact' },
  retryPolicy: { transportMaxAttempts: 1, contentRepairMaxAttempts: 1 },
  validateOutput: () => undefined,
};

const profile: ModelCapabilityProfile = {
  alias: 'gpt-5.6-terra',
  protocol: 'openai_responses',
  contextWindow: 128_000,
  maximumOutputTokens: 8_192,
  tokenizer: 'provider-reported',
  structuredOutput: { supported: true, dialects: ['json-schema'] },
  reasoningLevels: ['medium'],
  nativeCache: { mechanism: 'stable-prefix', proven: false },
  tools: false,
  vision: false,
  image: false,
  streaming: false,
  reportsUsage: true,
  reportsModel: true,
  reportsRequestId: true,
  settlementObservation: 'gateway_log',
  probe: { version: 'probe/v1', observedAt: '2026-08-04T00:00:00.000Z', result: 'passed' },
};

function context() {
  const segments = [
    { kind: 'policy' as const, sourceRef: 'policy:v1', content: { safety: true }, cacheClass: 'stable-prefix' as const },
    { kind: 'request' as const, sourceRef: 'request:v1', content: { request: 'write' }, cacheClass: 'request-local' as const },
  ].map((segment) => ({ ...segment, sourceDigest: canonicalDigest(segment.content), sensitivity: 'workspace' as const, estimatedTokens: 2 }));
  return new ContextEngine().assemble({
    workspaceId: 'ws-1',
    policy: contract.contextPolicy,
    segments,
    budget: { contextWindow: 128_000, outputReserve: 2_000, reasoningReserve: 100 },
  });
}

describe('PromptCompiler', () => {
  it('preserves the negotiated native protocol and leaves unproven native caching disabled', () => {
    const result = new PromptCompiler().compile({ contract, context: context(), capability: profile, reasoning: 'medium' });
    expect(result).toMatchObject({
      taskId: 'site_builder.copy',
      alias: 'gpt-5.6-terra',
      protocol: 'openai_responses',
      reasoning: 'medium',
      providerOptions: { nativeCache: { enabled: false } },
    });
    expect(result.segments.map((segment) => segment.kind)).toEqual(['policy', 'request']);
  });

  it('rejects a protocol or reasoning mismatch before compilation', () => {
    expect(() => new PromptCompiler().compile({
      contract,
      context: context(),
      capability: { ...profile, protocol: 'anthropic_messages' },
      reasoning: 'medium',
    })).toThrow(/protocol/);
    expect(() => new PromptCompiler().compile({ contract, context: context(), capability: profile, reasoning: 'high' })).toThrow(/reasoning/);
  });
});
