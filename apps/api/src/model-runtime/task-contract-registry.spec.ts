import { describe, expect, it } from 'vitest';
import { TaskContractRegistry } from './task-contract-registry';
import type { TaskModelContract } from './types';

function contract(version = '1.0.0'): TaskModelContract<{ name: string }, { headline: string }> {
  return {
    taskId: 'site_builder.copy',
    version,
    executionMode: 'generative',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    contextPolicy: { version: 'copy-context/v1', allowedSourceRefs: ['claims:v1'] },
    capabilityRequirements: {
      protocols: ['openai_responses'],
      structuredOutput: true,
      minimumContextWindow: 8_000,
      minimumOutputTokens: 512,
    },
    reasoningPolicy: { allowed: ['low', 'medium'], default: 'medium', reserveTokens: 256 },
    cachePolicy: { mode: 'build-run-replay' },
    retryPolicy: { transportMaxAttempts: 2, contentRepairMaxAttempts: 1 },
    validateOutput: (_input, output) => {
      if (!output.headline) throw new Error('headline is required');
    },
  };
}

describe('TaskContractRegistry', () => {
  it('resolves contracts by the immutable task id and version pair', () => {
    const registry = new TaskContractRegistry([contract('1.0.0'), contract('2.0.0')]);

    expect(registry.get('site_builder.copy', '1.0.0').version).toBe('1.0.0');
    expect(registry.get('site_builder.copy', '2.0.0').version).toBe('2.0.0');
  });

  it('rejects duplicate registrations and missing versions', () => {
    const registry = new TaskContractRegistry([contract()]);

    expect(() => registry.register(contract())).toThrow(/already registered/);
    expect(() => registry.get('site_builder.copy', 'missing')).toThrow(/not registered/);
  });

  it('stores an immutable snapshot instead of a caller-owned mutable contract', () => {
    const mutable = contract();
    const registry = new TaskContractRegistry([mutable]);
    mutable.contextPolicy.allowedSourceRefs = ['changed'];

    const stored = registry.get('site_builder.copy', '1.0.0');
    expect(stored.contextPolicy.allowedSourceRefs).toEqual(['claims:v1']);
    expect(Object.isFrozen(stored.contextPolicy.allowedSourceRefs)).toBe(true);
  });
});
