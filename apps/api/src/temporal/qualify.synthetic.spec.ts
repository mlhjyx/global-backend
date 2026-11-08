import { describe, expect, it, vi } from 'vitest';
import { createQualifyActivities } from './qualify.activities';

describe('QualifyActivities synthetic provenance quarantine', () => {
  it('filters a historical sandbox-backed company before scoring, sanctions checks, or Lead materialization', async () => {
    const leadUpsert = vi.fn();
    const sanctionsScreen = vi.fn();
    const outboxCreate = vi.fn(async () => ({}));
    const company = {
      id: 'company-synthetic',
      name: 'Synthetic Co',
      domain: 'synthetic.example',
      country: 'DE',
      industry: 'manufacturing',
      employeeCount: 10,
      revenueUsd: null,
      attributes: {},
      status: 'NEW',
      contacts: [],
      companyContactPoints: [],
    };
    const tx = {
      icpDefinition: {
        findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
      },
      canonicalCompany: { findMany: vi.fn(async () => [company]) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: company.id, providerKey: 'sandbox', license: 'sandbox' },
        ]),
      },
      lead: { findUnique: vi.fn(async () => null), upsert: leadUpsert },
      sanctionsScreeningResult: { findFirst: vi.fn(), upsert: vi.fn(), findMany: vi.fn(async () => []) },
      outboxEvent: { create: outboxCreate },
    };
    const prisma = {
      withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    };
    const activities = createQualifyActivities({
      prisma: prisma as never,
      sanctionsScreening: {
        rebuildIndex: vi.fn(async () => undefined),
        screen: sanctionsScreen,
      } as never,
    });

    await expect(
      activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' }),
    ).resolves.toMatchObject({ scored: 0 });
    expect(leadUpsert).not.toHaveBeenCalled();
    expect(sanctionsScreen).not.toHaveBeenCalled();
    // M2 步 10：批次事件照发（scored=0，候选为空——隔离也是可审计的产出），外加活动收尾的 LeadsScored。
    expect(outboxCreate).toHaveBeenCalledTimes(2);
    const batch = outboxCreate.mock.calls
      .map((call) => call[0] as { data: { eventType: string; payload: { scored: number; candidates: unknown[] } } })
      .find((call) => call.data.eventType === 'CandidateBatchCompleted');
    expect(batch?.data.payload).toMatchObject({ scored: 0, candidates: [] });
  });

  it('continues to score a real company when the same evidence batch contains no synthetic marker', async () => {
    const leadUpsert = vi.fn(async () => ({}));
    const company = {
      id: 'company-real',
      name: 'Real Co',
      domain: 'real.example',
      country: 'DE',
      industry: 'manufacturing',
      employeeCount: 10,
      revenueUsd: null,
      attributes: {},
      status: 'NEW',
      contacts: [],
      companyContactPoints: [],
    };
    const tx = {
      icpDefinition: {
        findUnique: vi.fn(async () => ({ status: 'ACTIVE', rules: [], roles: [], triggerSignals: [] })),
      },
      canonicalCompany: { findMany: vi.fn(async () => [company]) },
      suppressionRecord: { findMany: vi.fn(async () => []) },
      fieldEvidence: {
        findMany: vi.fn(async () => [
          { entityId: company.id, providerKey: 'companies_house', license: 'OGL-UK-3.0' },
        ]),
      },
      lead: { findUnique: vi.fn(async () => null), upsert: leadUpsert },
      sanctionsScreeningResult: { findFirst: vi.fn(), upsert: vi.fn(), findMany: vi.fn(async () => []) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    };
    const activities = createQualifyActivities({
      prisma: {
        withWorkspace: async <T>(_workspaceId: string, callback: (client: typeof tx) => Promise<T>): Promise<T> =>
          callback(tx),
      } as never,
    });

    await expect(
      activities.scoreCandidates({ workspaceId: 'ws-1', icpId: 'icp-1' }),
    ).resolves.toMatchObject({ scored: 1 });
    expect(leadUpsert).toHaveBeenCalledOnce();
  });
});
