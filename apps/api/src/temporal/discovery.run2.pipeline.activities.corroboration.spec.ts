import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import type { ExecutionContext, EnrichmentResult } from '../discovery/provider-contract';
import { BudgetStoreUnavailableError } from '../tools/budget-store';
import { ToolPolicyDenied } from '../tools/tool-broker';
import { ViesTransientError } from '../adapters/vies';
import { currentEvidenceBundle } from '../discovery/evidence-bundle';
import { websiteProfileFreshAndCurrent } from './discovery.activities';

const mocks = vi.hoisted(() => ({ ack: vi.fn(), judge: vi.fn(async () => null) }));
vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: mocks.ack,
}));
vi.mock('../discovery/fit-judge', async (importOriginal) => ({
  ...await importOriginal<typeof import('../discovery/fit-judge')>(),
  judgeFitCompany: mocks.judge,
  loadIcpBrief: vi.fn(async () => ({})),
}));
import { createRun2PipelineActivities } from './discovery.run2.pipeline.activities';

const WS = '11111111-1111-4111-8111-111111111111';
const COMPANY = '44444444-4444-4444-8444-444444444444';
const binding = {
  authorityId: '55555555-5555-4555-8555-555555555555', replay: false, scopeKey: WS,
  accountKey: `discovery.run:discovery_run:request:${'c'.repeat(64)}:${'c'.repeat(64)}`,
  purpose: 'discovery.run', subjectType: 'discovery_run', subjectId: `request:${'c'.repeat(64)}`, requestSha256: 'c'.repeat(64),
};
const ARGS = { workspaceId: WS, runId: '22222222-2222-4222-8222-222222222222',
  icpId: '33333333-3333-4333-8333-333333333333', companyId: COMPANY,
  executionContractVersion: 2, executionBudget: binding, enrichmentSlot: 0 };
const RECEIPT: DurableExecutionReceipt = {
  schemaVersion: 'durable-execution-receipt/v1', scopeKey: WS, authorityId: binding.authorityId,
  accountId: '66666666-6666-4666-8666-666666666666', operationId: '77777777-7777-4777-8777-777777777777',
  operationKey: 'gleif-operation', resultStrategy: 'typed_projection', resultSchema: 'gleif-fetch/v1',
  resultDigest: 'a'.repeat(64), artifactId: null, usage: { currency: 'USD', unit: 'microusd' },
  costBasis: 'not_incurred', status: 'SETTLED',
};

function harness(options: { websiteEnabled?: boolean; admitted?: boolean; suppressed?: boolean; domain?: string | null } = {}) {
  const events: Array<{ payload?: { companyId?: string; provider?: string } }> = [];
  const company = { id: COMPANY, workspaceId: WS, name: 'Muster Pumpen Handel GmbH', domain: options.domain === undefined ? 'muster-pumpen.de' : options.domain,
    country: 'DE', region: null, industry: null, status: options.suppressed ? 'SUPPRESSED' : 'NEW',
    attributes: { website_profile: { _ts: new Date().toISOString(), trade_role: 'distributor',
      own_manufacturing: false, evidence: ['Autorisierter Händler für Industriepumpen und Pumpenanlagen.'] } } as Record<string, unknown> };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    discoveryCompanyJob: { findFirst: vi.fn(async () => options.admitted === false ? null : { canonicalCompanyId: COMPANY }) },
    canonicalCompany: {
      findUnique: vi.fn(async () => company),
      updateMany: vi.fn(async ({ data }: { data: { attributes?: Record<string, unknown> } }) => {
        if (data.attributes) company.attributes = data.attributes; return { count: 1 };
      }),
    },
    suppressionRecord: { findMany: vi.fn(async () => []) },
    fieldEvidence: { create: vi.fn(async () => ({})) },
    dataProvider: { findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
      ({ status: where.key === 'website_profile' && options.websiteEnabled !== false ? 'ENABLED' : 'DISABLED' })) },
    icpDefinition: { findUnique: vi.fn(async () => ({ companyAttributes: {}, targetMarkets: ['DE'] })) },
    runEvent: {
      aggregate: vi.fn(async () => ({ _max: { seq: BigInt(events.length) } })),
      create: vi.fn(async ({ data }: { data: { payload?: { companyId?: string; provider?: string } } }) => { events.push(data); return data; }),
      findFirst: vi.fn(async ({ where }: { where: { AND: Array<{ payload: { equals: string } }> } }) =>
        events.find((event) => event.payload?.companyId === where.AND[0]?.payload.equals &&
          event.payload?.provider === where.AND[1]?.payload.equals) ?? null),
    },
  };
  const enrichCompany = vi.fn(async (_input: unknown, ctx: ExecutionContext): Promise<EnrichmentResult> => {
    ctx.onDurableReceipt?.('gleif.fetch', RECEIPT);
    return { matched: true, confidence: 1, costCents: 0,
      attributes: { legal_name: company.name, registered_country: 'DE', entity_status: 'ACTIVE' } };
  });
  const routeEnrichment = vi.fn(async () => [{ key: 'gleif', enrichCompany }]);
  const websiteProfile = { profile: vi.fn() };
  const prisma = { withWorkspace: vi.fn(async (ws: string, fn: (client: typeof tx) => Promise<unknown>) => {
    expect(ws).toBe(WS); return fn(tx);
  }) };
  const acts = createRun2PipelineActivities({ prisma: prisma as never, providers: { routeEnrichment } as never,
    gateway: {} as never, websiteProfile, budgetStore: { attestAuthorized: vi.fn(async () => ({})) } as never });
  return { acts, tx, company, routeEnrichment, enrichCompany, websiteProfile };
}

