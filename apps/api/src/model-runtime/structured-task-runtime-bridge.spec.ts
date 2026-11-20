import { describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import { PaidOperationUnknownError } from '../site-builder/site-build-cost-ledger';
import { executeStructuredTaskWithRuntime, prepareStructuredTaskRuntimeInput } from './structured-task-runtime-bridge';

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
      maxTokens: 8_192,
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
        contextDigest: '30be3b2cd208713efc02e520520c1b58d074a86f15fbabc58a2fda071c58abe2',
        promptDigest: '4d22a1dd3070202d79063f15e1c2befd1b931e53b88a5cdd12ce192709a5e349',
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

  it('rejects an unregistered structured task before the gateway even with an explicit token cap', async () => {
    const generateStructured = vi.fn();

    await expect(
      executeStructuredTaskWithRuntime(
        { generateStructured } as unknown as ModelGateway,
        {
          task: 'unregistered.task',
          prompt: 'x',
          model: 'deepseek-v4-flash',
          schema,
          maxTokens: 1,
        },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('TASK_MAX_OUTPUT_TOKENS_UNAVAILABLE');
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('rejects a caller token cap above the registered task contract before the gateway', async () => {
    const generateStructured = vi.fn();

    await expect(
      executeStructuredTaskWithRuntime(
        { generateStructured } as unknown as ModelGateway,
        {
          task: 'taxonomy.normalize',
          prompt: 'x',
          model: 'deepseek-v4-flash',
          schema,
          maxTokens: 8_193,
        },
        { workspaceId: 'ws-1' },
      ),
    ).rejects.toThrow('TASK_MAX_OUTPUT_TOKENS_UNAVAILABLE');
    expect(generateStructured).not.toHaveBeenCalled();
  });
});


describe('pure shared structured preparation before budget admission', () => {
  const context = { workspaceId: '11111111-1111-4111-8111-111111111111', correlationId: '66666666-6666-4666-8666-666666666666' };
  const input = { task: 'market.candidates.generate', prompt: 'Full structured synthetic material.', system: 'Hypotheses only.', model: 'deepseek-v4-flash', schema };
  it('returns bounded input and the complete required context without a gateway or grant dependency', () => {
    const prepared = prepareStructuredTaskRuntimeInput(input, context);
    expect(prepared.boundedInput).toEqual({ ...input, maxTokens: 16_000 });
    expect(prepared.envelope).toMatchObject({ workspaceId: context.workspaceId, outputReserve: 16_000, droppedSourceRefs: [] });
    expect(prepared.envelope.segments.map(segment => segment.kind)).toEqual(['policy', 'schema', 'request']);
    expect(prepared.requestMaterial.prompt).toBe(input.prompt);
  });
  it('rejects an aggregate context overflow rather than dropping or truncating required material', () => {
    expect(() => prepareStructuredTaskRuntimeInput({ ...input, prompt: '\\'.repeat(200_000) }, context)).toThrow('required context segments exceed the model context budget');
  });
  it('uses the same token and registration gate before any execution admission', () => {
    expect(() => prepareStructuredTaskRuntimeInput({ ...input, maxTokens: 16_001 }, context)).toThrow('TASK_MAX_OUTPUT_TOKENS_UNAVAILABLE');
    expect(() => prepareStructuredTaskRuntimeInput({ ...input, task: 'unregistered' }, context)).toThrow('TASK_MAX_OUTPUT_TOKENS_UNAVAILABLE');
  });
  it('sends exactly the prepared bounded input and preserves its frozen context identity', async () => {
    const prepared = prepareStructuredTaskRuntimeInput(input, context);
    const generateStructured = vi.fn(async () => ({ data: { code: 'synthetic' }, provider: 'synthetic', model: input.model, usage: { inputTokens: 1, outputTokens: 1 } }));
    const result = await executeStructuredTaskWithRuntime({ generateStructured } as unknown as ModelGateway, input, context);
    expect(generateStructured).toHaveBeenCalledExactlyOnceWith(prepared.boundedInput, context);
    expect(result.runtimeExecution.contextDigest).toBe(prepared.envelope.digest);
  });
});
