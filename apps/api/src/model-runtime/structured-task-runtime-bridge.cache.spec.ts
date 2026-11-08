import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelGateway } from '../model-gateway/model-gateway';
import { executeStructuredTaskWithRuntime } from './structured-task-runtime-bridge';
import { configureLlmResultCache, type LlmResultCachePort } from './llm-result-cache';

const schema = {
  type: 'object',
  required: ['industry', 'summary'],
  additionalProperties: false,
  properties: { industry: { type: 'string' }, summary: { type: 'string' } },
};

const VALID_OUTPUT = { industry: 'metal fabrication', summary: 'A pump distributor.' };

function gatewayReturning(data: unknown = VALID_OUTPUT) {
  return {
    generateStructured: vi.fn(async () => ({
      data,
      provider: 'gateway',
      model: 'deepseek-flash',
    })),
  } as unknown as ModelGateway & { generateStructured: ReturnType<typeof vi.fn> };
}

function memoryPort(): LlmResultCachePort & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (workspaceId: string, key: string) => {
      const composite = `${workspaceId}:${key}`;
      return store.has(composite) ? { result: store.get(composite) } : null;
    }),
    put: vi.fn(async (workspaceId: string, key: string, _task: string, result: unknown) => {
      store.set(`${workspaceId}:${key}`, result);
    }),
  };
}

function callProfile(gateway: ModelGateway, prompt = 'Company homepage text.') {
  return executeStructuredTaskWithRuntime(
    gateway,
    {
      task: 'company_understanding.extract_profile',
      prompt,
      model: 'deepseek-v4-flash',
      schema,
    },
    { workspaceId: 'ws-cache-1', runId: 'run-cache-1' },
  );
}

afterEach(() => {
  configureLlmResultCache(null);
  vi.unstubAllEnvs();
});

