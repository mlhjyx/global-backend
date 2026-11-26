import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFrozenEnrichmentPlan } from '../enrichment/safety/enrichment-call-plan';
import {
  WORKSPACE_EXECUTION_QUOTE_OPERATIONS,
  resolveWorkspaceTechnicalBudgetEnvelope,
} from './workspace-technical-budget-envelope';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const COMPANY_ID = '20000000-0000-4000-8000-000000000002';
const ICP_ID = '30000000-0000-4000-8000-000000000003';
const POINT_ID = '40000000-0000-4000-8000-000000000004';
const PLAN_ID = '50000000-0000-4000-8000-000000000005';
const LEAD_ID = '60000000-0000-4000-8000-000000000006';

describe('workspace execution technical envelope catalog', () => {
  it('machine-enumerates all and only registered bounded workspace operations', () => {
    expect(WORKSPACE_EXECUTION_QUOTE_OPERATIONS).toEqual([
      'POST /companies',
      'POST /companies/:companyId/icps',
      'POST /icps/:icpId/query-plans',
      'POST /query-plans/:planId/execute',
      'POST /canonical-companies/:id/discover-contacts',
      'POST /canonical-companies/:id/enrich-contacts',
      'POST /canonical-companies/:id/guess-emails',
      'POST /contact-points/:pointId/verify',
      'POST /leads/:leadId/outreach-drafts',
      'POST /companies/:companyId/understanding/retry',
      'POST /site-builder/intake',
      'POST /campaigns/:campaignId/plan-drafts',
      'POST /market-candidate-generations/:generationId/execute',
    ]);
  });

  it('prices the enrich-contacts governed catalog with conservative integer-cent upper bounds', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope(
      {
        operation: 'POST /canonical-companies/:id/enrich-contacts',
        companyId: COMPANY_ID,
      },
      {},
    );
    // 5 governed tools: (1 + 2 + 1 + 1 + 1) cents × 10 contacts = 60 cents = 600000 µUSD.
    expect(envelope.requiredCapMicrousd).toBe(600_000n);
    expect(envelope.policy.models).toEqual([]);
    expect(envelope.policy.tools).toEqual([
      { toolId: 'contact_email.find.hunter', version: '1.0.0', maxPhysicalInvocations: 10, estimatedCents: 1, costUnit: 'request' },
      { toolId: 'contact_email.find.prospeo', version: '1.0.0', maxPhysicalInvocations: 10, estimatedCents: 2, costUnit: 'request' },
      { toolId: 'contact_email.verify.millionverifier', version: '1.0.0', maxPhysicalInvocations: 10, estimatedCents: 1, costUnit: 'request' },
      { toolId: 'contact_email.verify.emailable', version: '1.0.0', maxPhysicalInvocations: 10, estimatedCents: 1, costUnit: 'request' },
      { toolId: 'contact_email.verify.zerobounce', version: '1.0.0', maxPhysicalInvocations: 10, estimatedCents: 1, costUnit: 'request' },
    ]);
    expect(envelope.policy.executionLimits).toEqual({
      finderCallsPerCompany: 10,
      verificationCallsPerAddress: 6,
      contactsPerRequest: 10,
      providerConcurrency: 2,
      softDeadlineMs: 600_000,
      contactEnrichPricePolicyVersion: 1,
      hunterUnitQuoteUpperMicrousd: 1_700,
      prospeoUnitQuoteUpperMicrousd: 19_800,
      millionverifierUnitQuoteUpperMicrousd: 1_780,
      emailableUnitQuoteUpperMicrousd: 7_600,
      zerobounceUnitQuoteUpperMicrousd: 9_900,
    });
  });

  it('keeps the integer-cent cap while a same-bucket unit price change still reaches the policy hash inputs', () => {
    const request = {
      operation: 'POST /canonical-companies/:id/enrich-contacts',
      companyId: COMPANY_ID,
    } as const;
    const base = resolveWorkspaceTechnicalBudgetEnvelope(request, {});
    const moved = resolveWorkspaceTechnicalBudgetEnvelope(request, {
      HUNTER_COST_MICROUSD: '1900',
    });
    expect(moved.requiredCapMicrousd).toBe(base.requiredCapMicrousd);
    expect(moved.policy.executionLimits).not.toEqual(base.policy.executionLimits);
    expect(moved.policy.executionLimits.hunterUnitQuoteUpperMicrousd).toBe(1_900);
  });

  it('fails closed when a configured governed price leaves the controlled range', () => {
    expect(() =>
      resolveWorkspaceTechnicalBudgetEnvelope(
        {
          operation: 'POST /canonical-companies/:id/enrich-contacts',
          companyId: COMPANY_ID,
        },
        { ZEROBOUNCE_COST_MICROUSD: '150001' },
      ),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
  });

  it('never emits provider credentials or base URLs through the enrich quote policy', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope(
      {
        operation: 'POST /canonical-companies/:id/enrich-contacts',
        companyId: COMPANY_ID,
      },
      {
        HUNTER_API_KEY: 'secret-hunter-key',
        HUNTER_BASE_URL: 'https://private.example.invalid',
        EMAILABLE_API_KEY: 'secret-emailable-key',
      },
    );
    expect(JSON.stringify(envelope.policy)).not.toMatch(/secret-|private\.example\.invalid/u);
  });

  it('bounds any maximal legal enrich plan by the quoted catalog for the same prices', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope(
      {
        operation: 'POST /canonical-companies/:id/enrich-contacts',
        companyId: COMPANY_ID,
      },
      {},
    );
    const contactIds = Array.from({ length: 10 }, (_, ordinal) =>
      `60000000-0000-4000-8000-0000000000${ordinal}`,
    );
    const targets = contactIds.map((contactId, contactOrdinal) => ({
      contactId,
      contactOrdinal,
      inputVersion: 'a'.repeat(64),
      beforeDigest: 'b'.repeat(64),
      pointRefs: [],
    }));
    const tools = [
      { provider: 'hunter', toolId: 'contact_email.find.hunter', phase: 'FINDER', quote: '1700' },
      { provider: 'millionverifier', toolId: 'contact_email.verify.millionverifier', phase: 'VERIFY', quote: '1780' },
      { provider: 'emailable', toolId: 'contact_email.verify.emailable', phase: 'VERIFY', quote: '7600' },
      { provider: 'zerobounce', toolId: 'contact_email.verify.zerobounce', phase: 'VERIFY', quote: '9900' },
    ] as const;
    const slots = contactIds.flatMap((contactId, contactOrdinal) => {
      let predecessor: string | null = null;
      return tools.map((item, position) => {
        const slotKey = `contact-${contactOrdinal}-${item.phase.toLowerCase()}-${position}`;
        const slot = {
          slotKey,
          contactId,
          contactOrdinal,
          phase: item.phase,
          provider: item.provider,
          toolId: item.toolId,
          toolVersion: '1.0.0',
          quoteMicrousd: item.quote,
          pricingVersion: 'p1',
          dependsOnSlotKey: predecessor,
        };
        predecessor = slotKey;
        return slot;
      });
    });
    const plan = buildFrozenEnrichmentPlan({
      workspaceId: '10000000-0000-4000-8000-000000000001',
      companyId: COMPANY_ID,
      entrypoint: 'http',
      businessRunId: null,
      requestSha256: 'c'.repeat(64),
      admittedAtMs: 1_000,
      deadlineAtMs: 601_000,
      targets,
      slots,
      limits: {
        authorityCapMicrousd: '6000000',
        companyCapMicrousd: '6000000',
        contactCapMicrousd: '150000',
        finderCompanyMax: 10,
        finderContactMax: 3,
        verifyAddressMax: 6,
        maxContacts: 10,
      },
    });
    const planTotalMicrousd = plan.slots.reduce(
      (sum, slot) => sum + BigInt(slot.quoteMicrousd),
      0n,
    );
    // 10 × (1700 + 1780 + 7600 + 9900) = 209800 µUSD exact, bounded by the 400000 µUSD quote.
    expect(planTotalMicrousd).toBe(209_800n);
    expect(planTotalMicrousd).toBeLessThanOrEqual(envelope.requiredCapMicrousd);
  });

  it('quotes a campaign plan draft from one bounded planning task', () => {
    const campaignId = '70000000-0000-4000-8000-000000000007';
    const jobId = '80000000-0000-4000-8000-000000000008';
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /campaigns/:campaignId/plan-drafts',
      campaignId,
      body: { jobId },
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'campaign.plan',
        logicalInvocations: 1,
      }),
    ]);
    expect(envelope.policy.tools).toEqual([]);
    expect(envelope.policy.operation).toBe(
      'POST /campaigns/:campaignId/plan-drafts',
    );
    expect(envelope.policy.executionLimits).toEqual({ modelLogicalInvocations: 1 });
    expect(envelope.requiredCapMicrousd).toBeGreaterThan(0n);
  });

  it('quotes an outreach draft from one bounded structured task and its exact wire cap', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /leads/:leadId/outreach-drafts',
      leadId: LEAD_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'outreach.first_contact_draft',
        logicalInvocations: 1,
        structuredWireUpperBound: 2,
        maxCostCents: 20,
        maxOutputTokens: 8_192,
      }),
    ]);
    expect(envelope.policy.tools).toEqual([]);
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
      // WEB-1：每查询 6 轮探索 + 1 次结构确认
      expect.objectContaining({ taskId: 'discovery.web_search_candidates', logicalInvocations: 66 * 7 }),
      // website profile (G3 5.4b): at most one classify call per profiled company
      expect.objectContaining({ taskId: 'discovery.classify_trade_role', logicalInvocations: 50 }),
      expect.objectContaining({ taskId: 'discovery.qualify_fit', logicalInvocations: 500 }),
      // L1 快扫（P3 W5）：500 家池 / 8 家每批 = 63 次批量粗判上限。
      expect.objectContaining({ taskId: 'discovery.quick_judge', logicalInvocations: 63 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['searxng.search', 66 * (3 + 4) + 66 * 10],
      ['deepseek.search', 66 * 10],
      ['serper.search', 66 * (3 + 4) + 66 * 10],
      ['brave.search', 66 * (3 + 4) + 66 * 10],
      ['exa.search', 66 * 3 + 66 * 10],
      ['google_places.search', 66 * 3],
      // directory pages + homepage and Impressum of each profiled company
      ['crawl4ai.fetch', 66 * 8 * 3 + 50 * 3],
      ['wikidata.sparql', 66],
      ['osm.overpass', 66],
      ['ted.search', 66],
      ['openfda.search', 66],
      ['opencorporates.search', 66],
      ['companies_house.search', 66],
      ['tradefair.algolia', 66],
      ['gleif.fetch', 50 * 4],
      ['vies.check', 50 * 1],
      ['wikidata.entity', 50 * 3],
      // digital footprint + structured harvest per signal company, and the contact page of
      // each profiled company (BI-14, at most one render each)
      ['crawl4ai.render', 12 * 2 + 50 * 1],
      // structured harvest (sitemap 8 + careers probes 6 + ATS 1) + watch sitemap 8
      ['http.get', 12 * 15 + 12 * 8],
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      planQueries: 66,
      companyDiscoveryAdapters: 12,
      providerRecords: 25,
      taxonomyIndustryTermsPerQuery: 4,
      taxonomyCountryTermsPerQuery: 2,
      fitCompanies: 500,
      profileCompanies: 50,
      enrichCompanies: 50,
      signalCompanies: 12,
      watchCompanies: 12,
    });
    // models: 396×2×5 + 924×2×3 + 1584×2×5 + 462×2×5 + 50×2×3 + 500×2×20 + 63×2×20 = 52_784 cents
    // tools: 自托管 crawl4ai.fetch / crawl4ai.render 按 0¢ 计，仅外部付费工具计入：
    // deepseek.search 660×1 + serper 1122×1 + brave 1122×1 + exa 858×1 + google_places 198×4 = 4_554 cents；合计 57_338 cents。
    expect(envelope.policy.tools.find((t) => t.toolId === 'crawl4ai.fetch')?.estimatedCents).toBe(0);
    expect(envelope.policy.tools.find((t) => t.toolId === 'crawl4ai.render')?.estimatedCents).toBe(0);
    expect(envelope.requiredCapMicrousd).toBe(57_338n * 10_000n);
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
    expect(envelope.policy.tools[0]?.estimatedCents).toBe(0);
    expect(envelope.policy.executionLimits).toEqual({ pages: 7, subpages: 6 });
    // 7×2×20 + 7×2×20 + 1×2×10 + 7×0 = 580 cents
    expect(envelope.requiredCapMicrousd).toBe(580n * 10_000n);
  });

  it('quotes understanding retry with the same bounded envelope as creation', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /companies/:companyId/understanding/retry',
      companyId: COMPANY_ID,
      body: { attemptId: '6d5c4b3a-2918-4f7e-8d9c-0b1a2c3d4e5f' },
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
    expect(envelope.requiredCapMicrousd).toBe(580n * 10_000n);
  });

  it('quotes one on-demand contact discovery from the per-company adapter ceilings', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /canonical-companies/:id/discover-contacts',
      companyId: COMPANY_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({
        taskId: 'contact.find_decision_makers',
        logicalInvocations: 8,
        structuredWireUpperBound: 2,
        maxCostCents: 15,
      }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['crawl4ai.fetch', 14],
      ['crawl4ai.render', 8],
      ['social.search', 4],
      ['social.fetch', 12],
      ['companies_house.search', 2],
      ['inpi_rne.search', 1],
      ['google_patents.search', 1],
    ]);
    // 8×2×15 (model reservation) + 自托管 crawl4ai.fetch/render/social.fetch 0¢ = 240 cents.
    expect(envelope.requiredCapMicrousd).toBe(240n * 10_000n);
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

