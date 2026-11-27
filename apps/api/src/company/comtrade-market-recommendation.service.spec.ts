import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { ComtradeMarketRecommendationService } from './comtrade-market-recommendation.service';

vi.mock('./comtrade-monthly-2026', () => {
  const flow = (code: string, importValueUsd: number, previousImportValueUsd: number) =>
    ({ code, importValueUsd, previousImportValueUsd });
  return {
    COMTRADE_MONTHLY_PERIOD: '202608',
    COMTRADE_MONTHLY_PREVIOUS_PERIOD: '202508',
    COMTRADE_MONTHLY_FLOWS: {
      '854143': [
        flow('DE', 300, 150), flow('US', 200, 240), flow('IT', 90, 60), flow('NL', 40, 20),
        flow('GB', 10, 11), flow('AT', 5, 5), flow('FR', 1000, 900), flow('CN', 0, 150),
        flow('EU', 5000, 4000), flow('XK', 5000, 4000),
      ],
      '850440': [
        flow('DE', 100, 250), flow('US', 180, 140), flow('NL', 20, 10),
        flow('FR', 500, 0), flow('JP', 800, 900), flow('CN', 100, 50),
        flow('EU', 5000, 4000), flow('XK', 5000, 4000),
      ],
      '847950': [flow('TH', 70, 50)],
      '842240': [flow('TH', 30, 50)],
      '847989': [flow('DE', 100, 50)],
    },
  };
});

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
  it('infers HS 854143 for a solar PV seller and preserves selected markets', async () => {
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
    expect(res.basis).toMatchObject({
      dataSource: 'un_comtrade_live',
      referenceYear: 2026,
      referencePeriod: '202608',
      coverage: 7,
      shareBasis: 'comparable_reporters',
    });
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

  it('uses comparable records for the general industrial HS when seller metadata is sparse', async () => {
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
    expect(res.basis).toMatchObject({ referencePeriod: '202608', coverage: 1 });
    expect(res.recommendations).toMatchObject([{ code: 'DE', importVolumeUsd: 100, confidence: 'low' }]);
  });

  it('sums the selected non-overlapping codes and uses the same full reporter cohort for share', async () => {
    const service = createService({ id: COMPANY_ID, targetMarkets: ['de'] });

    const res = await service.recommendForCompany(CTX, COMPANY_ID, {
      hsCodes: '8541,854143,850440,85414300',
      limit: 2,
    });

    expect(res.basis.hsCodes.map((item) => item.code)).toEqual(['854143', '850440']);
    expect(res.basis).toMatchObject({ referencePeriod: '202608', coverage: 3, shareBasis: 'comparable_reporters' });
    expect(res.recommendations).toMatchObject([
      { code: 'DE', rank: 1, importVolumeUsd: 400, yoyGrowthPct: 0, globalImportSharePct: 47.6, alreadySelected: true },
      { code: 'US', rank: 2, importVolumeUsd: 380, yoyGrowthPct: 0, globalImportSharePct: 45.2, alreadySelected: false },
    ]);
    expect(res.recommendations[0]?.hsCodes).toEqual(['854143', '850440']);
  });

  it('returns an empty 2026 cohort when any requested HS has no comparable data', async () => {
    const service = createService({ id: COMPANY_ID, industry: 'Photovoltaic Modules', targetMarkets: [] });

    const res = await service.recommendForCompany(CTX, COMPANY_ID, { hsCodes: '854143,850760' });

    expect(res.basis).toMatchObject({ inferredFrom: 'query_hs', referenceYear: 2026, referencePeriod: '202608', coverage: 0 });
    expect(res.basis.hsCodes.map((item) => item.code)).toEqual(['854143', '850760']);
    expect(res.recommendations).toEqual([]);
  });

  it('does not substitute other catalog products for an explicitly requested uncovered HS code', async () => {
    const service = createService({ id: COMPANY_ID, industry: 'Photovoltaic Modules', targetMarkets: [] });

    const res = await service.recommendForCompany(CTX, COMPANY_ID, { hsCodes: '854142' });

    expect(res.basis.hsCodes.map((item) => item.code)).toEqual(['854142']);
    expect(res.basis.coverage).toBe(0);
    expect(res.recommendations).toEqual([]);
  });

  it('throws NotFoundException when company does not exist or is soft-deleted', async () => {
    const service = createService(null);
    await expect(service.recommendForCompany(CTX, COMPANY_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});