describe('executeStructuredTaskWithRuntime llm cache (PR-B)', () => {
  it('serves the second identical call from cache without touching the gateway', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);

    const firstGateway = gatewayReturning();
    const first = await callProfile(firstGateway);
    expect(firstGateway.generateStructured).toHaveBeenCalledTimes(1);
    expect(port.put).toHaveBeenCalledTimes(1);
    expect(first.runtimeExecution.cacheHit).toBeUndefined();

    const secondGateway = gatewayReturning();
    const second = await callProfile(secondGateway);

    expect(secondGateway.generateStructured).not.toHaveBeenCalled();
    expect(second.data).toEqual(VALID_OUTPUT);
    expect(second.provider).toBe('llm-cache');
    expect(second.callCount).toBe(0);
    expect(second.runtimeExecution.cacheHit).toBe(true);
    expect(second.runtimeExecution.physicalCalls).toBe(0);
    expect(second.usage).toBeUndefined();
  });

  it('misses when the prompt changes (full-input digest is part of the key)', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning());

    const gateway = gatewayReturning();
    await callProfile(gateway, 'A different homepage text.');
    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
  });

  it('misses when the requested model field changes (model is part of the request digest)', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning());

    const gateway = gatewayReturning();
    await executeStructuredTaskWithRuntime(
      gateway,
      {
        task: 'company_understanding.extract_profile',
        prompt: 'Company homepage text.',
        model: 'another-model',
        schema,
      },
      { workspaceId: 'ws-cache-1', runId: 'run-cache-2' },
    );
    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the cached result no longer satisfies the schema', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning());
    const [composite] = [...port.store.keys()];
    port.store.set(composite!, { industry: 42 });

    const gateway = gatewayReturning();
    const result = await callProfile(gateway);

    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(VALID_OUTPUT);
  });

  it('passes through when evicted by ACQ_LLM_CACHE=off', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning());

    vi.stubEnv('ACQ_LLM_CACHE', 'off');
    const gateway = gatewayReturning();
    await callProfile(gateway);

    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
    expect(port.get).toHaveBeenCalledTimes(1); // 只有第一次（on）查过
  });

  it('never caches tasks the registry does not mark cacheable', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);

    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: { code: '123' },
        provider: 'gateway',
        model: 'deepseek-flash',
      })),
    } as unknown as ModelGateway;

    await executeStructuredTaskWithRuntime(
      gateway,
      {
        task: 'taxonomy.normalize',
        prompt: 'Normalize pumps.',
        model: 'deepseek-v4-flash',
        schema: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: ['string', 'null'] } },
        },
      },
      { workspaceId: 'ws-cache-1' },
    );

    expect(port.get).not.toHaveBeenCalled();
    expect(port.put).not.toHaveBeenCalled();
  });

  it('still calls the gateway when the cache read throws', async () => {
    const port: LlmResultCachePort = {
      get: vi.fn(async () => {
        throw new Error('db down');
      }),
      put: vi.fn(async () => undefined),
    };
    configureLlmResultCache(port);

    const gateway = gatewayReturning();
    const result = await callProfile(gateway);

    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(VALID_OUTPUT);
  });

  it('still returns the gateway result when the cache write throws', async () => {
    const port: LlmResultCachePort = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error('db down');
      }),
    };
    configureLlmResultCache(port);

    const gateway = gatewayReturning();
    const result = await callProfile(gateway);
    expect(result.data).toEqual(VALID_OUTPUT);
  });

  it('settles cache hits through the gateway so the result carries a durable receipt', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning());

    const receipt = {
      schemaVersion: 'durable-execution-receipt/v1',
      scopeKey: 'ws-cache-1',
      authorityId: '22222222-2222-4222-8222-222222222222',
      accountId: '33333333-3333-4333-8333-333333333333',
      operationId: '44444444-4444-4444-8444-444444444444',
      operationKey: 'model-cache-op',
      resultStrategy: 'typed_projection',
      resultSchema: 'understanding-profile/v1',
      resultDigest: 'a'.repeat(64),
      artifactId: null,
      usage: {
        currency: 'USD',
        unit: 'microusd',
        callCount: 0,
        chargedMicrousd: '0',
        upperBoundMicrousd: '0',
      },
      costBasis: 'not_incurred',
      status: 'SETTLED',
    } as const;
    const onDurableReceipt = vi.fn();
    const settleCachedStructured = vi.fn(
      async (
        _input: unknown,
        context: { onDurableReceipt?: (producerId: string, value: unknown) => void },
        cached: { data: unknown; model: string },
      ) => {
        context.onDurableReceipt?.('company_understanding.extract_profile', receipt);
        return {
          data: cached.data,
          provider: 'llm-cache',
          model: cached.model,
          callCount: 0,
          durableReceipt: receipt,
        };
      },
    );
    const gateway = {
      generateStructured: vi.fn(),
      settleCachedStructured,
    } as unknown as ModelGateway;

    const result = await executeStructuredTaskWithRuntime(
      gateway,
      {
        task: 'company_understanding.extract_profile',
        prompt: 'Company homepage text.',
        model: 'deepseek-v4-flash',
        schema,
      },
      {
        workspaceId: 'ws-cache-1',
        runId: 'run-cache-1',
        durableResultSchema: 'understanding-profile/v1',
        onDurableReceipt,
      },
    );

    expect(settleCachedStructured).toHaveBeenCalledTimes(1);
    expect(
      (gateway as unknown as { generateStructured: ReturnType<typeof vi.fn> })
        .generateStructured,
    ).not.toHaveBeenCalled();
    expect(result.data).toEqual(VALID_OUTPUT);
    expect(result.durableReceipt).toBe(receipt);
    expect(result.provider).toBe('llm-cache');
    expect(result.callCount).toBe(0);
    expect(result.runtimeExecution.cacheHit).toBe(true);
  });

  it('does not serve an unreceipted cache hit when the context requires durable receipts', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(
      gatewayReturning({ industry: 'cached-industry', summary: 'cached summary' }),
    );

    const gateway = gatewayReturning();
    const result = await executeStructuredTaskWithRuntime(
      gateway,
      {
        task: 'company_understanding.extract_profile',
        prompt: 'Company homepage text.',
        model: 'deepseek-v4-flash',
        schema,
      },
      {
        workspaceId: 'ws-cache-1',
        runId: 'run-cache-1',
        durableResultSchema: 'understanding-profile/v1',
      },
    );

    expect(gateway.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.data).toEqual(VALID_OUTPUT);
    expect(result.runtimeExecution.cacheHit).toBeUndefined();
  });

  it('does not settle through the gateway when the context demands a receipt but has no durableResultSchema', async () => {
    const port = memoryPort();
    configureLlmResultCache(port);
    await callProfile(gatewayReturning({ industry: 'cached-industry', summary: 'cached summary' }));

    const settleCachedStructured = vi.fn();
    const gateway = {
      generateStructured: vi.fn(async () => ({
        data: VALID_OUTPUT,
        provider: 'gateway',
        model: 'deepseek-flash',
      })),
      settleCachedStructured,
    } as unknown as ModelGateway;

    const onDurableReceipt = vi.fn();
    const result = await executeStructuredTaskWithRuntime(
      gateway,
      {
        task: 'company_understanding.extract_profile',
        prompt: 'Company homepage text.',
        model: 'deepseek-v4-flash',
        schema,
      },
      {
        workspaceId: 'ws-cache-1',
        runId: 'run-cache-1',
        // 没有 durableResultSchema 时 projection/receiptFacts 都造不出来，
        // 结算路径必须整条让开——按 miss 走真实调用，绝不回落成无收据成功。
        onDurableReceipt,
      },
    );

    expect(settleCachedStructured).not.toHaveBeenCalled();
    expect(
      (gateway as unknown as { generateStructured: ReturnType<typeof vi.fn> }).generateStructured,
    ).toHaveBeenCalledTimes(1);
    expect(onDurableReceipt).not.toHaveBeenCalled();
    expect(result.data).toEqual(VALID_OUTPUT);
    expect(result.runtimeExecution.cacheHit).toBeUndefined();
  });
});
