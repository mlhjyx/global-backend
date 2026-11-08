import { describe, expect, it, vi } from 'vitest';
import type { BudgetStore } from '../tools/budget-store';
import type { ModelRouter } from './model-router';
import { RouterModelGateway } from './router-model-gateway';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const CACHED_DATA = { is_directory: true, companies: [{ name: 'Acme' }] };

const RECEIPT = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: WORKSPACE_ID,
  authorityId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
  operationKey: 'cache-op-key',
  resultStrategy: 'typed_projection',
  resultSchema: 'discovery-extract-list/v1',
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
});

function makeGateway(overrides: { reserve?: ReturnType<typeof vi.fn>; settle?: ReturnType<typeof vi.fn> } = {}) {
  const reserve =
    overrides.reserve ??
    vi.fn(async (request: { workspaceId: string; accountKey: string; operationKey: string }) => ({
      workspaceId: request.workspaceId,
      accountKey: request.accountKey,
      operationKey: request.operationKey,
      operationId: RECEIPT.operationId,
      estimatedMicrousd: 0n,
      replay: false,
    }));
  const settle =
    overrides.settle ??
    vi.fn(async () => ({
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      replay: false,
      receipt: RECEIPT,
    }));
  const store = { reserve, settle } as unknown as BudgetStore;
  const trace = { record: vi.fn() };
  const router = { route: vi.fn() } as unknown as ModelRouter;
  return {
    gateway: new RouterModelGateway(router, trace as never, store),
    store,
    trace,
  };
}

const INPUT = {
  task: 'discovery.extract_list',
  prompt: 'list page text',
  model: 'deepseek-v4-flash',
  schema: { type: 'object' },
};

describe('RouterModelGateway.settleCachedStructured (PR-B cache receipts)', () => {
  it('settles a cache hit as a zero-cost not_incurred operation and returns its receipt', async () => {
    const onDurableReceipt = vi.fn();
    const { gateway, store, trace } = makeGateway();

    const result = await gateway.settleCachedStructured(
      INPUT,
      {
        workspaceId: WORKSPACE_ID,
        runId: 'run-cache-1',
        durableResultSchema: 'discovery-extract-list/v1',
        onDurableReceipt,
      },
      { data: CACHED_DATA, model: 'deepseek-flash' },
    );

    expect(store.reserve).toHaveBeenCalledTimes(1);
    const reserveRequest = (store.reserve as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(reserveRequest).toMatchObject({
      workspaceId: WORKSPACE_ID,
      accountKey: 'run-cache-1',
      estimatedMicrousd: 0n,
    });

    expect(store.settle).toHaveBeenCalledTimes(1);
    const [, observedMicrousd, projection, facts] = (store.settle as ReturnType<typeof vi.fn>)
      .mock.calls[0]!;
    expect(observedMicrousd).toBe(0n);
    expect(projection).toMatchObject({
      kind: 'model',
      schema: 'discovery-extract-list/v1',
    });
    expect(facts).toEqual({
      usage: {
        currency: 'USD',
        unit: 'microusd',
        callCount: 0,
        chargedMicrousd: '0',
        upperBoundMicrousd: '0',
      },
      costBasis: 'not_incurred',
    });

    expect(result).toMatchObject({
      provider: 'llm-cache',
      model: 'deepseek-flash',
      callCount: 0,
      durableReceipt: RECEIPT,
    });
    expect(result.data).toEqual(CACHED_DATA);
    expect(onDurableReceipt).toHaveBeenCalledWith('discovery.extract_list', RECEIPT);
    expect(trace.record).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'discovery.extract_list',
        provider: 'llm-cache',
        status: 'OK',
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      }),
    );
  });

  it('is idempotent when Temporal retries: a replayed reservation returns the ledger receipt without settling twice', async () => {
    const { gateway, store } = makeGateway();
    const context = {
      workspaceId: WORKSPACE_ID,
      runId: 'run-cache-2',
      durableResultSchema: 'discovery-extract-list/v1',
    };
    await gateway.settleCachedStructured(INPUT, context, {
      data: CACHED_DATA,
      model: 'deepseek-flash',
    });
    const projection = (store.settle as ReturnType<typeof vi.fn>).mock.calls[0]![2];

    (store.reserve as ReturnType<typeof vi.fn>).mockImplementation(async (request: never) => ({
      ...(request as object),
      operationId: RECEIPT.operationId,
      estimatedMicrousd: 0n,
      replay: true,
      replayResult: { resultStrategy: 'typed_projection', projection },
      receipt: RECEIPT,
    }));

    const replayed = await gateway.settleCachedStructured(INPUT, context, {
      data: CACHED_DATA,
      model: 'deepseek-flash',
    });

    expect(store.settle).toHaveBeenCalledTimes(1);
    expect(replayed.durableReceipt).toBe(RECEIPT);
    expect(replayed.data).toEqual(CACHED_DATA);
  });
});
