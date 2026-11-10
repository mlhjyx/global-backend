import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it('machine-enumerates all and only the twelve workspace operations', () => {
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
    ]);
  });

  it('quotes the enrich-contacts execution shape without pricing provider calls yet', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /canonical-companies/:id/enrich-contacts',
      companyId: COMPANY_ID,
    });
    // 付费 finder/验证 API 尚未经 ToolBroker 计价：envelope 只给执行形状，cap 为表示最小值。
    expect(envelope.requiredCapMicrousd).toBe(1n);
    expect(envelope.policy.models).toEqual([]);
    expect(envelope.policy.tools).toEqual([]);
    expect(envelope.policy.executionLimits).toEqual({
      finderCallsPerCompany: 10,
      verificationCallsPerAddress: 6,
      contactsPerRequest: 10,
      providerConcurrency: 2,
      softDeadlineMs: 600_000,
    });
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
      expect.objectContaining({ taskId: 'discovery.qualify_fit', logicalInvocations: 66 * 9 * 25 }),
      // L1 快扫（P3 W5）：500 家池 / 8 家每批 = 63 次批量粗判上限。
      expect.objectContaining({ taskId: 'discovery.quick_judge', logicalInvocations: 63 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['searxng.search', 66 * (3 + 4) + 66 * 10],
      ['deepseek.search', 66 * 10],
      // directory pages + homepage and Impressum of each profiled company
      ['crawl4ai.fetch', 66 * 8 * 3 + 50 * 2],
      ['wikidata.sparql', 66],
      ['osm.overpass', 66],
      ['ted.search', 66],
      ['openfda.search', 66],
      ['tradefair.algolia', 66],
      ['gleif.fetch', 50 * 4],
      ['wikidata.entity', 50 * 3],
      // digital footprint + structured harvest per signal company, and the contact page of
      // each profiled company (BI-14, at most one render each)
      ['crawl4ai.render', 12 * 2 + 50 * 1],
      // structured harvest (sitemap 8 + careers probes 6 + ATS 1) + watch sitemap 8
      ['http.get', 12 * 15 + 12 * 8],
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      planQueries: 66,
      companyDiscoveryAdapters: 9,
      providerRecords: 25,
      taxonomyIndustryTermsPerQuery: 4,
      taxonomyCountryTermsPerQuery: 2,
      fitCompanies: 14_850,
      profileCompanies: 50,
      enrichCompanies: 50,
      signalCompanies: 12,
      watchCompanies: 12,
    });
    // models: 396×2×5 + 924×2×15 + 1584×2×20 + 462×2×15 + 50×2×10 + 14850×2×20 + 63×2×20 = 706_420 cents;
    // tools: crawl4ai.fetch 1684×1 + crawl4ai.render 74×1 + deepseek.search 660×1 = 2_418 cents。
    expect(envelope.requiredCapMicrousd).toBe(708_838n * 10_000n);
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
    expect(envelope.requiredCapMicrousd).toBe(587n * 10_000n);
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
    // 8×2×15 (model reservation) + 14×1 (crawl4ai.fetch) + 8×1 (crawl4ai.render) + 12×1 (social.fetch) = 274 cents.
    expect(envelope.requiredCapMicrousd).toBe(274n * 10_000n);
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
      // 66 查询 × 9 适配器 × 1000 条记录安全界
      expect.objectContaining({ taskId: 'discovery.qualify_fit', logicalInvocations: 594_000 }),
      // 快扫池 5 万 / 8 家每批 = 6250 次批量粗判上限
      expect.objectContaining({ taskId: 'discovery.quick_judge', logicalInvocations: 6_250 }),
    ]);
    expect(
      envelope.policy.tools.map((item) => [item.toolId, item.maxPhysicalInvocations]),
    ).toEqual([
      ['searxng.search', 66 * (3 + 4) + 66 * 100],
      ['deepseek.search', 66 * 100],
      ['crawl4ai.fetch', 66 * 8 * 3 + 50 * 2],
      ['wikidata.sparql', 66],
      ['osm.overpass', 66],
      ['ted.search', 66],
      ['openfda.search', 66],
      ['tradefair.algolia', 66],
      ['gleif.fetch', 50 * 4],
      ['wikidata.entity', 50 * 3],
      ['crawl4ai.render', 12 * 2 + 50 * 1],
      ['http.get', 12 * 15 + 12 * 8],
    ]);
    expect(envelope.policy.executionLimits).toMatchObject({
      planQueries: 66,
      providerRecords: 1_000,
      fitCompanies: 594_000,
      // policyRevision 可审计标记：去帽模式的包络与产品帽模式可区分。
      discoveryUncapped: 1,
    });
    // models: 396×2×5 + 924×2×15 + 1584×2×20 + 1650×2×15 + 50×2×10 + 594000×2×20 + 6250×2×20
    //       = 24_155_540 cents；tools: crawl4ai.fetch 1684×1 + crawl4ai.render 74×1 +
    // deepseek.search 6600×1 = 8_358 cents；合计 24_163_898 cents。
    expect(envelope.requiredCapMicrousd).toBe(24_163_898n * 10_000n);
  });

  it('产品帽模式的报价逐字节不变（开关 off 时与既有断言一致）', () => {
    const envelope = resolveWorkspaceTechnicalBudgetEnvelope({
      operation: 'POST /query-plans/:planId/execute',
      planId: PLAN_ID,
    });
    expect(envelope.policy.executionLimits).not.toHaveProperty('discoveryUncapped');
    expect(envelope.requiredCapMicrousd).toBe(708_838n * 10_000n);
  });
});
