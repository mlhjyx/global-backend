import { describe, expect, it, vi } from 'vitest';
import {
  persistEnrichmentCompanySignals,
  projectEnrichmentHitsToSignals,
} from './enrichment-signal-projection';
import { createDiscoveryActivities } from '../temporal/discovery.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const ICP = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '44444444-4444-4444-8444-444444444444';

describe('Phase 1: enrichment signal projection to company_signal and Run 2.0 watch registration', () => {
  it('projects digital_footprint and structured_harvest hits into CHECK-safe page_change company_signal items', () => {
    const observedAt = new Date('2026-11-25T10:00:00.000Z');
    const items = projectEnrichmentHitsToSignals(
      [
        {
          key: 'digital_footprint',
          result: {
            matched: true,
            confidence: 1,
            costCents: 0,
            attributes: {
              is_advertiser: true,
              ad_pixels: ['google_ads', 'linkedin_insight'],
              hiring_signal: { open_roles: 2, titles: ['Solar Engineer', 'Sales Manager'] },
            },
            provenance: {
              sourceUrl: 'https://acme-solar.it/',
              fetchedAt: observedAt.toISOString(),
              contentHash: 'a'.repeat(64),
              parserVersion: 'digital-footprint/v1',
            },
          },
        },
        {
          key: 'structured_harvest',
          result: {
            matched: true,
            confidence: 1,
            costCents: 0,
            attributes: {
              careers_url: 'https://acme-solar.it/lavora-con-noi',
              hiring_signal: {
                open_roles: 3,
                titles: ['Procurement Manager', 'Project Engineer'],
                has_buying_role: true,
              },
            },
            provenance: {
              sourceUrl: 'https://acme-solar.it/lavora-con-noi',
              fetchedAt: observedAt.toISOString(),
              contentHash: 'b'.repeat(64),
              parserVersion: 'structured-harvest/v1',
            },
          },
        },
      ],
      observedAt,
    );

    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.every((item) => item.signalKind === 'page_change')).toBe(true);
    expect(items.some((item) => item.providerKey === 'digital_footprint' && item.title.includes('广告'))).toBe(true);
    expect(items.some((item) => item.providerKey === 'structured_harvest' && item.title.includes('采购'))).toBe(true);
  });

  it('persists projected signals idempotently via companySignal.createMany(skipDuplicates: true)', async () => {
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    const res = await persistEnrichmentCompanySignals(
      { companySignal: { createMany } } as never,
      {
        workspaceId: WS,
        companyId: COMPANY_ID,
        signalTimestamp: new Date('2026-11-25T10:00:00.000Z'),
        hits: [
          {
            key: 'structured_harvest',
            result: {
              matched: true,
              confidence: 1,
              costCents: 0,
              attributes: {
                careers_url: 'https://acme-solar.it/careers',
                hiring_signal: { open_roles: 2, titles: ['Buyer'], has_buying_role: true },
              },
              provenance: {
                sourceUrl: 'https://acme-solar.it/careers',
                fetchedAt: '2026-11-25T10:00:00.000Z',
                contentHash: 'c'.repeat(64),
                parserVersion: 'structured-harvest/v1',
              },
            },
          },
        ],
      },
    );

    expect(res.inserted).toBe(1);
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skipDuplicates: true,
        data: [
          expect.objectContaining({
            workspaceId: WS,
            companyId: COMPANY_ID,
            providerKey: 'structured_harvest',
            signalKind: 'page_change',
            sourceUrl: 'https://acme-solar.it/careers',
          }),
        ],
      }),
    );
  });

  it('registerWatchesForRun discovers Run 2.0 deep-matched companies from discoveryCompanyJob without raw_source_record rows', async () => {
    const hash = 'c'.repeat(64);
    const findCompanies = vi.fn(async () => [{ id: COMPANY_ID }]);
    const tx = {
      rawSourceRecord: { findMany: vi.fn(async () => []) },
      identityLink: { findMany: vi.fn(async () => []) },
      discoveryCompanyJob: {
        findMany: vi.fn(async () => [{ canonicalCompanyId: COMPANY_ID }]),
      },
      canonicalCompany: { findMany: findCompanies },
    };
    const acts = createDiscoveryActivities({
      prisma: {
        withWorkspace: async <T>(_ws: string, cb: (client: typeof tx) => Promise<T>) => cb(tx),
      } as never,
      providers: {} as never,
      gateway: {} as never,
      budgetStore: { attestAuthorized: vi.fn(async () => undefined) } as never,
    });

    const out = await acts.registerWatchesForRun({
      workspaceId: WS,
      runId: RUN,
      icpId: ICP,
      executionContractVersion: 2,
      executionBudget: {
        authorityId: '55555555-5555-4555-8555-555555555555',
        replay: false,
        scopeKey: WS,
        accountKey: `discovery.run:discovery_run:request:${hash}:${hash}`,
        purpose: 'discovery.run',
        subjectType: 'discovery_run',
        subjectId: `request:${hash}`,
        requestSha256: hash,
      },
    });

    expect(tx.discoveryCompanyJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: RUN, verdictDeep: 'match' } }),
    );
    expect(findCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [COMPANY_ID] } }),
      }),
    );
    // No platformWriter in mock → reports candidates discovered (1) without throwing
    expect(out.candidates).toBe(1);
  });
});
