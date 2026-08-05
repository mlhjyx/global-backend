import { describe, expect, it, vi } from 'vitest';
import {
  getTrustedModelExecutionMetadata,
  ModelExecutionRuntime,
  TransportDispatchError,
} from './model-execution-runtime';
import { canonicalDigest, ContextEngine } from './context-engine';
import type {
  ExactResultCache,
  ModelExecutionPlan,
  ModelObservation,
  RuntimeTelemetry,
  TaskModelContract,
} from './types';

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

function mockCache(cached?: { output: Output; settlement: 'known'; validated: true }): ExactResultCache {
  return {
    get: vi.fn().mockResolvedValue(cached),
    put: vi.fn().mockResolvedValue(undefined),
    putRepair: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ModelExecutionRuntime', () => {
  it('records transport retry separately and brands a valid completion', async () => {
    const sleep = vi.fn(async () => undefined);
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new TransportDispatchError('429', { retryable: true, retryAfterMs: 250 }))
      .mockResolvedValueOnce(observed({ headline: 'Precision pumps' }));
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch }, sleep });

    const result = await runtime.execute(plan);

    expect(result.output).toEqual({ headline: 'Precision pumps' });
    expect(result.transportAttempts).toBe(2);
    expect(result.repairAttempts).toBe(0);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(result.states).toEqual([
      'planned', 'admitted', 'dispatched', 'dispatched', 'observed',
      'validated', 'settled', 'completed',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.states)).toBe(true);
    expect(getTrustedModelExecutionMetadata(result)).toMatchObject({
      executionId: 'exec-1',
      taskId: 'site_builder.copy',
      taskVersion: '2',
      requestedAlias: 'gpt-terra',
      resolvedAlias: 'gpt-terra',
      reportedModel: 'gpt-5.6-terra',
      protocol: 'openai_responses',
      reasoning: 'medium',
      cacheMode: 'build-run-replay',
      settlement: 'known',
      outputDigest: canonicalDigest(result.output),
      cacheHit: false,
    });
    expect(getTrustedModelExecutionMetadata({
      ...result,
      states: [...result.states],
    })).toBeUndefined();
  });

  it('uses the bounded default sleep when a retry has no injected scheduler', async () => {
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new TransportDispatchError('busy', { retryable: true, retryAfterMs: 1 }))
      .mockResolvedValueOnce(observed({ headline: 'Recovered' }));
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute(plan)).resolves.toMatchObject({
      output: { headline: 'Recovered' },
      transportAttempts: 2,
    });
  });

  it('freezes a settled invalid output without dispatching an unbound repair', async () => {
    const dispatch = vi.fn().mockResolvedValue(observed({ headline: '' }));
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute(plan)).rejects.toMatchObject({
      message: 'model output validation failed; Runtime content repair is not admitted',
      states: ['planned', 'admitted', 'dispatched', 'observed', 'frozen'],
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
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

  it.each([
    ['request ID', { reportsRequestId: true }, { requestId: undefined }, /request ID/],
    ['usage', { reportsUsage: true }, { usageComplete: false }, /usage/],
    ['reported model', { reportsModel: true }, { reportedModel: undefined }, /reported model/],
    ['exact model', { exactReportedModel: true }, { reportedModel: 'different' }, /not exact/],
    ['warnings', { forbidWarnings: true }, { warnings: ['reasoning_removed'] }, /warnings/],
  ])('enforces the admitted %s observation requirement', async (
    _name,
    requirements,
    observationDrift,
    expected,
  ) => {
    const strictPlan = {
      ...plan,
      contract: { ...contract, capabilityRequirements: requirements },
    };
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: {
        dispatch: vi.fn().mockResolvedValue({
          ...observed({ headline: 'A' }),
          ...observationDrift,
        }),
      },
    });

    await expect(runtime.execute(strictPlan)).rejects.toThrow(expected);
  });

  it('completes when every strict observation requirement is satisfied', async () => {
    const strictPlan = {
      ...plan,
      contract: {
        ...contract,
        capabilityRequirements: {
          reportsUsage: true,
          reportsModel: true,
          reportsRequestId: true,
          exactReportedModel: true,
          forbidWarnings: true,
        },
      },
    };
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: {
        dispatch: vi.fn().mockResolvedValue({
          ...observed({ headline: 'A' }),
          reportedModel: 'gpt-terra',
          usageComplete: true,
          warnings: [],
        }),
      },
    });

    await expect(runtime.execute(strictPlan)).resolves.toMatchObject({
      output: { headline: 'A' },
      states: ['planned', 'admitted', 'dispatched', 'observed', 'validated', 'settled', 'completed'],
    });
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

  it('replays a validated exact cache hit without dispatch', async () => {
    const dispatch = vi.fn();
    const cache = mockCache({ output: { headline: 'Cached' }, settlement: 'known', validated: true });
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch }, cache });

    await expect(runtime.execute(plan)).resolves.toMatchObject({
      output: { headline: 'Cached' },
      cacheHit: true,
      transportAttempts: 0,
      states: ['planned', 'admitted', 'validated', 'completed'],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('freezes an invalid exact cache hit instead of dispatching', async () => {
    const dispatch = vi.fn();
    const cache = mockCache({ output: { headline: '' }, settlement: 'known', validated: true });
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch }, cache });

    await expect(runtime.execute(plan)).rejects.toThrow(/cached model output validation failed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('stores only a validated known-settlement result in the exact cache', async () => {
    const cache = mockCache();
    const runtime = new ModelExecutionRuntime<Input, Output>({
      transport: { dispatch: vi.fn().mockResolvedValue(observed({ headline: 'Stored' })) },
      cache,
    });

    await runtime.execute(plan);

    expect(cache.put).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'site_builder.copy',
      resolvedAlias: 'gpt-terra',
    }), {
      output: { headline: 'Stored' },
      settlement: 'known',
      validated: true,
    });
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

  it('freezes a deterministic task without an admitted local executor', async () => {
    const dispatch = vi.fn();
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({
      ...plan,
      contract: { ...contract, executionMode: 'deterministic' },
    })).rejects.toThrow(/missing its local executor/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('freezes a deterministic result that fails its task validator', async () => {
    const dispatch = vi.fn();
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({
      ...plan,
      contract: { ...contract, executionMode: 'deterministic' },
      deterministicExecutor: () => ({ headline: '' }),
    })).rejects.toThrow(/deterministic output validation failed/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('freezes caller-supplied provenance drift before cache lookup or dispatch', async () => {
    const dispatch = vi.fn();
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({ ...plan, inputDigest: '0'.repeat(64) })).rejects.toThrow(/provenance/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('freezes a digest-valid context containing an undeclared source', async () => {
    const dispatch = vi.fn();
    const segments = [{ ...context.segments[0], sourceRef: 'undeclared:v1' }];
    const { digest: _digest, ...contextMaterial } = context;
    const unauthorizedContext = {
      ...contextMaterial,
      segments,
      digest: canonicalDigest({ ...contextMaterial, segments }),
    };
    const runtime = new ModelExecutionRuntime<Input, Output>({ transport: { dispatch } });

    await expect(runtime.execute({
      ...plan,
      context: unauthorizedContext,
      contextDigest: unauthorizedContext.digest,
    })).rejects.toThrow(/provenance/);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
