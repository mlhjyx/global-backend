import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import { PaidOperationUnknownError } from '../site-builder/site-build-cost-ledger';
import { executeStructuredTaskWithRuntime } from './structured-task-runtime-bridge';

const schema = {
  type: 'object',
  required: ['code'],
  properties: { code: { type: ['string', 'null'] } },
};

describe('executeStructuredTaskWithRuntime', () => {
  it('wraps the existing gateway in one legacy-chat transport attempt and exposes runtime provenance', async () => {
    const generateStructured = vi.fn(async () => ({
      data: { code: '123' },
      provider: 'gateway',
      model: 'deepseek-upstream-drift',
      reportedModel: 'deepseek-v4-flash-20260804',
      modelResolutionSource: 'upstream_response' as const,
      usage: { inputTokens: 10, outputTokens: 2 },
      callCount: 2,
    }));

    const result = await executeStructuredTaskWithRuntime(
      { generateStructured } as unknown as ModelGateway,
      {
        task: 'taxonomy.normalize',
        prompt: 'Normalize pumps.',
        system: 'Return one code.',
        model: 'deepseek-v4-flash',
        schema,
      },
      { workspaceId: 'ws-1', runId: 'run-1' },
    );

    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(generateStructured.mock.calls[0]?.[0]).toMatchObject({
      task: 'taxonomy.normalize',
      model: 'deepseek-v4-flash',
      prompt: 'Normalize pumps.',
    });
    expect(result).toMatchObject({
      data: { code: '123' },
      provider: 'gateway',
      reportedModel: 'deepseek-v4-flash-20260804',
      runtimeExecution: {
        protocol: 'openai_chat_completions',
        transportAttempts: 1,
        repairAttempts: 0,
        physicalCalls: 2,
        gatewayRepairCalls: 1,
        requestedAlias: 'deepseek-v4-flash',
        runtimeResolvedAlias: 'deepseek-v4-flash',
        gatewayResolvedModel: 'deepseek-upstream-drift',
        provider: 'gateway',
        reportedModel: 'deepseek-v4-flash-20260804',
        modelResolutionSource: 'upstream_response',
        contextDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        states: ['planned', 'admitted', 'dispatched', 'observed', 'validated', 'settled', 'completed'],
      },
    });
  });

  it('preserves terminal paid-settlement errors instead of wrapping or retrying them', async () => {
    const error = new PaidOperationUnknownError('a'.repeat(64), 'SETTLEMENT_ACK_UNKNOWN');
    const generateStructured = vi.fn(async () => { throw error; });

    await expect(executeStructuredTaskWithRuntime(
      { generateStructured } as unknown as ModelGateway,
      { task: 'taxonomy.normalize', prompt: 'x', model: 'deepseek-v4-flash', schema },
      { workspaceId: 'ws-1', runId: 'run-1' },
    )).rejects.toBe(error);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });

  it('validates output from every provider without a provider-id bypass', async () => {
    const generateStructured = vi.fn(async () => ({
      data: { code: null },
      provider: 'stub',
      model: 'stub-v0',
    }));

    await expect(executeStructuredTaskWithRuntime(
      { generateStructured } as unknown as ModelGateway,
      { task: 'taxonomy.normalize', prompt: 'x', model: 'deepseek-v4-flash', schema: { ...schema, properties: { code: { type: 'string' } } } },
      { workspaceId: 'ws-1' },
    )).rejects.toThrow(/output invalid/i);
  });

  it('freezes a paid execution when the gateway returns no settlement observation', async () => {
    const generateStructured = vi.fn(async () => ({
      data: { code: '123' },
      provider: 'gateway',
      model: 'deepseek-v4-flash',
    }));

    await expect(executeStructuredTaskWithRuntime(
      { generateStructured } as unknown as ModelGateway,
      { task: 'taxonomy.normalize', prompt: 'x', model: 'deepseek-v4-flash', schema },
      { workspaceId: 'ws-1', runId: 'run-1', paidCost: {} as never },
    )).rejects.toThrow(/settlement is unknown/);
    expect(generateStructured).toHaveBeenCalledTimes(1);
  });
});