beforeEach(() => {
  mocks.ack.mockReset(); mocks.judge.mockClear();
  mocks.ack.mockImplementation(async (args: { transaction: unknown; apply: (tx: unknown) => Promise<unknown> }) =>
    ({ value: await args.apply(args.transaction) }));
});

describe('Run2 independent corroboration before fit', () => {
  it('adds enabled registry evidence even when the website profile is fresh, under the same run authority', async () => {
    const h = harness();
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).toHaveBeenCalledOnce();
    expect(h.enrichCompany).toHaveBeenCalledWith(expect.objectContaining({ name: h.company.name, country: 'DE' }),
      expect.objectContaining({ workspaceId: WS, runId: binding.accountKey, authorizeExternalAction: expect.any(Function) }));
    expect(h.websiteProfile.profile).not.toHaveBeenCalled();
    expect(currentEvidenceBundle(h.company).coverage.tier_list).toEqual(['T1', 'T3']);
    expect(mocks.ack).toHaveBeenCalledWith(expect.objectContaining({ acknowledgements: [expect.objectContaining({ receipt: RECEIPT })] }));
  });

  it('does not couple independent corroboration to the website provider switch', async () => {
    const h = harness({ websiteEnabled: false });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).toHaveBeenCalledOnce();
    expect(h.websiteProfile.profile).not.toHaveBeenCalled();
  });

  it('can corroborate by legal name and country without a website domain', async () => {
    const h = harness({ domain: null });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).toHaveBeenCalledOnce();
    expect(h.websiteProfile.profile).not.toHaveBeenCalled();
  });

  it('does not repeat a successful source when the same activity resumes', async () => {
    const h = harness();
    await h.acts.profileCompanyOnce(ARGS);
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).toHaveBeenCalledOnce();
  });

  it('does not probe a suppressed company', async () => {
    const h = harness({ suppressed: true });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).not.toHaveBeenCalled();
  });

  it('records a normal upstream miss without claiming corroboration', async () => {
    const h = harness();
    h.enrichCompany.mockImplementation(async (_input, ctx) => {
      ctx.onDurableReceipt?.('gleif.fetch', RECEIPT);
      return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
    });
    await h.acts.profileCompanyOnce(ARGS);
    expect(currentEvidenceBundle(h.company).coverage.tier_list).toEqual(['T3']);
    expect(h.tx.runEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      type: 'company_enrichment_observed', payload: expect.objectContaining({ status: 'miss' }),
    }) }));
  });

  it('does not commit a matched identity without an authoritative receipt', async () => {
    const h = harness();
    h.enrichCompany.mockResolvedValue({ matched: true, confidence: 1, attributes: { registered_country: 'DE' }, costCents: 0 });
    await expect(h.acts.profileCompanyOnce(ARGS)).rejects.toMatchObject({ type: 'CONTROL_PLANE_REJECTED' });
    expect(h.company.attributes).not.toHaveProperty('gleif');
  });

  it('does not acknowledge a receipt from another budget authority', async () => {
    const h = harness();
    h.enrichCompany.mockImplementation(async (_input, ctx) => {
      ctx.onDurableReceipt?.('gleif.fetch', { ...RECEIPT, authorityId: '88888888-8888-4888-8888-888888888888' });
      return { matched: true, confidence: 1, attributes: { registered_country: 'DE' }, costCents: 0 };
    });
    await expect(h.acts.profileCompanyOnce(ARGS)).rejects.toMatchObject({ type: 'CONTROL_PLANE_REJECTED' });
    expect(mocks.ack).not.toHaveBeenCalled();
  });

  it('does not swallow a control error or a post-wire ACK failure', async () => {
    const h = harness();
    const error = new BudgetStoreUnavailableError('unavailable');
    h.enrichCompany.mockRejectedValueOnce(error);
    await expect(h.acts.profileCompanyOnce(ARGS)).rejects.toMatchObject({ type: 'BUDGET_AUTHORITY_NOT_READY' });
    mocks.ack.mockRejectedValueOnce(error);
    await expect(h.acts.profileCompanyOnce(ARGS)).rejects.toMatchObject({ type: 'BUDGET_AUTHORITY_NOT_READY' });
    expect(h.company.attributes).not.toHaveProperty('gleif');
  });

  it.each([
    [new Error('upstream unavailable'), 'provider_failed'],
    [new Error('WIKIDATA_RATE_LIMITED'), 'rate_limited'],
    [new Error('WIKIDATA_RATE_LIMITED_COOLDOWN'), 'not_executed_rate_limited'],
    [new ToolPolicyDenied('gleif.fetch', 'source_policy'), 'policy_blocked'],
  ])('distinguishes source failures from a normal miss: %s', async (error, status) => {
    const h = harness(); h.enrichCompany.mockRejectedValue(error);
    if (status.includes('rate_limited')) h.routeEnrichment.mockResolvedValue([{ key: 'wikidata', enrichCompany: h.enrichCompany }]);
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.tx.runEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      payload: expect.objectContaining({ status }),
    }) }));
  });

  it('does not use a conflicting country as the missing independent tier', async () => {
    const h = harness();
    h.enrichCompany.mockImplementation(async (_input, ctx) => {
      ctx.onDurableReceipt?.('gleif.fetch', RECEIPT);
      return { matched: true, confidence: 1, attributes: { registered_country: 'FR', legal_name: h.company.name }, costCents: 0 };
    });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.company.attributes).not.toHaveProperty('gleif');
    expect(h.tx.runEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      payload: expect.objectContaining({ status: 'identity_unconfirmed' }),
    }) }));
  });

  it('acknowledges completed child receipts when a later source read fails, without writing partial identity', async () => {
    const h = harness();
    h.enrichCompany.mockImplementationOnce(async (_input, ctx) => {
      ctx.onDurableReceipt?.('gleif.fetch', RECEIPT);
      throw new Error('later lookup failed');
    });
    await h.acts.profileCompanyOnce(ARGS);
    expect(mocks.ack).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgements: [expect.objectContaining({ receipt: RECEIPT })],
    }));
    expect(h.company.attributes).not.toHaveProperty('gleif');
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).toHaveBeenCalledOnce();
  });

  it('records a skipped write when commit-side suppression prevents the fact update', async () => {
    const h = harness(); mocks.ack.mockResolvedValueOnce({ value: false });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.company.attributes).not.toHaveProperty('gleif');
    expect(h.tx.runEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      payload: expect.objectContaining({ status: 'write_skipped' }),
    }) }));
  });

  it.each([undefined, -1, 50, 0.5])('does not probe a company outside the quoted slot: %s', async (enrichmentSlot) => {
    const h = harness();
    await h.acts.profileCompanyOnce({ ...ARGS, enrichmentSlot });
    expect(h.enrichCompany).not.toHaveBeenCalled();
  });

  it('profiles uncached company BEFORE corroboration so extracted P.IVA feeds VIES in the same run', async () => {
    const h = harness();
    h.company.name = 'Effe Energy';
    h.company.domain = 'effeenergy.it';
    h.company.country = 'IT';
    h.company.attributes = {};
    h.websiteProfile.profile.mockResolvedValue({
      homepageUrl: 'https://effeenergy.it/',
      impressumUrl: null,
      tradeRole: 'distributor',
      tradeRoleSource: 'rules',
      tradeRoleConfidence: 0.7,
      ownManufacturing: false,
      carriedBrands: [],
      carriesChineseBrand: false,
      carriesForeignBrand: false,
      legalName: null,
      register: null,
      vatId: 'IT04553650989',
      registeredAddress: null,
      evidence: ['Distributore fotovoltaico autorizzato.'],
    });
    const viesReceipt: DurableExecutionReceipt = {
      ...RECEIPT,
      operationKey: 'vies-op',
      resultSchema: 'vies-check/v1',
    };
    const viesEnrich = vi.fn(async (input: { vatId?: string }, ctx: ExecutionContext): Promise<EnrichmentResult> => {
      expect(input.vatId).toBe('IT04553650989');
      ctx.onDurableReceipt?.('vies.check', viesReceipt);
      return {
        matched: true,
        confidence: 1,
        costCents: 0,
        attributes: {
          vat_id: 'IT04553650989',
          legal_name: 'EFFE ENERGY SRL',
          registered_country: 'IT',
          registered_city: 'GUSSAGO',
          verified_status: 'VALID',
          request_date: '2026-11-26',
          match_confidence: 1,
        },
      };
    });
    h.routeEnrichment.mockResolvedValue([{ key: 'vies', enrichCompany: viesEnrich }]);

    await h.acts.profileCompanyOnce(ARGS);
    expect(h.websiteProfile.profile).toHaveBeenCalledOnce();
    expect(viesEnrich).toHaveBeenCalledOnce();
    expect((h.company.attributes as { website_profile?: { _parser_version?: string } }).website_profile?._parser_version)
      .toBe('website-profile/v2');
    expect(currentEvidenceBundle(h.company).coverage.tier_list).toEqual(['T1', 'T3']);
    expect(currentEvidenceBundle(h.company).coverage.corroborated).toBe(true);
  });

  it.each([
    [new ViesTransientError('VIES_RATE_LIMITED', 'IT'), 'rate_limited'],
    [new ViesTransientError('VIES_RATE_LIMITED_COOLDOWN', 'IT'), 'not_executed_rate_limited'],
    [new ViesTransientError('VIES_UNAVAILABLE', 'IT'), 'provider_unavailable'],
  ])('maps ViesTransientError %s to structured observation status %s', async (error, status) => {
    const h = harness();
    h.enrichCompany.mockRejectedValue(error);
    h.routeEnrichment.mockResolvedValue([{ key: 'vies', enrichCompany: h.enrichCompany }]);
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.tx.runEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      payload: expect.objectContaining({ provider: 'vies', status }),
    }) }));
  });

  it('invalidates pre-v2 fresh website_profile missing vat_id only when forceRefreshIfMissingVat is set', () => {
    const now = Date.parse('2026-11-26T00:00:00.000Z');
    const v1MissingVat = { website_profile: { _ts: '2026-11-25T00:00:00.000Z', trade_role: 'distributor' } };
    const v2MissingVat = { website_profile: { _ts: '2026-11-25T00:00:00.000Z', _parser_version: 'website-profile/v2', trade_role: 'distributor' } };
    const v1WithVat = { website_profile: { _ts: '2026-11-25T00:00:00.000Z', vat_id: 'IT04553650989' } };
    expect(websiteProfileFreshAndCurrent(v1MissingVat, false, now)).toBe(true);
    expect(websiteProfileFreshAndCurrent(v1MissingVat, false, now, { forceRefreshIfMissingVat: true })).toBe(false);
    expect(websiteProfileFreshAndCurrent(v2MissingVat, false, now, { forceRefreshIfMissingVat: true })).toBe(true);
    expect(websiteProfileFreshAndCurrent(v1WithVat, false, now, { forceRefreshIfMissingVat: true })).toBe(true);
  });

  it('does not probe a company without a deep job in this run', async () => {
    const h = harness({ admitted: false });
    await h.acts.profileCompanyOnce(ARGS);
    expect(h.enrichCompany).not.toHaveBeenCalled();
  });
});