describe('DISCOVERY_UNCAPPED=on —— 报价按防爆安全界（余额是唯一收紧条件）', () => {
  it('discovery run 包络随去帽开关放大到安全界，并打上 discoveryUncapped 标记', async () => {
    vi.resetModules();
    vi.stubEnv('DISCOVERY_UNCAPPED', 'on');
    const { resolveWorkspaceTechnicalBudgetEnvelope: resolve } = await import(
      './workspace-technical-budget-envelope'
    );

    const envelope = resolve({
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });

    expect(envelope.policy.models).toEqual([
      expect.objectContaining({ taskId: 'taxonomy.normalize', logicalInvocations: 66 * (4 + 2) }),
      expect.objectContaining({ taskId: 'discovery.extract_company', logicalInvocations: 66 * 14 }),
      expect.objectContaining({ taskId: 'discovery.extract_list', logicalInvocations: 66 * 8 * 3 }),
      // 去帽模式工具环 24 轮探索 + 1 次结构确认
      expect.objectContaining({ taskId: 'discovery.web_search_candidates', logicalInvocations: 66 * 25 }),
      expect.objectContaining({ taskId: 'discovery.classify_trade_role', logicalInvocations: 50 }),
      // 66 查询 × 12 适配器 × 1000 条记录安全界
      expect.objectContaining({ taskId: 'discovery.qualify_fit', logicalInvocations: 792_000 }),
      // 快扫池 5 万 / 8 家每批 = 6250 次批量粗判上限
      expect.objectContaining({ taskId: 'discovery.quick_judge', logicalInvocations: 6_250 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['searxng.search', 66 * (3 + 4) + 66 * 100],
      ['deepseek.search', 66 * 100],
      ['serper.search', 66 * (3 + 4) + 66 * 100],
      ['brave.search', 66 * (3 + 4) + 66 * 100],
      ['exa.search', 66 * 3 + 66 * 100],
      ['google_places.search', 66 * 3],
      ['crawl4ai.fetch', 66 * 8 * 3 + 50 * 3],
      ['wikidata.sparql', 66],
      ['osm.overpass', 66],
      ['ted.search', 66],
      ['openfda.search', 66],
      ['opencorporates.search', 66],
      ['companies_house.search', 66],
      ['tradefair.algolia', 66],
      ['gleif.fetch', 50 * 4],
      ['vies.check', 50 * 1],
      ['wikidata.entity', 50 * 3],
      ['crawl4ai.render', 12 * 2 + 50 * 1],
      ['http.get', 12 * 15 + 12 * 8],
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      planQueries: 66,
      providerRecords: 1_000,
      fitCompanies: 792_000,
      // policyRevision 可审计标记：去帽模式的包络与产品帽模式可区分。
      discoveryUncapped: 1,
    });
    // models: 396×2×5 + 924×2×3 + 1584×2×5 + 1650×2×5 + 50×2×3 + 792000×2×20 + 6250×2×20
    //       = 31_972_144 cents；tools: deepseek 6600 + serper 7062 + brave 7062 + exa 6798 + google_places 792 = 28_314 cents（自托管 crawl4ai 0¢）；合计 32_000_458 cents。
    expect(envelope.requiredCapMicrousd).toBe(32_000_458n * 10_000n);
  });

  it('产品帽模式的报价保持稳定上界（开关 off 时不含 discoveryUncapped）', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });
    expect(envelope.policy.executionLimits).not.toHaveProperty('discoveryUncapped');
    expect(envelope.requiredCapMicrousd).toBe(57_338n * 10_000n);
  });
});


it('quotes one market-generation task at 40 cents with the unchanged two-wire repair ceiling, not a fresh per-attempt pool', () => {
  const envelope = resolveWorkspaceTechnicalBudgetEnvelope({ operation: 'POST /market-candidate-generations/:generationId/execute', generationId: '66666666-6666-4666-8666-666666666666', body: { intentDigest: 'a'.repeat(64) } });
  expect(envelope).toMatchObject({ requiredCapMicrousd: 800_000n, policy: { tools: [], executionLimits: { modelLogicalInvocations: 1 }, models: [{ taskId: 'market.candidates.generate', logicalInvocations: 1, structuredWireUpperBound: 2, maxCostCents: 40, maxOutputTokens: 16_000 }] } });
});
