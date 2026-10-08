import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_EXECUTION_QUOTE_OPERATIONS,
  resolveWorkspaceTechnicalBudgetEnvelope,
} from './workspace-technical-budget-envelope';

const COMPANY_ID = '20000000-0000-4000-8000-000000000002';
const ICP_ID = '30000000-0000-4000-8000-000000000003';
const POINT_ID = '40000000-0000-4000-8000-000000000004';
const PLAN_ID = '50000000-0000-4000-8000-000000000005';

describe('workspace execution technical envelope catalog', () => {
  it('machine-enumerates all and only the seven workspace operations', () => {
    expect(WORKSPACE_EXECUTION_QUOTE_OPERATIONS).toEqual([
      'POST /companies',
      'POST /companies/:companyId/icps',
      'POST /icps/:icpId/query-plans',
      'POST /query-plans/:planId/execute',
      'POST /canonical-companies/:id/discover-contacts',
      'POST /canonical-companies/:id/guess-emails',
      'POST /contact-points/:pointId/verify',
    ]);
  });

  it('quotes ICP design from one bounded structured task and its exact wire cap', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /companies/:companyId/icps',
      companyId: COMPANY_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'icp.design',
        logicalInvocations: 1,
        structuredWireUpperBound: 2,
        maxCostCents: 40,
        maxOutputTokens: 16_000,
      }),
    ]);
    expect(envelope.policy.tools).toEqual([]);
  });

  it('quotes query planning with both bounded taxonomy passes and refinements', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /icps/:icpId/query-plans',
      icpId: ICP_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'discovery.query_plan',
        logicalInvocations: 1,
      }),
      expect.objectContaining({
        taskId: 'taxonomy.normalize',
        logicalInvocations: 138,
      }),
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      industryTermsPerPass: 64,
      targetCountries: 8,
      taxonomyIndustryPasses: 2,
      taxonomyProductRefinements: 2,
    });
  });

  it('quotes email guess and verify as zero-priced bounded tool operations with a positive representation minimum', () => {
    const guess = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /canonical-companies/:id/guess-emails',
      companyId: COMPANY_ID,
      body: { maxContacts: 3, maxProbe: 2 },
    });
    const verify = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /contact-points/:pointId/verify',
      pointId: POINT_ID,
    });

    expect(guess.policy.tools).toEqual([
      expect.objectContaining({
        toolId: 'smtp.rcpt_probe',
        maxPhysicalInvocations: 6,
        estimatedCents: 0,
      }),
    ]);
    expect(guess.policy.executionLimits).toMatchObject({
      contacts: 3,
      probesPerContact: 2,
      mxDnsReads: 6,
      smtpRcptCommands: 12,
    });
    expect(verify.policy.tools).toEqual([
      expect.objectContaining({
        toolId: 'smtp.rcpt_probe',
        maxPhysicalInvocations: 1,
        estimatedCents: 0,
      }),
    ]);
    expect(guess.policy.representationMinimumMicrousd).toBe('1');
  });

  it('quotes a discovery run as the sum of every stage physical bound', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });

    // 66 queries = 64 planner queries + the TED and openFDA cold-path queries.
    expect(envelope.policy.models).toEqual([
      expect.objectContaining({ taskId: 'taxonomy.normalize', logicalInvocations: 66 * (4 + 2) }),
      expect.objectContaining({ taskId: 'discovery.extract_company', logicalInvocations: 66 * 14 }),
      expect.objectContaining({ taskId: 'discovery.extract_list', logicalInvocations: 66 * 8 * 3 }),
      // website profile (G3 5.4b): at most one classify call per profiled company
      expect.objectContaining({ taskId: 'discovery.classify_trade_role', logicalInvocations: 50 }),
      expect.objectContaining({ taskId: 'discovery.qualify_fit', logicalInvocations: 66 * 7 * 25 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['searxng.search', 66 * (3 + 4)],
      // directory pages + homepage and Impressum of each profiled company
      ['crawl4ai.fetch', 66 * 8 * 3 + 50 * 2],
      ['wikidata.sparql', 66],
      ['osm.overpass', 66],
      ['ted.search', 66],
      ['openfda.search', 66],
      ['tradefair.algolia', 66],
      ['gleif.fetch', 50 * 4],
      ['wikidata.entity', 50 * 3],
      ['crawl4ai.render', 12 * 2],
      // structured harvest (sitemap 8 + careers probes 6 + ATS 1) + watch sitemap 8
      ['http.get', 12 * 15 + 12 * 8],
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      planQueries: 66,
      companyDiscoveryAdapters: 7,
      providerRecords: 25,
      taxonomyIndustryTermsPerQuery: 4,
      taxonomyCountryTermsPerQuery: 2,
      fitCompanies: 11_550,
      profileCompanies: 50,
      enrichCompanies: 50,
      signalCompanies: 12,
      watchCompanies: 12,
    });
    // models: 396×2×5 + 924×2×15 + 1584×2×20 + 50×2×10 + 11550×2×20 = 558_040 cents;
    // tools: crawl4ai.fetch 1684×1 + crawl4ai.render 24×1 = 1_708 cents.
    expect(envelope.requiredCapMicrousd).toBe(559_748n * 10_000n);
  });

  it('quotes company creation from the bounded understanding crawl and per-page extraction', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /companies',
      body: { website: 'https://example.test' },
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({ taskId: 'company_understanding.extract_claims', logicalInvocations: 7 }),
      expect.objectContaining({ taskId: 'company_understanding.extract_offerings', logicalInvocations: 7 }),
      expect.objectContaining({ taskId: 'company_understanding.extract_profile', logicalInvocations: 1 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([['crawl4ai.fetch', 7]]);
    expect(envelope.policy.executionLimits).toEqual({ pages: 7, subpages: 6 });
    // 7×2×20 + 7×2×20 + 1×2×10 + 7×1 = 587 cents
    expect(envelope.requiredCapMicrousd).toBe(587n * 10_000n);
  });

  it('fails closed for contact discovery, which stays outside the company-level chain', () => {
    expect(() =>
      resolveWorkspaceTechnicalBudgetEnvelope({
        operation: 'POST /canonical-companies/:id/discover-contacts',
        companyId: COMPANY_ID,
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
  });

  it.each([
    [{ maxContacts: 26 }, 'contacts'],
    [{ maxProbe: 9 }, 'probes'],
  ])('rejects an invalid email-guess %s boundary without inventing a quote', (body) => {
    expect(() =>
      resolveWorkspaceTechnicalBudgetEnvelope({
        operation: 'POST /canonical-companies/:id/guess-emails',
        companyId: COMPANY_ID,
        body,
      }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_INVALID');
  });
});
