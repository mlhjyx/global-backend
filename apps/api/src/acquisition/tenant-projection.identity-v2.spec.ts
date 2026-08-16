import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveOrganizationIdentityForRaw = vi.hoisted(() => vi.fn());

vi.mock('../discovery/organization-identity-resolver', async (importOriginal) => {
  const original = await importOriginal<typeof import('../discovery/organization-identity-resolver')>();
  return { ...original, resolveOrganizationIdentityForRaw };
});

import { MonitoredSourceRawBridgeError } from './monitored-source-raw-bridge';
import { TenantProjectionService } from './tenant-projection.service';

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const source = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sourceKey: 'fair:example',
  providerKey: 'mapyourshow',
  status: 'ACTIVE',
  config: {
    host: 'example.mapyourshow.com',
  },
};
const entity = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  sourceId: source.id,
  externalId: 'EX-42',
  name: 'Example GmbH',
  domain: 'example.test',
  country: 'DE',
  withdrawnAt: null,
  cleaned: { products: ['press brake'], stand: 'A42' },
  contentHash: 'a'.repeat(64),
  lastSeenAt: new Date('2026-08-12T16:31:00.000Z'),
  lastSeenFetchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};
const fetch = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  status: 'DONE',
  parserVersion: 'acquisition/v1',
  finishedAt: new Date('2026-08-12T16:31:00.000Z'),
};
const policy = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  domain: 'mapyourshow.com',
  retentionDays: 365,
  reviewStatus: 'APPROVED',
  allowedPurpose: ['discovery', 'enrichment'],
  updatedAt: new Date('2026-08-01T00:00:00.000Z'),
};

