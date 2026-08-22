import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { BudgetStore } from '../tools/budget-store';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PATENT_CACHE_BROKER_MAX_ANCHORS, createPatentsCacheActivities } from './patents-cache.activities';
import { PLATFORM_SCHEDULE_AUTHORITY_SCOPES } from './platform-schedule-authority';
import { googlePatentsSearchTool } from '../tools/source-tools';
import { createPatentCacheBrokerScanner } from './patent-cache-broker-scanner';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const patentAckMock = vi.hoisted(() => vi.fn(async (input: {
  transaction: unknown;
  acknowledgements: Array<{ producerId: string }>;
  apply: (transaction: unknown) => Promise<unknown>;
}) => ({
  status: 'APPLIED',
  acknowledgements: input.acknowledgements.map(({ producerId }) => ({
    producerId, status: 'APPLIED',
  })),
  value: await input.apply(input.transaction),
})));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: patentAckMock,
}));

const PATENT_RECEIPT: DurableExecutionReceipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'platform',
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationKey: 'patent-search',
  resultStrategy: 'typed_projection',
  resultSchema: 'google-patents-search/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD', unit: 'microusd', callCount: 1,
    maximumBytesBilled: '100', upperBoundMicrousd: '10000',
  },
  costBasis: 'estimated_upper_bound',
});

const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES['patents-cache-refresh'];
const binding = {
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  scopeKey: 'platform' as const,
  accountKey: `platform:${scope.requestSha256}:workflow-run-1`,
  ...scope,
  workflowRunId: 'workflow-run-1',
  admissionReplay: false,
};

