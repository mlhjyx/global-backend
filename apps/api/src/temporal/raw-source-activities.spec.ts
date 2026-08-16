import { describe, expect, it, vi } from 'vitest';
import type { CompanyDiscoveryAdapter, ProviderCompanyRecord } from '../discovery/provider-contract';
import { createDiscoveryActivities } from './discovery.activities';

const QUERY = {
  source_class: 'public_intelligence',
  filters: {},
  keywords: [],
  priority: 1,
};
const NOW = new Date('2026-08-12T00:00:00.000Z');

function providerRecord(overrides: Partial<ProviderCompanyRecord> = {}): ProviderCompanyRecord {
  return {
    externalId: 'company-1',
    name: 'Acme GmbH',
    domain: 'acme.example',
    country: 'DE',
    provenance: {
      sourceUrl: 'https://registry.example/companies/1',
      fetchedAt: '2026-08-11T00:00:00.000Z',
      contentHash: 'provider-hash',
      parserVersion: 'v1',
    },
    ...overrides,
  };
}

function adapter(records: ProviderCompanyRecord[]): CompanyDiscoveryAdapter {
  return {
    key: 'registry',
    classes: ['public_intelligence'],
    discoverCompanies: async () => ({ records, costCents: 0 }),
  };
}

function executionHarness(args?: {
  records?: ProviderCompanyRecord[];
  existing?: unknown[];
  maxRecordBytes?: number;
  maxBatchBytes?: number;
}) {
  const createdRows: Record<string, unknown>[] = [];
  const findMany = vi.fn(async () => args?.existing ?? []);
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    rawSourceRecord: {
      findMany,
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        createdRows.push(...data);
        return { count: data.length };
      }),
    },
    usageLedger: { create: vi.fn(async () => ({})) },
  };
  const prisma = {
    sourcePolicy: {
      findMany: vi.fn(async () => [
        {
          id: 'policy-1',
          domain: 'registry.example',
          retentionDays: 90,
          reviewStatus: 'APPROVED',
          updatedAt: new Date('2026-08-01T00:00:00.000Z'),
        },
      ]),
    },
    withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> => callback(tx),
  };
  const activities = createDiscoveryActivities({
    prisma,
    providers: {
      routeCompanyDiscovery: async () => [adapter(args?.records ?? [providerRecord()])],
    },
    gateway: {},
    now: () => NOW,
    rawIngestLimits: {
      maxRecordBytes: args?.maxRecordBytes ?? 512 * 1024,
      maxBatchBytes: args?.maxBatchBytes ?? 5 * 1024 * 1024,
      defaultRetentionDays: 30,
    },
  } as never);
  return { activities, createdRows, findMany, tx };
}

describe('executeQuery Raw Source v2 integration', () => {
  it('persists accepted v2 receipts with mandatory hash and source-policy retention', async () => {
    const harness = executionHarness();
    const result = await harness.activities.executeQuery({
      workspaceId: 'ws-1',
      runId: 'run-1',
      query: QUERY,
    });

    expect(result).toMatchObject({
      rawCount: 1,
      quarantinedCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
    });
    expect(harness.createdRows[0]).toMatchObject({
      ingestVersion: 'raw-source/v2',
      ingestStatus: 'ACCEPTED',
      retentionDays: 90,
      sourcePolicySnapshot: {
        kind: 'source_policy',
        domain: 'registry.example',
      },
    });
    expect(harness.createdRows[0].payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.tx.$executeRaw).toHaveBeenCalledOnce();
  });

  it('stores an oversized response only as a quarantine receipt and does not count it as usable raw', async () => {
    const harness = executionHarness({
      records: [providerRecord({ attributes: { page: 'x'.repeat(4_000) } })],
      maxRecordBytes: 256,
    });
    const result = await harness.activities.executeQuery({
      workspaceId: 'ws-1',
      runId: 'run-2',
      query: QUERY,
    });

    expect(result).toMatchObject({
      rawCount: 0,
      quarantinedCount: 1,
      rejectedCount: 0,
    });
    expect(harness.createdRows[0]).toMatchObject({
      externalId: null,
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'PAYLOAD_TOO_LARGE',
      payload: { _rawReceipt: 'raw-source/quarantine-v1' },
    });
    expect(JSON.stringify(harness.createdRows[0].payload)).not.toContain('x'.repeat(100));
  });

  it('turns reused processing-key drift into an auditable quarantine instead of aborting the whole query', async () => {
    const original = providerRecord();
    const harness = executionHarness({
      records: [providerRecord({ name: 'Changed GmbH' })],
      existing: [
        {
          id: 'raw-old',
          externalId: original.externalId,
          ingestKey: null,
          payloadHash: null,
          payload: original,
        },
      ],
    });
    const result = await harness.activities.executeQuery({
      workspaceId: 'ws-1',
      runId: 'run-3',
      query: QUERY,
    });

    expect(result).toMatchObject({
      rawCount: 0,
      quarantinedCount: 1,
      rejectedCount: 0,
    });
    expect(harness.createdRows[0]).toMatchObject({
      externalId: null,
      ingestStatus: 'QUARANTINED',
      dispositionCode: 'PROCESSING_KEY_DRIFT',
      payload: { conflictWithRawId: 'raw-old' },
    });
  });
});

