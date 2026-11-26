import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { ComtradeMarketRecommendationService } from './comtrade-market-recommendation.service';

const CTX: RequestContext = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000002',
  roles: ['MEMBER'],
  scopes: ['acquisition:read'],
};
const COMPANY_ID = '30000000-0000-4000-8000-000000000003';

function createService(
  company: Record<string, unknown> | null,
  offerings: Array<{ name: string; description: string | null; attributes: unknown }> = [],
) {
  const tx = {
    companyProfile: { findUnique: vi.fn(async () => company) },
    offering: { findMany: vi.fn(async () => offerings) },
  };
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return new ComtradeMarketRecommendationService(prisma);
}

describe('ComtradeMarketRecommendationService', () => {
  it('infers HS 854143 for solar PV seller and returns ranked European/global markets with alreadySelected flag', async () => {
    const service = createService(
      {
        id: COMPANY_ID,
        name: 'Liansheng Solar',
        industry: 'Photovoltaic Modules',
        summary: 'HJT 720W solar panels manufacturer',
        targetMarkets: ['IT', 'DE'],
        deletedAt: null,
      },
      [{ name: 'HJT 720W Solar Modules', description: null, attributes: { selectedByUser: true } }],
    );

    const res = await service.recommendForCompany(CTX, COMPANY_ID, { limit: 6 });

    expect(res.isRecommendationOnly).toBe(true);
    expect(res.basis.inferredFrom).toBe('offerings_and_industry');
    expect(res.basis.hsCodes[0]?.code).toBe('854143');
    expect(res.recommendations).toHaveLength(6);
    expect(res.recommendations[0]?.rank).toBe(1);
    expect(res.recommendations[0]?.importVolumeUsd).toBeGreaterThan(0);
    const itRec = res.recommendations.find((r) => r.code === 'IT');
    const nlRec = res.recommendations.find((r) => r.code === 'NL');
    expect(itRec?.alreadySelected).toBe(true);
    expect(nlRec?.alreadySelected).toBe(false);
  });

  it('supports explicit hsCodes query override with high confidence across multiple HS tracks', async () => {
    const service = createService({
      id: COMPANY_ID,
      name: 'Precision Automation Co.',
      industry: 'General',
      summary: null,
      targetMarkets: [],
      deletedAt: null,
    });

    const res = await service.recommendForCompany(CTX, COMPANY_ID, {
      hsCodes: '847950,842240',
      limit: 5,
    });

    expect(res.basis.inferredFrom).toBe('query_hs');
    expect(res.basis.hsCodes.map((h) => h.code)).toEqual(['847950', '842240']);
    expect(res.recommendations[0]?.confidence).toBe('high');
    expect(res.recommendations.some((r) => r.code === 'TH')).toBe(true);
  });

  it('falls back cleanly to general industrial B2B baseline when seller has sparse metadata', async () => {
    const service = createService({
      id: COMPANY_ID,
      name: 'New Trading Ltd',
      industry: null,
      summary: null,
      targetMarkets: [],
      deletedAt: null,
    });

    const res = await service.recommendForCompany(CTX, COMPANY_ID);

    expect(res.basis.inferredFrom).toBe('fallback_general');
    expect(res.basis.hsCodes[0]?.code).toBe('847989');
    expect(res.recommendations.length).toBeGreaterThanOrEqual(5);
    expect(res.recommendations[0]?.confidence).toBe('low');
  });

  it('throws NotFoundException when company does not exist or is soft-deleted', async () => {
    const service = createService(null);
    await expect(service.recommendForCompany(CTX, COMPANY_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
