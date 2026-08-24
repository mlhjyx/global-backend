import { describe, expect, it, vi } from 'vitest';
import { createAcquisitionActivities } from './acquisition.activities';
import { SourceAdapterRegistry } from '../acquisition/source-adapter';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const ackMocks = vi.hoisted(() => ({
  apply: vi.fn(async (input: {
    transaction: unknown;
    acknowledgements: Array<{ producerId: string }>;
    apply: (transaction: unknown) => Promise<unknown>;
  }) => ({
    status: 'APPLIED',
    acknowledgements: input.acknowledgements.map(({ producerId }) => ({
      producerId,
      status: 'APPLIED',
    })),
    value: await input.apply(input.transaction),
  })),
}));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: ackMocks.apply,
}));

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['acq-sweep'];
const executionBudget = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

const ACQUISITION_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'platform',
  authorityId: executionBudget.authorityId,
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'acquisition-mapyourshow',
  resultStrategy: 'typed_projection',
  resultSchema: 'mapyourshow-fetch/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD', unit: 'microusd', callCount: 1,
    upperBoundMicrousd: '10000',
  },
  costBasis: 'estimated_upper_bound',
});

describe('acquisition activities — platform authority lifecycle', () => {
  it('parks a pending pre-cutover activity before its first database read', async () => {
    const findMany = vi.fn();
    const activities = createAcquisitionActivities({
      prisma: { monitoredSource: { findMany } } as never,
      registry: new SourceAdapterRegistry(),
      budgetStore: { attestAuthorized: vi.fn() } as never,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(activities.listDueSources({ limit: 1 })).rejects.toMatchObject({ type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED', nonRetryable: true });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('read-only attests before the adapter call and never reopens or closes the admitted account', async () => {
    const order: string[] = [];
    const fetch = vi.fn(async (_config, _limit, context) => {
      order.push('wire');
      expect(context).toEqual({
        workspaceId: 'platform',
        runId: executionBudget.accountKey,
        correlationId: executionBudget.accountKey,
      });
      throw new Error('wire failed');
    });
    const registry = new SourceAdapterRegistry().register({ providerKey: 'test-source', fetch });
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn(async () => ({
          id: 'source-1', providerKey: 'test-source', sourceKey: 'source', status: 'ACTIVE', config: {},
        })),
      },
      sourceFetch: {
        create: vi.fn(async () => ({ id: 'fetch-1' })),
        update: vi.fn(async () => ({})),
      },
    };
    const budgetStore = {
      attestAuthorized: vi.fn(async () => { order.push('attest'); }),
      openAuthorized: vi.fn(),
      open: vi.fn(),
      close: vi.fn(),
    };
    const activities = createAcquisitionActivities({
      prisma: prisma as never, registry, budgetStore: budgetStore as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).resolves.toMatchObject({ status: 'FAILED' });
    expect(budgetStore.attestAuthorized).toHaveBeenCalledWith({
      authorityId: executionBudget.authorityId,
      scopeKey: 'platform',
      accountKey: executionBudget.accountKey,
    });
    expect(budgetStore.open).not.toHaveBeenCalled();
    expect(budgetStore.openAuthorized).not.toHaveBeenCalled();
    expect(budgetStore.close).not.toHaveBeenCalled();
    expect(order).toEqual(['attest', 'wire']);
  });

  it('captures mapyourshow receipt and ACKs the exact acquisition persistence transaction', async () => {
    ackMocks.apply.mockClear();
    const fetch = vi.fn(async (_config, _limit, context) => {
      context.onDurableReceipt?.('mapyourshow.fetch', ACQUISITION_RECEIPT);
      return [{
        externalId: 'exhibitor-1',
        name: 'Acme GmbH',
        website: 'https://acme.example/',
        country: 'DE',
      }];
    });
    const registry = new SourceAdapterRegistry().register({
      providerKey: 'mapyourshow',
      fetch,
    });
    const tx = {
      sourceEntity: {
        findMany: vi.fn(async () => []),
        createMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      sourceEntityChange: { createMany: vi.fn(async () => ({ count: 1 })) },
      sourceFetch: {
        update: vi.fn(async () => ({})),
        findFirst: vi.fn(async () => null),
      },
      monitoredSource: { update: vi.fn(async () => ({})) },
    };
    const prisma = {
      monitoredSource: { findUnique: vi.fn(async () => ({
        id: 'source-1', providerKey: 'mapyourshow', sourceKey: 'messe',
        status: 'ACTIVE', config: {}, cadence: {},
      })) },
      sourceFetch: { create: vi.fn(async () => ({ id: 'fetch-1' })) },
    };
    const platformWriter = {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx)),
    };
    const activities = createAcquisitionActivities({
      prisma: prisma as never,
      registry,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      platformWriter: platformWriter as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).resolves.toMatchObject({ status: 'DONE', total: 1, added: 1 });
    expect(ackMocks.apply).toHaveBeenCalledWith(expect.objectContaining({
      transaction: tx,
      acknowledgements: [expect.objectContaining({
        producerId: 'mapyourshow.fetch',
        receipt: ACQUISITION_RECEIPT,
      })],
    }));
    expect(tx.sourceFetch.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        executionOperationIds: [ACQUISITION_RECEIPT.operationId],
      }),
    }));
    expect(tx.sourceEntity.createMany).toHaveBeenCalledOnce();
    expect(tx.sourceEntityChange.createMany).toHaveBeenCalledOnce();

    const withoutWriter = createAcquisitionActivities({
      prisma: prisma as never,
      registry,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(withoutWriter.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).rejects.toThrow('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
  });

  it('returns authoritative acquisition readback on all-replay without rerunning domain writes', async () => {
    const authoritative = {
      sourceId: 'source-1', status: 'DONE' as const,
      total: 3, added: 1, updated: 1, removed: 0, unchanged: 1,
    };
    ackMocks.apply.mockImplementationOnce(async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      readback: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: 'REPLAYED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId,
        status: 'REPLAYED',
      })),
      value: await input.readback(input.transaction),
    }));
    const registry = new SourceAdapterRegistry().register({
      providerKey: 'mapyourshow',
      fetch: vi.fn(async (_config, _limit, context) => {
        context.onDurableReceipt?.('mapyourshow.fetch', ACQUISITION_RECEIPT);
        return [];
      }),
    });
    const tx = {
      sourceEntity: {
        findMany: vi.fn(), createMany: vi.fn(), update: vi.fn(),
      },
      sourceEntityChange: { createMany: vi.fn() },
      sourceFetch: {
        findFirst: vi.fn(async () => ({ executionResult: authoritative })),
        update: vi.fn(async () => ({})),
      },
      monitoredSource: { update: vi.fn() },
    };
    const activities = createAcquisitionActivities({
      prisma: {
        monitoredSource: { findUnique: vi.fn(async () => ({
          id: 'source-1', providerKey: 'mapyourshow', sourceKey: 'messe',
          status: 'ACTIVE', config: {}, cadence: {},
        })) },
        sourceFetch: { create: vi.fn(async () => ({ id: 'fetch-2' })) },
      } as never,
      registry,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      platformWriter: {
        $transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)),
      } as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).resolves.toEqual(authoritative);
    expect(tx.sourceFetch.findFirst).toHaveBeenCalledOnce();
    expect(tx.sourceFetch.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'REPLAYED' }),
    }));
    expect(tx.sourceEntity.findMany).not.toHaveBeenCalled();

    ackMocks.apply.mockImplementationOnce(async (input: {
      transaction: unknown;
      acknowledgements: Array<{ producerId: string }>;
      readback: (transaction: unknown) => Promise<unknown>;
    }) => ({
      status: 'REPLAYED',
      acknowledgements: input.acknowledgements.map(({ producerId }) => ({
        producerId, status: 'REPLAYED',
      })),
      value: await input.readback(input.transaction),
    }));
    tx.sourceFetch.findFirst.mockResolvedValueOnce({
      executionResult: { sourceId: 'source-1', status: 'DONE' },
    });
    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).rejects.toThrow('DOMAIN_ACK_AUTHORITATIVE_READBACK_UNAVAILABLE');
  });

  it('rejects an unexpected acquisition receipt producer before any domain write', async () => {
    const registry = new SourceAdapterRegistry().register({
      providerKey: 'mapyourshow',
      fetch: vi.fn(async (_config, _limit, context) => {
        context.onDurableReceipt?.('unexpected.tool', ACQUISITION_RECEIPT);
        return [];
      }),
    });
    const sourceFetchUpdate = vi.fn();
    const activities = createAcquisitionActivities({
      prisma: {
        monitoredSource: { findUnique: vi.fn(async () => ({
          id: 'source-1', providerKey: 'mapyourshow', sourceKey: 'messe',
          status: 'ACTIVE', config: {}, cadence: {},
        })) },
        sourceFetch: {
          create: vi.fn(async () => ({ id: 'fetch-3' })),
          update: sourceFetchUpdate,
        },
      } as never,
      registry,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.acquireSource({
      sourceId: 'source-1', executionContractVersion: 1, executionBudget,
    })).rejects.toThrow('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
    expect(sourceFetchUpdate).not.toHaveBeenCalled();
  });
});