describe('Raw Source v2 materialization and retention', () => {
  it('canonicalizeRun reads only accepted raw records', async () => {
    const rawFindMany = vi.fn(async () => []);
    const tx = {
      $queryRaw: vi.fn(async () => [{ locked: '' }]),
      $executeRaw: vi.fn(async () => 1),
      rawSourceRecord: { findMany: rawFindMany },
      rawSourceGovernanceDisposition: { findMany: vi.fn(async () => []) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> => callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
    } as never);

    await activities.canonicalizeRun({ workspaceId: 'ws-1', runId: 'run-1' });
    expect(rawFindMany).toHaveBeenCalledWith({
      where: { runId: 'run-1', ingestStatus: 'ACCEPTED' },
      select: { id: true },
    });
  });

  it('expires eligible rows to a minimal receipt and defers open identity conflicts', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      rawSourceRecord: {
        findMany: vi.fn(async () => [
          {
            id: 'raw-1',
            ingestStatus: 'ACCEPTED',
            payloadHash: 'a'.repeat(64),
            payloadBytes: 100,
          },
        ]),
        count: vi.fn(async () => 2),
        updateMany,
      },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> => callback(tx),
    };
    const activities = createDiscoveryActivities({
      prisma,
      providers: {},
      gateway: {},
      now: () => NOW,
    } as never);

    await expect(activities.expireRawSourceRecords({ workspaceId: 'ws-1', limit: 50 })).resolves.toEqual({
      expired: 1,
      deferredForConflict: 2,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'raw-1', ingestStatus: 'ACCEPTED' },
      data: {
        ingestStatus: 'EXPIRED',
        expiredAt: NOW,
        payload: {
          _rawReceipt: 'raw-source/expired-v1',
          previousStatus: 'ACCEPTED',
          payloadHash: 'a'.repeat(64),
          payloadBytes: 100,
        },
      },
    });
  });

  it('uses owner access only to list due workspace ids for the platform retention schedule', async () => {
    const ownerFindMany = vi.fn(async () => [
      { workspaceId: 'ws-1' },
      { workspaceId: 'ws-2' },
      { workspaceId: 'ws-3' },
    ]);
    const activities = createDiscoveryActivities({
      prisma: {},
      ownerDb: { rawSourceRecord: { findMany: ownerFindMany } },
      providers: {},
      gateway: {},
      now: () => NOW,
    } as never);

    await expect(activities.listRawRetentionWorkspaces({
      limit: 2,
      afterWorkspaceId: 'ws-0',
    })).resolves.toEqual({
      workspaceIds: ['ws-1', 'ws-2'],
      nextCursor: 'ws-2',
    });
    expect(ownerFindMany).toHaveBeenCalledWith({
      where: {
        workspaceId: { gt: 'ws-0' },
        ingestVersion: 'raw-source/v2',
        ingestStatus: { in: ['ACCEPTED', 'QUARANTINED', 'REJECTED'] },
        expiresAt: { lte: NOW },
      },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      orderBy: { workspaceId: 'asc' },
      take: 3,
    });
  });
});