function harness(sourceOverride = source) {
  const rawUpserts: any[] = [];
  const evidenceCreates: any[] = [];
  const canonicalUpdates: any[] = [];
  const evidenceKeys = new Set<string>();
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: '' }]),
    suppressionRecord: { findMany: vi.fn(async () => []) },
    canonicalCompany: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id === 'company-root') {
          return {
            id: 'company-root',
            name: entity.name,
            domain: entity.domain,
            country: entity.country,
            status: 'NEW',
            attributes: {},
          };
        }
        return null;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async ({ data }: any) => {
        canonicalUpdates.push(data);
        return { id: 'company-root', ...data };
      }),
    },
    rawSourceRecord: {
      upsert: vi.fn(async (args: any) => {
        rawUpserts.push(args);
        return { id: 'raw-bridge-1', payloadHash: args.create.payloadHash, ingestStatus: 'ACCEPTED' };
      }),
    },
    fieldEvidence: {
      createMany: vi.fn(async (args: any) => {
        let count = 0;
        for (const data of args.data) {
          const key = [data.workspaceId, data.entityType, data.entityId, data.field, data.rawRecordId].join(':');
          if (evidenceKeys.has(key)) continue;
          evidenceKeys.add(key);
          evidenceCreates.push({ data });
          count += 1;
        }
        return { count };
      }),
    },
  };
  const prisma = {
    monitoredSource: { findUnique: vi.fn(async () => sourceOverride) },
    sourceEntity: { findMany: vi.fn(async () => [entity]) },
    sourceFetch: { findMany: vi.fn(async () => [fetch]) },
    sourcePolicy: { findMany: vi.fn(async () => [policy]) },
    withWorkspace: vi.fn(async (_workspaceId: string, callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  return {
    service: new TenantProjectionService({ prisma: prisma as never }),
    tx,
    rawUpserts,
    evidenceCreates,
    canonicalUpdates,
  };
}

describe('TenantProjectionService -> Identity v2', () => {
  beforeEach(() => {
    resolveOrganizationIdentityForRaw.mockReset();
    resolveOrganizationIdentityForRaw.mockResolvedValue({
      kind: 'bound',
      companyId: 'company-root',
      matchRule: 'identity_v2',
      inputHash: 'input-hash',
      replayed: false,
    });
  });

  it('persists a real RawSourceRecord before binding through the existing Identity v2 resolver', async () => {
    const h = harness();

    await h.service.projectSource(WORKSPACE_A, source.id);

    expect(h.rawUpserts).toHaveLength(1);
    expect(h.rawUpserts[0].create).toMatchObject({
      workspaceId: WORKSPACE_A,
      runId: null,
      sourceEntityId: entity.id,
      providerKey: 'trade_fair',
      sourceClass: 'industry_data',
    });
    expect(resolveOrganizationIdentityForRaw).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        workspaceId: WORKSPACE_A,
        rawRecordId: 'raw-bridge-1',
        providerKey: 'trade_fair',
      }),
    );
    expect(h.evidenceCreates.length).toBeGreaterThan(0);
    expect(h.evidenceCreates.every((call) => call.data.rawRecordId === 'raw-bridge-1')).toBe(true);
    expect(h.evidenceCreates.every((call) => call.data.license === 'SOURCE_SPECIFIC_RESTRICTED')).toBe(true);
  });

  it('reuses the snapshot receipt and idempotently materializes evidence even when the active identity link is replayed', async () => {
    const h = harness();
    resolveOrganizationIdentityForRaw
      .mockResolvedValueOnce({ kind: 'bound', companyId: 'company-root', replayed: false })
      .mockResolvedValueOnce({ kind: 'bound', companyId: 'company-root', replayed: true });

    await h.service.projectSource(WORKSPACE_A, source.id);
    await h.service.projectSource(WORKSPACE_A, source.id);

    expect(h.rawUpserts).toHaveLength(2);
    expect(h.rawUpserts[0].where).toEqual(h.rawUpserts[1].where);
    expect(resolveOrganizationIdentityForRaw).toHaveBeenCalledTimes(2);
    expect(h.evidenceCreates).toHaveLength(4);
  });

  it('repairs all missing business evidence when the identity link was already active', async () => {
    const h = harness();
    resolveOrganizationIdentityForRaw.mockResolvedValueOnce({
      kind: 'bound', companyId: 'company-root', replayed: true,
    });

    await h.service.projectSource(WORKSPACE_A, source.id);

    expect(h.evidenceCreates).toHaveLength(4);
    expect(h.canonicalUpdates).toHaveLength(1);
  });

  it('does not project paused sources or non-company entities', async () => {
    const paused = harness({ ...source, status: 'PAUSED' });
    const pausedResult = await paused.service.projectSource(WORKSPACE_A, source.id);
    expect(pausedResult).toMatchObject({ status: 'SKIPPED', projected: 0 });

    const active = harness();
    await active.service.projectSource(WORKSPACE_A, source.id);
    const prisma = (active.service as any).deps.prisma;
    expect(prisma.sourceEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sourceId: source.id, withdrawnAt: null, entityKind: 'company' } }),
    );
  });

  it('keeps identical source snapshots isolated between workspaces', async () => {
    const h = harness();

    await h.service.projectSource(WORKSPACE_A, source.id);
    await h.service.projectSource(WORKSPACE_B, source.id);

    const keys = h.rawUpserts.map((call) => call.where.workspaceId_sourceEntityId_ingestKey);
    expect(keys[0]).toMatchObject({ workspaceId: WORKSPACE_A, sourceEntityId: entity.id });
    expect(keys[1]).toMatchObject({ workspaceId: WORKSPACE_B, sourceEntityId: entity.id });
    expect(keys[0].ingestKey).toBe(keys[1].ingestKey);
  });

  it('fails closed before canonical or identity writes when required provenance is absent', async () => {
    const h = harness();
    (h.service as any).deps.prisma.sourceFetch.findMany.mockResolvedValue([]);

    await expect(h.service.projectSource(WORKSPACE_A, source.id)).rejects.toBeInstanceOf(MonitoredSourceRawBridgeError);
    expect(h.rawUpserts).toHaveLength(0);
    expect(resolveOrganizationIdentityForRaw).not.toHaveBeenCalled();
    expect(h.canonicalUpdates).toHaveLength(0);
  });
});
