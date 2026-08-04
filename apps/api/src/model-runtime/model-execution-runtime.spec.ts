import { describe, expect, it, vi } from 'vitest';
import { ModelExecutionRuntime, TransportDispatchError } from './model-execution-runtime';
import { canonicalDigest, ContextEngine } from './context-engine';
import type { ModelExecutionPlan, ModelObservation, RuntimeTelemetry, TaskModelContract } from './types';

interface Input { name: string }
interface Output { headline: string }

const contract: TaskModelContract<Input, Output> = {
  taskId: 'site_builder.copy',
  version: '2',
  executionMode: 'generative',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  contextPolicy: { version: 'ctx/v1', allowedSourceRefs: ['request:v1'] },
  capabilityRequirements: {},
  reasoningPolicy: { allowed: ['medium'], default: 'medium', reserveTokens: 100 },
  cachePolicy: { mode: 'build-run-replay' },
  retryPolicy: { transportMaxAttempts: 2, contentRepairMaxAttempts: 1 },
  validateOutput: (_input, output) => {
    if (!output.headline) throw new Error('headline missing');
  },
};

const input = { name: 'Acme' };
const prompt = { system: 'policy', user: 'request' };
const context = new ContextEngine().assemble({
  workspaceId: 'ws-1',
  policy: contract.contextPolicy,
  segments: [{
    kind: 'request',
    sourceRef: 'request:v1',
    sourceDigest: canonicalDigest(input),
    sensitivity: 'workspace',
    cacheClass: 'request-local',
    estimatedTokens: 10,
    content: input,
  }],
  budget: { contextWindow: 1_000, outputReserve: 100, reasoningReserve: 100 },
});

const plan: ModelExecutionPlan<Input, Output> = {
  executionId: 'exec-1',
  workspaceId: 'ws-1',
  buildRunId: 'build-1',
  contract,
  input,
  inputDigest: canonicalDigest(input),
  context,
  contextDigest: context.digest,
  promptVersion: 'copy/v2',
  schemaDigest: canonicalDigest(contract.outputSchema),
  requestedAlias: 'gpt-terra',
  resolvedAlias: 'gpt-terra',
  protocol: 'openai_responses',
  reasoning: 'medium',
  sampling: { temperature: 0.2 },
  locale: 'en-US',
  prompt,
};

const observed = (output: Output): ModelObservation<Output> => ({
  output,
  requestedAlias: 'gpt-terra',
  resolvedAlias: 'gpt-terra',
  reportedModel: 'gpt-5.6-terra',
  protocol: 'openai_responses',
  usage: { inputTokens: 10, outputTokens: 5 },
  requestId: 'req-1',
  settlement: 'known',
});

describe('ModelExecutionRuntime', () => {
  it('separates transport retry from one content repair and records the state lifecycle', async () => {
    const sleep = vi.fn(async () => undefined);
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new TransportDispatchError('429', { retryable: true, retryAfterMs: 250 }))
      .mockResolvedValueOnce(observed({ headline: '' }))
      .mockResolvedValueOnce(observed({ headline: 'Precision pumps' }));
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch }, sleep });

    const result = await runtime.execute(plan);

    expect(result.output).toEqual({ headline: 'Precision pumps' });
    expect(result.transportAttempts).toBe(3);
    expect(result.repairAttempts).toBe(1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(result.states).toEqual([
      'planned', 'admitted', 'dispatched', 'dispatched', 'observed', 'repaired',
      'dispatched', 'observed', 'validated', 'settled', 'completed',
    ]);
    expect(dispatch.mock.calls[2]?.[0].repair).toMatchObject({ priorOutputDigest: expect.any(String), findingsDigest: expect.any(String) });
  });

  it('freezes unknown settlement and never repairs or completes it', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ...observed({ headline: 'A' }), settlement: 'unknown' });
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute(plan)).rejects.toMatchObject({ states: ['planned', 'admitted', 'dispatched', 'observed', 'frozen'] });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('freezes a transport observation that changes alias or protocol identity', async () => {
    const dispatch = vi.fn().mockResolvedValue({ ...observed({ headline: 'A' }), resolvedAlias: 'other' });
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute(plan)).rejects.toThrow(/identity/);
  });

  it('treats telemetry as a fail-open side channel', async () => {
    const emit = vi.fn(() => { throw new Error('offline'); });
    const telemetry: RuntimeTelemetry = { emit };
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: { dispatch: vi.fn().mockResolvedValue(observed({ headline: 'A' })) },
      telemetry,
    });

    await expect(runtime.execute(plan)).resolves.toMatchObject({ output: { headline: 'A' } });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: 'medium',
      fallbackIndex: 0,
    }));
  });

  it('never dispatches a deterministic task through the model transport', async () => {
    const dispatch = vi.fn();
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({
      ...plan,
      contract: { ...contract, executionMode: 'deterministic' },
      deterministicExecutor: () => ({ headline: 'Catalog result' }),
    })).resolves.toMatchObject({ output: { headline: 'Catalog result' }, transportAttempts: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('freezes caller-supplied provenance drift before cache lookup or dispatch', async () => {
    const dispatch = vi.fn();
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({ ...plan, inputDigest: '0'.repeat(64) })).rejects.toThrow(/provenance/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
