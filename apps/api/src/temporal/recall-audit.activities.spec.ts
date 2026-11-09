import { describe, expect, it } from 'vitest';
import {
  RECALL_AUDIT_DISABLED,
  RECALL_AUDIT_MAX_FRAME_ENTITIES,
  createRecallAuditActivities,
} from './recall-audit.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';
const NOW = '2026-11-10T09:00:00.000Z';

const frame = { id: 'f1', frameKey: 'fr_sirene' };
const snapshot = { id: 's1', frameId: 'f1', status: 'PARSED' };

function fakePrisma(options: {
  frame?: Record<string, unknown> | null;
  snapshot?: Record<string, unknown> | null;
  entities?: Array<Record<string, unknown>>;
  pool?: {
    outcomes?: Array<Record<string, unknown>>;
    rawRecords?: Array<Record<string, unknown>>;
    companies?: Array<Record<string, unknown>>;
    contacts?: Array<Record<string, unknown>>;
  };
} = {}) {
  const tx = {
    discoveryCompanyMaterializationOutcome: {
      findMany: async () => options.pool?.outcomes ?? [],
    },
    rawSourceRecord: { findMany: async () => options.pool?.rawRecords ?? [] },
    canonicalCompany: { findMany: async () => options.pool?.companies ?? [] },
    canonicalContact: { groupBy: async () => options.pool?.contacts ?? [] },
  };
  return {
    registryFrame: { findUnique: async () => options.frame === undefined ? frame : options.frame },
    registrySnapshot: {
      findUnique: async () => snapshot,
      findFirst: async () => (options.snapshot === undefined ? snapshot : options.snapshot),
    },
    registryEntity: { findMany: async () => options.entities ?? [] },
    withWorkspace: async <T>(_workspaceId: string, fn: (client: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
}

const entity = (regNumber: string) => ({
  scheme: 'fr_siren',
  regNumber,
  country: 'FR',
  name: 'POMPES MARTIN SAS',
  nace: '28.13',
  employeeBand: '50-249',
});

describe('recall audit activities gate', () => {
  it('refuses every activity when RECALL_AUDIT_WORKFLOW_ENABLED is off (default)', async () => {
    const activities = createRecallAuditActivities({ prisma: fakePrisma() as never, enabled: false });
    for (const call of [
      activities.exportRecallFrameForAudit({ frameKey: 'fr_sirene' }),
      activities.exportRecallPoolForAudit({ workspaceId: WS, runId: RUN }),
      activities.runRecallAuditEstimate({ frame: [], pool: [] }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: RECALL_AUDIT_DISABLED });
    }
  });
});

describe('exportRecallFrameForAudit', () => {
  it('exports the frozen snapshot entities through the shared loader', async () => {
    const activities = createRecallAuditActivities({
      prisma: fakePrisma({ entities: [entity('529990001'), entity('529990002')] }) as never,
      enabled: true,
      now: () => NOW,
    });
    const exported = await activities.exportRecallFrameForAudit({ frameKey: 'fr_sirene' });
    expect(exported.manifest).toMatchObject({ frameKey: 'fr_sirene', snapshotId: 's1', rowCount: 2, exportedAt: NOW });
    expect(exported.manifest.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(exported.entities.map((row) => row.regNumber)).toEqual(['529990001', '529990002']);
  });

  it('fails closed when the frame or snapshot is missing', async () => {
    const noFrame = createRecallAuditActivities({ prisma: fakePrisma({ frame: null }) as never, enabled: true });
    await expect(noFrame.exportRecallFrameForAudit({ frameKey: 'nope' })).rejects.toThrow(/frame 不存在/u);

    const noSnapshot = createRecallAuditActivities({ prisma: fakePrisma({ snapshot: null }) as never, enabled: true });
    await expect(noSnapshot.exportRecallFrameForAudit({ frameKey: 'fr_sirene' })).rejects.toThrow(/未找到/u);

    const badStatus = createRecallAuditActivities({
      prisma: fakePrisma({ snapshot: { ...snapshot, status: 'FAILED' } }) as never,
      enabled: true,
    });
    await expect(badStatus.exportRecallFrameForAudit({ frameKey: 'fr_sirene' })).rejects.toThrow(/只能导出 PARSED/u);
  });

  it('rejects frames beyond the workflow payload cap and names the CLI path', async () => {
    const entities = Array.from({ length: RECALL_AUDIT_MAX_FRAME_ENTITIES + 1 }, (_, index) =>
      entity(String(index).padStart(9, '0')),
    );
    const activities = createRecallAuditActivities({ prisma: fakePrisma({ entities }) as never, enabled: true });
    await expect(activities.exportRecallFrameForAudit({ frameKey: 'fr_sirene' })).rejects.toMatchObject({
      code: 'FRAME_TOO_LARGE',
    });
  });
});

describe('exportRecallPoolForAudit', () => {
  it('builds the pool export from materialization outcomes, registry identity and contact counts', async () => {
    const activities = createRecallAuditActivities({
      prisma: fakePrisma({
        pool: {
          outcomes: [{ canonicalCompanyId: 'c1', rawRecordId: 'r1' }],
          rawRecords: [{ id: 'r1', externalId: 'fr_siren:529990001', providerKey: 'registry_frame' }],
          companies: [{ id: 'c1', name: 'POMPES MARTIN SAS', domain: 'pompes-martin.fr' }],
          contacts: [{ companyId: 'c1', _count: { _all: 2 } }],
        },
      }) as never,
      enabled: true,
      now: () => NOW,
    });
    const exported = await activities.exportRecallPoolForAudit({ workspaceId: WS, runId: RUN });
    expect(exported.manifest).toMatchObject({ runId: RUN, workspaceId: WS, rowCount: 1, exportedAt: NOW });
    expect(exported.pool).toEqual([
      {
        name: 'POMPES MARTIN SAS',
        registryScheme: 'fr_siren',
        registryNumber: '529990001',
        domain: 'pompes-martin.fr',
        contactFound: true,
        contacts: 2,
      },
    ]);
  });

  it('keeps non-registry providers unscoped instead of inventing a registry key', async () => {
    const activities = createRecallAuditActivities({
      prisma: fakePrisma({
        pool: {
          outcomes: [{ canonicalCompanyId: 'c1', rawRecordId: 'r1' }],
          rawRecords: [{ id: 'r1', externalId: 'Q12345', providerKey: 'wikidata' }],
          companies: [{ id: 'c1', name: 'X', domain: null }],
          contacts: [],
        },
      }) as never,
      enabled: true,
    });
    const exported = await activities.exportRecallPoolForAudit({ workspaceId: WS, runId: RUN });
    expect(exported.pool[0]).toMatchObject({ registryScheme: null, registryNumber: null, contacts: 0 });
  });
});

describe('runRecallAuditEstimate', () => {
  it('computes the Wilson estimate from the provided frame and pool', async () => {
    const activities = createRecallAuditActivities({ prisma: fakePrisma() as never, enabled: true });
    const audit = await activities.runRecallAuditEstimate({
      frame: [
        { scheme: 'fr_siren', regNumber: '529990001', country: 'FR', employeeBand: '50-249' },
        { scheme: 'fr_siren', regNumber: '529990002', country: 'FR', employeeBand: '50-249' },
        { scheme: 'fr_siren', regNumber: '529990003', country: 'FR', employeeBand: '50-249' },
      ],
      pool: [{ registryScheme: 'fr_siren', registryNumber: '529990001', domain: 'x.example' }],
      sampleSize: 2,
      seed: 'seed-1',
    });
    expect(audit.sample).toMatchObject({ size: 2, seed: 'seed-1', sampled: true });
    expect(audit.totals.N).toBe(3);
    expect(audit.totals.n).toBe(2);
    expect(audit.totals.found).toBeLessThanOrEqual(2);
  });

  it('rejects oversized inputs without computing', async () => {
    const activities = createRecallAuditActivities({ prisma: fakePrisma() as never, enabled: true });
    await expect(
      activities.runRecallAuditEstimate({
        frame: Array.from({ length: RECALL_AUDIT_MAX_FRAME_ENTITIES + 1 }, () => ({
          scheme: 'x',
          regNumber: '1',
          country: 'FR',
        })),
        pool: [],
      }),
    ).rejects.toMatchObject({ code: 'FRAME_TOO_LARGE' });
  });
});
