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
});