describe('patents cache schedule authority and ToolBroker route', () => {
  it('does not copy personal patent names into the generic budget replay JSON', () => {
    expect(googlePatentsSearchTool.compliance.personalData).toBe(true);
    expect(googlePatentsSearchTool.durableReplayResult).toBeUndefined();
  });

  it('caps product refresh fan-out independently of a larger schedule payload', () => {
    expect(PATENT_CACHE_BROKER_MAX_ANCHORS).toBe(25);
  });

  it('contains no direct BigQuery singleton import or batch scanner call', async () => {
    const [activitySource, scannerSource] = await Promise.all([
      readFile(new URL('./patents-cache.activities.ts', import.meta.url), 'utf8'),
      readFile(new URL('./patent-cache-broker-scanner.ts', import.meta.url), 'utf8'),
    ]);
    expect(activitySource).not.toContain("from '../adapters/bigquery-patents'");
    expect(activitySource).not.toContain('bigqueryPatents');
    expect(scannerSource).not.toContain('bigqueryPatents');
    expect(scannerSource).toContain('google_patents.search');
    expect(scannerSource).toContain('input.broker.invoke');
    expect(activitySource).toContain('readbackPatentRefresh');
    expect(activitySource).not.toMatch(/return value \?\? \{/);
  });

  it('parks a pending pre-cutover activity before cache mutation or broker invocation', async () => {
    const deleteMany = vi.fn();
    const broker = { invoke: vi.fn() } as unknown as ExecutionBroker;
    const activities = createPatentsCacheActivities({
      ownerDb: { patentInventorCache: { deleteMany } } as unknown as PrismaClient,
      broker,
      budgetStore: { attestAuthorized: vi.fn() } as unknown as BudgetStore,
      activityRunId: () => 'workflow-run-1',
    });
    await expect(activities.refreshPatentCacheActivity()).rejects.toMatchObject({ type: 'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED', nonRetryable: true });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('attests before any cache read/write or ToolBroker invocation', async () => {
    const order: string[] = [];
    const attestAuthorized = vi.fn(async () => {
      order.push('attest');
      return {
        accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
        authorityId: binding.authorityId,
        authorizedCapMicrousd: 1_000_000n,
        generation: 1,
      };
    });
    const ownerDb = {
      patentInventorCache: { deleteMany: vi.fn(async () => { order.push('db'); return { count: 0 }; }) },
      dataProvider: { findUnique: vi.fn(async () => ({ status: 'DISABLED' })) },
      patentCacheRefreshAudit: { create: vi.fn(async () => ({})) },
    } as unknown as PrismaClient;
    const broker = { invoke: vi.fn(async () => { order.push('wire'); return { data: { patents: [] }, costCents: 0 }; }) } as unknown as ExecutionBroker;
    const activities = createPatentsCacheActivities({
      ownerDb,
      broker,
      budgetStore: { attestAuthorized } as unknown as BudgetStore,
      activityRunId: () => 'workflow-run-1',
    });

    await expect(activities.refreshPatentCacheActivity({
      executionContractVersion: 1,
      executionBudget: binding,
      maxAnchors: 1,
    })).resolves.toMatchObject({ status: 'DISABLED' });
    expect(order[0]).toBe('attest');
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('collects the Patent receipt and requires the exact platform transaction before cache writes', async () => {
    const priorKey = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    try {
      const ownerDb = {
        patentInventorCache: { deleteMany: vi.fn(async () => ({ count: 0 })) },
        dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) },
        patentLookupRequest: {
          findMany: vi.fn(async () => [{
            id: 'request-1', assigneeNorm: 'acme', country: 'us',
            anchor: '%Acme%', firstRequestedAt: new Date(),
          }]),
        },
        sourcePolicy: { findUnique: vi.fn(async () => ({
          reviewStatus: 'APPROVED', allowedPurpose: ['discovery'],
        })) },
        patentCacheRefreshAudit: {
          create: vi.fn(async () => ({ id: 'audit-1' })),
          update: vi.fn(async () => ({})),
        },
      } as unknown as PrismaClient;
      const broker = {
        invoke: vi.fn(async (_toolId, _toolInput, context) => {
          context.onDurableReceipt?.('google_patents.search', PATENT_RECEIPT);
          return {
            data: {
              patents: [],
              costFacts: {
                costBasis: 'estimated_upper_bound',
                maximumBytesBilled: '100', observedBytesBilled: null, maxRows: 50,
              },
            },
            costCents: 0,
            durableReceipt: PATENT_RECEIPT,
          };
        }),
      } as unknown as ExecutionBroker;
      const activities = createPatentsCacheActivities({
        ownerDb,
        broker,
        budgetStore: { attestAuthorized: vi.fn(async () => ({})) } as unknown as BudgetStore,
        activityRunId: () => 'workflow-run-1',
      });
      await expect(activities.refreshPatentCacheActivity({
        executionContractVersion: 1,
        executionBudget: binding,
        maxAnchors: 1,
      })).rejects.toThrow('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE');
    } finally {
      if (priorKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
      else process.env.PII_ENCRYPTION_KEY = priorKey;
    }
  });

  it.each(['APPLIED', 'REPLAYED', 'REPLAYED_NULL'] as const)(
    '%s Patent receipt returns exact persisted/readback summary on one platform transaction',
    async (ackStatus) => {
      const priorKey = process.env.PII_ENCRYPTION_KEY;
      process.env.PII_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
      try {
        const authoritativeRow = {
          status: 'OK' as const, anchorCount: 1, rowCount: 0,
          bytesScanned: ackStatus === 'REPLAYED' ? 40n : null,
          purged: 0, cached: 0, empty: 1,
        };
        const expected = {
          ...authoritativeRow,
          bytesScanned: ackStatus === 'REPLAYED' ? 40 : null,
        };
        const auditUpdate = vi.fn(async () => ({}));
        const ownerDb = {
          patentInventorCache: {
            deleteMany: vi.fn(async () => ({ count: 0 })),
            upsert: vi.fn(),
          },
          patentInventorTombstone: { findMany: vi.fn(async () => []) },
          dataProvider: { findUnique: vi.fn(async () => ({ status: 'ENABLED' })) },
          patentLookupRequest: {
            findMany: vi.fn(async () => [{
              id: 'request-1', assigneeNorm: 'acme', country: 'us',
              anchor: '%Acme%', firstRequestedAt: new Date(),
            }]),
            update: vi.fn(async () => ({})),
          },
          sourcePolicy: { findUnique: vi.fn(async () => ({
            reviewStatus: 'APPROVED', allowedPurpose: ['discovery'],
          })) },
          patentCacheRefreshAudit: {
            create: vi.fn(async () => ({ id: 'audit-1' })),
            update: auditUpdate,
            findFirst: vi.fn(async () => authoritativeRow),
          },
        };
        const broker = {
          invoke: vi.fn(async (_toolId, _toolInput, context) => {
            context.onDurableReceipt?.('google_patents.search', PATENT_RECEIPT);
            return {
              data: {
                patents: [],
                costFacts: {
                  costBasis: 'estimated_upper_bound',
                  maximumBytesBilled: '100', observedBytesBilled: null, maxRows: 50,
                },
              },
              costCents: 0,
              durableReceipt: PATENT_RECEIPT,
            };
          }),
        } as unknown as ExecutionBroker;
        if (ackStatus !== 'APPLIED') {
          patentAckMock.mockImplementationOnce(async (input: {
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
        }
        const activities = createPatentsCacheActivities({
          ownerDb: ownerDb as unknown as PrismaClient,
          platformWriter: {
            $transaction: vi.fn(async (callback: (transaction: typeof ownerDb) => Promise<unknown>) =>
              callback(ownerDb)),
          } as unknown as PrismaClient,
          broker,
          budgetStore: { attestAuthorized: vi.fn(async () => ({})) } as unknown as BudgetStore,
          activityRunId: () => 'workflow-run-1',
        });

        await expect(activities.refreshPatentCacheActivity({
          executionContractVersion: 1,
          executionBudget: binding,
          maxAnchors: 1,
        })).resolves.toEqual(expected);
        expect(patentAckMock).toHaveBeenCalledWith(expect.objectContaining({
          acknowledgements: [expect.objectContaining({
            producerId: 'google_patents.search', receipt: PATENT_RECEIPT,
          })],
        }));
        expect(auditUpdate).toHaveBeenCalledWith(expect.objectContaining({
          data: expect.objectContaining({
            ...(ackStatus === 'APPLIED'
              ? { executionOperationIds: [PATENT_RECEIPT.operationId] }
              : { status: 'REPLAYED' }),
          }),
        }));
      } finally {
        if (priorKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
        else process.env.PII_ENCRYPTION_KEY = priorKey;
      }
    },
  );

  it('does not count a conservative maximumBytesBilled bound as observed bytesScanned', async () => {
    const broker = {
      checkSourcePolicy: vi.fn(),
      invoke: vi.fn(async () => ({
        data: {
          patents: [],
          costFacts: {
            costBasis: 'estimated_upper_bound',
            maximumBytesBilled: '214748364800',
            observedBytesBilled: null,
            maxRows: 50,
          },
        },
        costCents: 0,
      })),
    } as unknown as ExecutionBroker;
    const scanner = createPatentCacheBrokerScanner({
      broker,
      accountKey: 'platform:patents:test',
    });

    await expect(
      scanner.searchInventorsForAnchorsWithStats(['%Acme%'], {
        fromYear: 2020,
        toYear: 2026,
        maxRows: 50,
      }),
    ).resolves.toEqual({ rows: [], bytesScanned: null, scanned: true });
  });

  it('treats explicit not_incurred Patent facts as not scanned and not empty-cache evidence', async () => {
    const broker = {
      checkSourcePolicy: vi.fn(),
      invoke: vi.fn(async () => ({
        data: {
          patents: [],
          costFacts: {
            costBasis: 'not_incurred',
            maximumBytesBilled: '0',
            observedBytesBilled: null,
            maxRows: 0,
          },
        },
        costCents: 0,
      })),
    } as unknown as ExecutionBroker;
    const scanner = createPatentCacheBrokerScanner({
      broker,
      accountKey: 'platform:patents:test',
    });

    await expect(
      scanner.searchInventorsForAnchorsWithStats(['%Acme%'], {
        fromYear: 2020,
        toYear: 2026,
        maxRows: 50,
      }),
    ).resolves.toEqual({ rows: [], bytesScanned: null, scanned: false });
  });

  it('sums provider-reported observed bytes and skips empty anchors', async () => {
    const broker = {
      checkSourcePolicy: vi.fn(),
      invoke: vi.fn(async () => ({
        data: {
          patents: [{
            publicationNumber: 'US-1',
            title: 'Pump',
            publicationDate: '2026-01-01',
            publicationDateIso: '2026-01-01',
            applicants: [{ name: 'Acme', country: 'US' }],
            inventors: [{ name: 'Ada' }],
            abstract: 'A pump',
          }],
          costFacts: {
            costBasis: 'provider_reported',
            maximumBytesBilled: '100',
            observedBytesBilled: '40',
            maxRows: 50,
          },
        },
        costCents: 0,
      })),
    } as unknown as ExecutionBroker;
    const scanner = createPatentCacheBrokerScanner({
      broker,
      accountKey: 'platform:patents:test',
    });

    await expect(
      scanner.searchInventorsForAnchorsWithStats(['%%', '%Acme%'], {
        fromYear: 2020,
        toYear: 2026,
        maxRows: 99,
      }),
    ).resolves.toEqual({
      rows: [{ assigneeName: 'Acme', assigneeCountry: 'US', inventorName: 'Ada' }],
      bytesScanned: 40,
      scanned: true,
    });
    expect(broker.invoke).toHaveBeenCalledTimes(1);
    expect(broker.invoke).toHaveBeenCalledWith(
      'google_patents.search',
      expect.objectContaining({ applicant: 'Acme', maxRows: 25 }),
      expect.objectContaining({ purpose: 'discovery' }),
    );
  });

  it('fails closed when provider-reported bytes exceed the conservative maximum', async () => {
    const broker = {
      checkSourcePolicy: vi.fn(),
      invoke: vi.fn(async () => ({
        data: {
          patents: [],
          costFacts: {
            costBasis: 'provider_reported',
            maximumBytesBilled: '100',
            observedBytesBilled: '101',
            maxRows: 50,
          },
        },
        costCents: 0,
      })),
    } as unknown as ExecutionBroker;
    const scanner = createPatentCacheBrokerScanner({
      broker,
      accountKey: 'platform:patents:test',
    });

    await expect(
      scanner.searchInventorsForAnchorsWithStats(['%Acme%'], {
        fromYear: 2020,
        toYear: 2026,
        maxRows: 50,
      }),
    ).rejects.toThrow('GOOGLE_PATENTS_COST_FACTS_UNAVAILABLE');
  });
});
