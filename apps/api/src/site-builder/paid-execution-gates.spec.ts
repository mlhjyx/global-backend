import { describe, expect, it, vi } from 'vitest';
import { RouterModelGateway } from '../model-gateway/router-model-gateway';
import type { ModelProvider } from '../model-gateway/model-provider';
import type { ModelRouter } from '../model-gateway/model-router';
import type { ModelResult } from '../model-gateway/types';
import { ToolBroker } from '../tools/tool-broker';
import { ToolRegistry } from '../tools/tool-registry';
import { RateLimiter } from '../tools/rate-limiter';
import type { Tool, ToolResult } from '../tools/tool-contract';
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from './site-build-cost-ledger';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ATTEMPT_ID = '44444444-4444-4444-8444-444444444444';
const FENCE = '55555555-5555-4555-8555-555555555555';

function provider(
  implementation: () => Promise<ModelResult<unknown>>,
): ModelProvider {
  return {
    id: 'gateway',
    generateText: vi.fn(implementation),
    generateStructured: vi.fn(implementation),
    embed: vi.fn(implementation),
    health: vi.fn(async () => ({ healthy: true })),
  } as unknown as ModelProvider;
}

const paidModelContext = {
  workspaceId: WORKSPACE_ID,
  runId: RUN_ID,
  paidCost: {
    siteId: SITE_ID,
    scopeKey: `${ATTEMPT_ID}:fallback-0`,
    taskAttemptId: ATTEMPT_ID,
    fenceToken: FENCE,
  },
};

