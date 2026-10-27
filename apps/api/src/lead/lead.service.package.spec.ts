import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

/**
 * GET /leads/:id/package（交付闭环设计 §2/§3）：只读的交付读模型，只要 acquisition:read。
 * 只取公司级事实，不含联系人；合成来源（historical sandbox）不进产品读取。
 */
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;

function serviceWithTx(tx: unknown): LeadService {
  return new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
}

const lead = {
  id: 'lead-1',
  workspaceId: 'ws-1',
  icpId: 'icp-1',
  canonicalCompanyId: 'company-1',
  status: 'QUALIFIED',
  queue: 'recommended',
  fitVerdict: 'match',
  fitReasons: { reasons: ['在售 Grundfos'] },
  scores: { fit: 0.9, role: 0, intent: 0.4, dataQuality: 0.75, reachability: 1, engagement: 0 },
  scoreDetail: { ruleEvaluations: [], missingFields: [], reasonCodes: [] },
  totalScore: 0.8,
};

const company = {
  id: 'company-1',
  name: 'Beispiel Pumpen GmbH',
  domain: 'beispiel-pumpen.de',
  country: 'DE',
  status: 'ENRICHED',
  attributes: {
    website_profile: {
      trade_role: 'distributor',
      source_url: 'https://beispiel-pumpen.de/impressum',
      registered_address: 'Musterstraße 1, 12345 Musterstadt',
    },
    gleif: { lei: '529900T8BM49AURSDO55' },
  },
};

function txFor(over?: Record<string, unknown>) {
  return {
    // 一次 include 读取 lead 与其公司（联系人只取 id）。
    lead: { findUnique: vi.fn(async () => ({ ...lead, canonicalCompany: { ...company, contacts: [] } })) },
    canonicalCompany: { findUnique: vi.fn(async () => company) },
    fieldEvidence: {
      // First call is the provenance probe; the later one loads evidence detail.
      findMany: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args?.select && 'providerKey' in args.select
          ? [{ providerKey: 'website_profile', license: 'public' }]
          : [
              { entityId: 'company-1', field: 'website_profile.trade_role', fetchedAt: new Date('2026-10-20T00:00:00.000Z'), rawRecordId: 'raw-1' },
              { entityId: 'company-1', field: 'website_profile.vat_id', fetchedAt: new Date('2026-10-21T00:00:00.000Z'), rawRecordId: null },
            ],
      ),
      groupBy: vi.fn(async () => [{ dataClass: 'green', _min: { fetchedAt: new Date('2026-10-20T00:00:00.000Z') } }]),
    },
    companyContactPoint: {
      findMany: vi.fn(async () => [
        { kind: 'contact_page', value: 'https://beispiel-pumpen.de/kontakt', status: 'UNVERIFIED' },
        { kind: 'supplier_page', value: 'https://beispiel-pumpen.de/lieferanten', status: 'UNVERIFIED' },
        { kind: 'contact_form', value: 'https://blocked.example/kontakt', status: 'INVALID' },
      ]),
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    rawSourceRecord: { findMany: vi.fn(async () => [{ id: 'raw-1', sourceUrl: 'https://beispiel-pumpen.de/impressum' }]) },
    sanctionsScreeningResult: {
      findFirst: vi.fn(async () => ({ status: 'clear', reviewState: 'cleared', screenedAt: new Date('2026-10-19T00:00:00.000Z') })),
    },
    ...over,
  };
}

describe('LeadService.package', () => {
  it('assembles the package with company facts, paths and stored sanctions status', async () => {
    const tx = txFor();
    const pkg = await serviceWithTx(tx).leadPackage(ctx, 'lead-1');

    expect(pkg).toMatchObject({
      lead_id: 'lead-1',
      company: { canonical_company_id: 'company-1', name: 'Beispiel Pumpen GmbH' },
      registered_address: 'Musterstraße 1, 12345 Musterstadt',
      identifiers: { lei: '529900T8BM49AURSDO55', register_key: null, vat_id: null, fda_reg: null },
      sanctions: { status: 'clear', screened_at: '2026-10-19T00:00:00.000Z' },
    });
    expect(pkg.suggested_contact_path?.kind).toBe('supplier_page');
    expect(pkg.evidence).toEqual([
      {
        field: 'website_profile.vat_id',
        source_url: 'https://beispiel-pumpen.de/impressum',
        fetched_at: '2026-10-21T00:00:00.000Z',
      },
      {
        field: 'website_profile.trade_role',
        source_url: 'https://beispiel-pumpen.de/impressum',
        fetched_at: '2026-10-20T00:00:00.000Z',
      },
    ]);
    expect(tx.companyContactPoint.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'company-1' } }),
    );
    expect(tx.sanctionsScreeningResult.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { canonicalCompanyId: 'company-1' } }),
    );
  });

  it('drops contact paths on suppressed domains', async () => {
    const tx = txFor({
      suppressionRecord: { findMany: vi.fn(async () => [{ type: 'domain', value: 'beispiel-pumpen.de' }]) },
    });
    const pkg = await serviceWithTx(tx).leadPackage(ctx, 'lead-1');
    expect(pkg.contact_points).toEqual([]);
    expect(pkg.suggested_contact_path).toBeNull();
  });

  it('reports an unresolved or not-screened sanctions state honestly', async () => {
    const held = txFor({
      sanctionsScreeningResult: {
        findFirst: vi.fn(async () => ({ status: 'potential_match', reviewState: 'open', screenedAt: new Date('2026-10-19T00:00:00.000Z') })),
      },
    });
    expect((await serviceWithTx(held).leadPackage(ctx, 'lead-1')).sanctions.status).toBe('potential_match');

    const none = txFor({ sanctionsScreeningResult: { findFirst: vi.fn(async () => null) } });
    expect((await serviceWithTx(none).leadPackage(ctx, 'lead-1')).sanctions).toEqual({
      status: 'not_screened',
      screened_at: null,
    });
  });

  it('refuses a lead that does not exist', async () => {
    const tx = txFor({ lead: { findUnique: vi.fn(async () => null) } });
    await expect(serviceWithTx(tx).leadPackage(ctx, 'missing')).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
  });

  it('refuses historical synthetic provenance', async () => {
    const tx = txFor({
      fieldEvidence: {
        findMany: vi.fn(async (args: { select?: Record<string, unknown> }) =>
          args?.select && 'providerKey' in args.select
            ? [{ providerKey: 'sandbox', license: 'sandbox' }]
            : [],
        ),
        groupBy: vi.fn(async () => []),
      },
    });
    await expect(serviceWithTx(tx).leadPackage(ctx, 'lead-1')).rejects.toMatchObject({
      response: { error: { code: 'SYNTHETIC_PROVENANCE_QUARANTINED' } },
    });
  });
});