describe('RouterModelGateway persistent paid-call gate', () => {
  it('reserves before the provider and settles measured token cost with provenance', async () => {
    const order: string[] = [];
    const model = provider(async () => {
      order.push('provider');
      return {
        data: { ok: true },
        provider: 'gateway',
        model: 'gpt-5.6-terra',
        reportedModel: 'gpt-5.6-terra',
        modelResolutionSource: 'upstream_response',
        usage: { inputTokens: 1_000, outputTokens: 500 },
      };
    });
    const paidLedger = {
      reserveOperation: vi.fn(async () => {
        order.push('reserve');
        return { kind: 'execute' as const };
      }),
      settleOperation: vi.fn(async () => {
        order.push('settle');
        return 'SETTLED';
      }),
    };
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = paidLedger as never;

    const result = await gateway.generateStructured(
      {
        task: 'site_builder.brand_profile',
        prompt: 'p',
        schema: {},
        model: 'gpt-5.6-terra',
        maxCostCents: 40,
      },
      paidModelContext,
    );

    expect(result.data).toEqual({ ok: true });
    expect(order).toEqual(['reserve', 'provider', 'settle']);
    expect(paidLedger.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        siteId: SITE_ID,
        buildRunId: RUN_ID,
        taskAttemptId: ATTEMPT_ID,
        fenceToken: FENCE,
        kind: 'model',
        taskId: 'site_builder.brand_profile',
        subject: 'gpt-5.6-terra@gateway',
        // structured output may make one bounded repair call.
        reservationMicrousd: 800_000,
        operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUCCEEDED',
        measurement: expect.objectContaining({
          basis: 'token_pricing',
          calculatedCostMicrousd: 1_000,
        }),
        meta: expect.objectContaining({
          provider: 'gateway',
          requestedModel: 'gpt-5.6-terra',
          resolvedModel: 'gpt-5.6-terra',
          reportedModel: 'gpt-5.6-terra',
          modelResolutionSource: 'upstream_response',
        }),
      }),
    );
  });

  it('persists only the caller-approved durable model replay projection', async () => {
    const rawResult = {
      data: {
        valueProps: ['Contact Jane Doe at jane@example.com'],
      },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const model = provider(async () => rawResult);
    const durableReplayResult = vi.fn(() => ({
      data: { valueProps: ['[persistence-gated]'] },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const settleOperation = vi.fn(async () => 'SETTLED');
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: 'execute' as const })),
      settleOperation,
    } as never;

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        {
          ...paidModelContext,
          paidCost: {
            ...paidModelContext.paidCost,
            durableReplayResult,
          },
        },
      ),
    ).resolves.toEqual(rawResult);

    expect(durableReplayResult).toHaveBeenCalledWith(rawResult);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUCCEEDED',
        result: expect.objectContaining({
          data: { valueProps: ['[persistence-gated]'] },
        }),
      }),
    );
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      'jane@example.com',
    );
  });

  it('omits model replay payloads when the caller did not install a persistence gate', async () => {
    const rawResult = {
      data: { secret: 'raw-provider-output' },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const settleOperation = vi.fn(async () => 'SETTLED');
    const gateway = new RouterModelGateway({
      route: () => [provider(async () => rawResult)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: 'execute' as const })),
      settleOperation,
    } as never;

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        paidModelContext,
      ),
    ).resolves.toEqual(rawResult);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({ result: undefined }),
    );
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      'raw-provider-output',
    );
  });

  it('fails closed when a settled paid model has no approved replay payload', async () => {
    const execute = vi.fn(async () => {
      throw new Error('must not execute');
    });
    const gateway = new RouterModelGateway({
      route: () => [provider(execute)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: 'replay' as const,
        status: 'SUCCEEDED',
        result: null,
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    } as never;

    const error = await gateway
      .generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        paidModelContext,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a rejected durable projection as a paid failure without retaining raw output', async () => {
    const rawResult = {
      data: { contact: 'jane@example.com' },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const projectionError = new Error('persistence gate rejected PII');
    const settleOperation = vi.fn(async () => 'SETTLED');
    const gateway = new RouterModelGateway({
      route: () => [provider(async () => rawResult)],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: 'execute' as const })),
      settleOperation,
    } as never;

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        {
          ...paidModelContext,
          paidCost: {
            ...paidModelContext.paidCost,
            durableReplayResult: () => {
              throw projectionError;
            },
          },
        },
      ),
    ).rejects.toBe(projectionError);
    expect(settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'FAILED',
        result: undefined,
        errorCode: 'DURABLE_REPLAY_REJECTED',
      }),
    );
    expect(JSON.stringify(settleOperation.mock.calls)).not.toContain(
      'jane@example.com',
    );
  });

  it('replays a cached provider result without calling or settling the provider again', async () => {
    const model = provider(async () => {
      throw new Error('must not execute');
    });
    const cached = {
      data: { cached: true },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 2, outputTokens: 1 },
    };
    const paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: 'replay' as const,
        status: 'SUCCEEDED',
        result: cached,
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    };
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = paidLedger as never;

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        paidModelContext,
      ),
    ).resolves.toEqual(cached);
    expect(model.generateStructured).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).not.toHaveBeenCalled();
  });

  it('fails closed when a paid context reaches a worker without the persistent ledger', async () => {
    const model = provider(async () => ({
      data: { ok: true },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
    }));
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        paidModelContext,
      ),
    ).rejects.toBeInstanceOf(PaidCallDeniedError);
    expect(model.generateStructured).not.toHaveBeenCalled();
  });

  it('turns a success-settlement ACK loss into a non-fallback paid-operation error', async () => {
    const execute = vi.fn(async () => ({
      data: { ok: true },
      provider: 'gateway',
      model: 'gpt-5.6-terra',
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const model = provider(execute);
    const gateway = new RouterModelGateway({
      route: () => [model],
    } as unknown as ModelRouter);
    gateway.paidLedger = {
      reserveOperation: vi.fn(async () => ({ kind: 'execute' as const })),
      settleOperation: vi.fn(async () => {
        throw new Error('database response lost');
      }),
    } as never;

    await expect(
      gateway.generateStructured(
        {
          task: 'site_builder.brand_profile',
          prompt: 'p',
          schema: {},
          model: 'gpt-5.6-terra',
          maxCostCents: 40,
        },
        paidModelContext,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).toHaveBeenCalledOnce();
  });
});

function paidTool(execute: () => Promise<unknown>): Tool {
  return {
    id: 'crawl4ai.fetch',
    version: '1.0.0',
    category: 'fetch',
    cost: { unit: 'call', estimatedCents: 3, external: true },
    rateLimit: { rps: 100, concurrency: 2 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: true,
      personalData: false,
      allowedPurpose: ['site_builder'],
      reversible: true,
      authRequired: false,
      risk: 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['domain'] },
    idempotencyKey: () => 'crawl-key',
    durableReplayResult: (result: ToolResult<{ text: string }>) => ({
      ...result,
      data: { text: '[scrubbed-replay]' },
    }),
    healthCheck: async () => ({ healthy: true }),
    execute: async () => ({ data: await execute(), costCents: 2 }),
  } as Tool;
}

const paidToolContext = {
  workspaceId: WORKSPACE_ID,
  siteId: SITE_ID,
  runId: RUN_ID,
  taskContractId: 'site_builder.brand_profile',
  paidCost: {
    scopeKey: ATTEMPT_ID,
    taskAttemptId: ATTEMPT_ID,
    fenceToken: FENCE,
  },
};

describe('ToolBroker persistent paid-call gate', () => {
  it('uses the tool idempotency key for durable reserve and labels legacy cents as estimate', async () => {
    const order: string[] = [];
    const tool = paidTool(async () => {
      order.push('tool');
      return { text: 'ok' };
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const paidLedger = {
      reserveOperation: vi.fn(async () => {
        order.push('reserve');
        return { kind: 'execute' as const };
      }),
      settleOperation: vi.fn(async () => {
        order.push('settle');
        return 'SETTLED';
      }),
    };
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: paidLedger as never,
    });

    await expect(
      broker.invoke('crawl4ai.fetch', { url: 'https://example.com' }, paidToolContext),
    ).resolves.toMatchObject({ data: { text: 'ok' }, costCents: 2 });
    expect(order).toEqual(['reserve', 'tool', 'settle']);
    expect(paidLedger.reserveOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        subject: 'crawl4ai.fetch@1.0.0',
        reservationMicrousd: 30_000,
      }),
    );
    expect(paidLedger.settleOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SUCCEEDED',
        result: {
          data: { text: '[scrubbed-replay]' },
          costCents: 2,
        },
        measurement: expect.objectContaining({
          basis: 'legacy_estimate',
          estimatedCostMicrousd: 20_000,
        }),
      }),
    );
  });

  it('returns a cached ToolResult without executing or settling again', async () => {
    const execute = vi.fn(async () => ({ text: 'new' }));
    const registry = new ToolRegistry();
    registry.register(paidTool(execute));
    const paidLedger = {
      reserveOperation: vi.fn(async () => ({
        kind: 'replay' as const,
        status: 'SUCCEEDED',
        result: { data: { text: 'cached' }, costCents: 2 },
        meta: null,
        errorCode: null,
      })),
      settleOperation: vi.fn(),
    };
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: paidLedger as never,
    });

    await expect(
      broker.invoke('crawl4ai.fetch', { url: 'https://example.com' }, paidToolContext),
    ).resolves.toEqual({
      data: { text: '[scrubbed-replay]' },
      costCents: 2,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(paidLedger.settleOperation).not.toHaveBeenCalled();
  });

  it('turns a success-settlement ACK loss into a paid-operation unknown error', async () => {
    const execute = vi.fn(async () => ({ text: 'executed-once' }));
    const registry = new ToolRegistry();
    registry.register(paidTool(execute));
    const broker = new ToolBroker({
      registry,
      limiter: new RateLimiter(),
      paidLedger: {
        reserveOperation: vi.fn(async () => ({ kind: 'execute' as const })),
        settleOperation: vi.fn(async () => {
          throw new Error('database response lost');
        }),
      } as never,
    });

    await expect(
      broker.invoke(
        'crawl4ai.fetch',
        { url: 'https://example.com' },
        paidToolContext,
      ),
    ).rejects.toBeInstanceOf(PaidOperationUnknownError);
    expect(execute).toHaveBeenCalledOnce();
  });
});
