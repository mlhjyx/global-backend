import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataRightsService } from '../compliance/data-rights.service';
import { WEEKLY_REPORT_COLUMNS } from './weekly-report-row';
import { WEEKLY_REPORT_MAX_LEADS, WeeklyReportService } from './weekly-report.service';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ICP = '22222222-2222-4222-8222-222222222222';
const USER = 'user-7';
const ctx = { workspaceId: WORKSPACE, userId: USER, roles: ['TENANT_OWNER'], scopes: [] } as never;

const RUN_OLD = '33333333-3333-4333-8333-333333333331';
const RUN_NEW = '33333333-3333-4333-8333-333333333332';
const RUN_OTHER_ICP = '33333333-3333-4333-8333-333333333333';
const RUN_AFTER_ACCEPT = '33333333-3333-4333-8333-333333333334';
const ACCEPTED_AT = new Date('2026-10-13T10:00:00.000Z');
const COST_COLUMN = '本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）';

interface CompanyFixture {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  status: string;
  attributes: unknown;
}

interface Fixture {
  icp: { id: string } | null;
  leads: Array<Record<string, unknown>>;
  companies: CompanyFixture[];
  evidence: Array<Record<string, unknown>>;
  contactPoints: Array<Record<string, unknown>>;
  sanctions: Array<Record<string, unknown>>;
  suppressions: Array<{ type: string; value: string }>;
  outcomes: Array<{ canonicalCompanyId: string; runId: string }>;
  runs: Array<{ id: string; icpId: string; createdAt: Date }>;
  receipts: Array<{ runId: string; accountKey: string }>;
  accounts: Array<{ accountKey: string; chargedMicrousd: bigint; reservedMicrousd: bigint }>;
}

function leadRow(id: string, companyId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    canonicalCompanyId: companyId,
    fitVerdict: 'match',
    totalScore: 0.8,
    scores: { fit: 0.9, role: 0.8, intent: 0.2, dataQuality: 0.7, reachability: 1, engagement: 0 },
    // The lead's latest decision, as the report selects it.
    decisions: [{ action: 'accept', createdAt: ACCEPTED_AT }],
    ...overrides,
  };
}

function company(id: string, overrides: Partial<CompanyFixture> = {}): CompanyFixture {
  return {
    id,
    name: `Company ${id.slice(-2)} GmbH`,
    domain: `company-${id.slice(-2)}.example`,
    country: 'DE',
    status: 'ENRICHED',
    attributes: {
      website_profile: {
        trade_role: 'distributor',
        trade_role_confidence: 0.7,
        source_url: `https://company-${id.slice(-2)}.example/impressum`,
      },
    },
    ...overrides,
  };
}

function evidence(entityId: string, overrides: Record<string, unknown> = {}) {
  return {
    entityId,
    dataClass: 'green',
    providerKey: 'public_web',
    license: 'licensed',
    _min: { fetchedAt: new Date('2026-10-10T00:00:00.000Z') },
    ...overrides,
  };
}

function baseFixture(overrides: Partial<Fixture> = {}): Fixture {
  const companyId = '44444444-4444-4444-8444-444444444401';
  return {
    icp: { id: ICP },
    leads: [leadRow('55555555-5555-4555-8555-555555555501', companyId)],
    companies: [company(companyId)],
    evidence: [evidence(companyId)],
    contactPoints: [
      { companyId, kind: 'contact_page', value: 'https://company-01.example/kontakt', status: 'UNVERIFIED' },
    ],
    sanctions: [],
    suppressions: [],
    outcomes: [
      { canonicalCompanyId: companyId, runId: RUN_OLD },
      { canonicalCompanyId: companyId, runId: RUN_NEW },
      { canonicalCompanyId: companyId, runId: RUN_OTHER_ICP },
    ],
    runs: [
      { id: RUN_OLD, icpId: ICP, createdAt: new Date('2026-10-01T00:00:00.000Z') },
      { id: RUN_NEW, icpId: ICP, createdAt: new Date('2026-10-12T00:00:00.000Z') },
    ],
    receipts: [
      { runId: RUN_OLD, accountKey: 'discovery.run:old' },
      { runId: RUN_NEW, accountKey: 'discovery.run:new' },
    ],
    accounts: [
      { accountKey: 'discovery.run:old', chargedMicrousd: 100n, reservedMicrousd: 0n },
      { accountKey: 'discovery.run:new', chargedMicrousd: 2_840_000n, reservedMicrousd: 0n },
    ],
    ...overrides,
  };
}

function harness(fixture: Fixture, screen = vi.fn(() => ({ status: 'not_screened', matches: [], listVersions: {} }))) {
  let inTransaction = false;
  /** Whether each sanctions screen and each decision-log write ran inside a database transaction. */
  const transactionTrace: Array<{ call: 'screen' | 'log'; inTransaction: boolean }> = [];
  const tx = {
    icpDefinition: { findUnique: vi.fn(async () => fixture.icp) },
    lead: { findMany: vi.fn(async (_query: unknown) => fixture.leads) },
    canonicalCompany: { findMany: vi.fn(async () => fixture.companies) },
    fieldEvidence: { groupBy: vi.fn(async () => fixture.evidence) },
    companyContactPoint: { findMany: vi.fn(async () => fixture.contactPoints) },
    sanctionsScreeningResult: { findMany: vi.fn(async () => fixture.sanctions) },
    suppressionRecord: { findMany: vi.fn(async () => fixture.suppressions) },
    discoveryCompanyMaterializationOutcome: { findMany: vi.fn(async () => fixture.outcomes) },
    discoveryRun: {
      findMany: vi.fn(async (query: { where: { icpId: string } }) =>
        fixture.runs.filter((run) => run.icpId === query.where.icpId),
      ),
    },
    discoveryQueryReceipt: {
      findMany: vi.fn(async (query: { where: { runId: { in: string[] } } }) =>
        fixture.receipts.filter((receipt) => query.where.runId.in.includes(receipt.runId)),
      ),
    },
    toolBudgetAccount: { findMany: vi.fn(async (_query: unknown) => fixture.accounts) },
    policyDecisionLog: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        transactionTrace.push({ call: 'log', inTransaction });
        return { count: args.data.length };
      }),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(async <T>(workspaceId: string, work: (client: unknown) => Promise<T>) => {
      expect(workspaceId).toBe(WORKSPACE);
      inTransaction = true;
      try {
        return await work(tx);
      } finally {
        inTransaction = false;
      }
    }),
  };
  const dataRights = new DataRightsService(prisma as never);
  const sanctions = {
    screen: (name: string, country: string | null) => {
      transactionTrace.push({ call: 'screen', inTransaction });
      return (screen as (name: string, country: string | null) => unknown)(name, country);
    },
  };
  const service = new WeeklyReportService(prisma as never, dataRights, sanctions as never);
  return { service, tx, prisma, screen, transactionTrace };
}

function records(csv: string): Array<Record<string, string>> {
  const rows = parse(csv, { bom: true, relax_column_count: false }) as string[][];
  expect(rows[0]).toEqual([...WEEKLY_REPORT_COLUMNS]);
  return rows.slice(1).map((row) => Object.fromEntries(WEEKLY_REPORT_COLUMNS.map((column, index) => [column, row[index]!])));
}

function loggedDecisions(tx: ReturnType<typeof harness>['tx']) {
  return tx.policyDecisionLog.createMany.mock.calls.flatMap((call) => call[0].data) as Array<Record<string, unknown>>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WeeklyReportService (BI-22)', () => {
  it('rejects a missing or malformed icpId and week before touching the database', async () => {
    const { service, prisma } = harness(baseFixture());
    for (const request of [
      {},
      { icpId: 'not-a-uuid' },
      { icpId: ICP, week: '2026-42' },
      { icpId: ICP, week: '2025-W53' },
      { icpId: [ICP, ICP] as never },
    ]) {
      const error = await service.weekly(ctx, request).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(request)).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('returns 404 for an ICP the workspace cannot see', async () => {
    const { service, tx } = harness(baseFixture({ icp: null }));
    const error = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(tx.lead.findMany).not.toHaveBeenCalled();
  });

  it('selects the ICP leads accepted in the ISO week that are still delivered', async () => {
    const { service, tx } = harness(baseFixture());
    await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    const query = tx.lead.findMany.mock.calls[0]![0] as Record<string, unknown>;
    const range = { gte: new Date('2026-10-12T00:00:00.000Z'), lt: new Date('2026-10-19T00:00:00.000Z') };
    expect(query).toMatchObject({
      where: {
        icpId: ICP,
        status: { in: ['QUALIFIED', 'CONTACTED', 'CONVERTED'] },
        // An accept in the week and no decision after the week: the latest decision is in the week.
        decisions: { some: { action: 'accept', createdAt: range }, none: { createdAt: { gte: range.lt } } },
      },
      select: {
        decisions: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: { action: true, createdAt: true } },
      },
      take: WEEKLY_REPORT_MAX_LEADS + 1,
    });
  });

  it('lists a lead only in the week of its latest decision, and only when that decision is an accept', async () => {
    const reacceptedLater = '44444444-4444-4444-8444-444444444411';
    const rejectedLast = '44444444-4444-4444-8444-444444444412';
    const kept = '44444444-4444-4444-8444-444444444413';
    const ids = [reacceptedLater, rejectedLast, kept];
    const leadIds = ids.map((id) => `55555555-5555-4555-8555-5555555555${id.slice(-2)}`);
    const { service, tx } = harness(
      baseFixture({
        leads: [
          // Accepted in W42, rejected, accepted again in W43: it belongs to W43's report only.
          leadRow(leadIds[0]!, reacceptedLater, {
            decisions: [{ action: 'accept', createdAt: new Date('2026-10-20T08:00:00.000Z') }],
          }),
          leadRow(leadIds[1]!, rejectedLast, {
            decisions: [{ action: 'reject', createdAt: new Date('2026-10-13T11:00:00.000Z') }],
          }),
          leadRow(leadIds[2]!, kept),
        ],
        companies: ids.map((id) => company(id)),
        evidence: ids.map((id) => evidence(id)),
        outcomes: [],
      }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });

    expect(records(report.csv).map((row) => row['线索 ID'])).toEqual([leadIds[2]]);
    expect(report).toMatchObject({ rows: 1, withheld: { rights: 0, sanctions: 0, quarantined: 0 } });
    expect(loggedDecisions(tx).map((entry) => entry.subjectId)).toEqual([leadIds[2]]);
    expect(tx.canonicalCompany.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [kept] } } }));
  });

  it('defaults to the current UTC ISO week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-18T23:30:00.000Z'));
    const { service, tx } = harness(baseFixture());
    const report = await service.weekly(ctx, { icpId: ICP });
    expect(report.week).toBe('2026-W42');
    const query = tx.lead.findMany.mock.calls[0]![0] as { where: { decisions: { some: { createdAt: unknown } } } };
    expect(query.where.decisions.some.createdAt).toEqual({
      gte: new Date('2026-10-12T00:00:00.000Z'),
      lt: new Date('2026-10-19T00:00:00.000Z'),
    });
  });

  it('exports an allowed lead and logs its EXPORT decision under the report id', async () => {
    const { service, tx } = harness(baseFixture());
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });

    expect(report).toMatchObject({ week: '2026-W42', icpId: ICP, rows: 1, withheld: { rights: 0, sanctions: 0, quarantined: 0 } });
    expect(report.reportId).toMatch(/^[0-9a-f-]{36}$/u);
    const [row] = records(report.csv);
    expect(row).toMatchObject({
      公司名: 'Company 01 GmbH',
      域名: 'company-01.example',
      贸易角色: '分销商',
      '线索 ID': '55555555-5555-4555-8555-555555555501',
      // Latest run of this ICP that materialized the company; the other ICP's run is ignored.
      '所属发现 run ID': RUN_NEW,
      '本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）': '2.840000',
      制裁状态: '未筛查（筛查未启用）',
      // green evidence fetched 2026-10-10 + 180 days.
      有效期至: '2027-04-08',
      联系路径: '联系页：https://company-01.example/kontakt',
    });
    expect(loggedDecisions(tx)).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        action: 'EXPORT',
        dataClass: 'green',
        subjectJurisdiction: 'EU',
        effect: 'ALLOW',
        allowed: true,
        reason: 'green_company_fact',
        subjectType: 'lead',
        subjectId: '55555555-5555-4555-8555-555555555501',
        actorId: USER,
        correlationId: report.reportId,
      }),
    ]);
    expect(tx.toolBudgetAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scopeKey: WORKSPACE, accountKey: { in: ['discovery.run:new'] } } }),
    );
  });

  it('withholds and logs a lead whose company is suppressed, matches a suppression record or has no evidence', async () => {
    const suppressed = '44444444-4444-4444-8444-444444444402';
    const domainListed = '44444444-4444-4444-8444-444444444403';
    const noEvidence = '44444444-4444-4444-8444-444444444404';
    const fine = '44444444-4444-4444-8444-444444444405';
    const fixture = baseFixture({
      leads: [
        leadRow('55555555-5555-4555-8555-555555555502', suppressed),
        leadRow('55555555-5555-4555-8555-555555555503', domainListed),
        leadRow('55555555-5555-4555-8555-555555555504', noEvidence),
        leadRow('55555555-5555-4555-8555-555555555505', fine),
      ],
      companies: [
        company(suppressed, { status: 'SUPPRESSED' }),
        company(domainListed, { domain: 'www.company-03.example' }),
        company(noEvidence),
        company(fine),
      ],
      evidence: [evidence(suppressed), evidence(domainListed), evidence(fine)],
      suppressions: [{ type: 'domain', value: 'Company-03.example' }],
      outcomes: [],
    });
    const { service, tx } = harness(fixture);
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });

    expect(records(report.csv).map((row) => row['线索 ID'])).toEqual(['55555555-5555-4555-8555-555555555505']);
    expect(report).toMatchObject({ rows: 1, withheld: { rights: 3, sanctions: 0, quarantined: 0 } });
    expect(
      loggedDecisions(tx).map((entry) => [entry.subjectId, entry.effect, entry.allowed, entry.reason, entry.correlationId]),
    ).toEqual([
      ['55555555-5555-4555-8555-555555555502', 'DENY', false, 'suppressed', report.reportId],
      ['55555555-5555-4555-8555-555555555503', 'DENY', false, 'suppressed', report.reportId],
      ['55555555-5555-4555-8555-555555555504', 'DENY', false, 'no_evidence', report.reportId],
      ['55555555-5555-4555-8555-555555555505', 'ALLOW', true, 'green_company_fact', report.reportId],
    ]);
    // No ledger lookup without a materialization outcome: the cost cell stays empty.
    expect(records(report.csv)[0]!['本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）']).toBe('');
    expect(tx.toolBudgetAccount.findMany).not.toHaveBeenCalled();
  });

  it('never exports a company with synthetic provenance and logs the withheld row as an EXPORT denial', async () => {
    const companyId = '44444444-4444-4444-8444-444444444401';
    const { service, tx, transactionTrace } = harness(
      baseFixture({ evidence: [evidence(companyId), evidence(companyId, { providerKey: 'Sandbox', license: 'sandbox' })] }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)).toEqual([]);
    expect(report).toMatchObject({ rows: 0, withheld: { rights: 0, sanctions: 0, quarantined: 1 } });
    expect(loggedDecisions(tx)).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        action: 'EXPORT',
        dataClass: 'green',
        subjectJurisdiction: 'EU',
        effect: 'DENY',
        allowed: false,
        reason: 'synthetic_quarantined',
        ruleId: null,
        subjectType: 'lead',
        subjectId: '55555555-5555-4555-8555-555555555501',
        actorId: USER,
        correlationId: report.reportId,
      }),
    ]);
    // Quarantined before screening: a synthetic company is never looked up in the sanctions lists.
    expect(transactionTrace.filter((entry) => entry.call === 'screen')).toEqual([]);
  });

  it('withholds an unresolved sanctions hit, persisted or live, and labels a cleared false positive', async () => {
    const persistedHit = '44444444-4444-4444-8444-444444444406';
    const confirmed = '44444444-4444-4444-8444-444444444407';
    const cleared = '44444444-4444-4444-8444-444444444408';
    const clearedButNewLiveHit = '44444444-4444-4444-8444-444444444409';
    const clean = '44444444-4444-4444-8444-444444444410';
    const ids = [persistedHit, confirmed, cleared, clearedButNewLiveHit, clean];
    const leadIds = ids.map((id) => `55555555-5555-4555-8555-5555555555${id.slice(-2)}`);
    const clearedMatch = [{ sourceKey: 'ofac_sdn', externalId: '100' }];
    const fixture = baseFixture({
      leads: ids.map((id, index) => leadRow(leadIds[index]!, id)),
      companies: ids.map((id) => company(id)),
      evidence: ids.map((id) => evidence(id)),
      sanctions: [
        { canonicalCompanyId: persistedHit, status: 'potential_match', reviewState: 'open', matches: [] },
        { canonicalCompanyId: confirmed, status: 'potential_match', reviewState: 'confirmed_true_hit', matches: [] },
        { canonicalCompanyId: cleared, status: 'potential_match', reviewState: 'cleared_false_positive', matches: clearedMatch },
        {
          canonicalCompanyId: clearedButNewLiveHit,
          status: 'potential_match',
          reviewState: 'cleared_false_positive',
          matches: clearedMatch,
        },
        { canonicalCompanyId: clean, status: 'clear', reviewState: 'open', matches: [] },
      ],
      outcomes: [],
    });
    const screen = vi.fn((name: string) => {
      if (name === `Company 08 GmbH`) return { status: 'potential_match', matches: clearedMatch, listVersions: {} };
      if (name === `Company 09 GmbH`) {
        return { status: 'potential_match', matches: [...clearedMatch, { sourceKey: 'eu_fsf', externalId: '9' }], listVersions: {} };
      }
      return { status: 'clear', matches: [], listVersions: {} };
    });
    const { service, tx } = harness(fixture, screen as never);
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });

    expect(records(report.csv).map((row) => [row['线索 ID'], row['制裁状态']])).toEqual([
      [leadIds[2], '已筛查，命中经人工复核为误报'],
      [leadIds[4], '已筛查，无命中'],
    ]);
    expect(report).toMatchObject({ rows: 2, withheld: { rights: 0, sanctions: 3, quarantined: 0 } });
    // Every withheld hit leaves an EXPORT denial under the same report id, next to the two allowed rows.
    expect(
      loggedDecisions(tx).map((entry) => [entry.subjectId, entry.effect, entry.allowed, entry.reason, entry.correlationId]),
    ).toEqual([
      [leadIds[0], 'DENY', false, 'sanctions_hold', report.reportId],
      [leadIds[1], 'DENY', false, 'sanctions_hold', report.reportId],
      [leadIds[2], 'ALLOW', true, 'green_company_fact', report.reportId],
      [leadIds[3], 'DENY', false, 'sanctions_hold', report.reportId],
      [leadIds[4], 'ALLOW', true, 'green_company_fact', report.reportId],
    ]);
  });

  it('screens sanctions outside any database transaction, once per name and country, and logs inside one', async () => {
    const ids = [
      '44444444-4444-4444-8444-444444444414',
      '44444444-4444-4444-8444-444444444415',
      '44444444-4444-4444-8444-444444444416',
    ];
    const screen = vi.fn((_name: string, _country: string | null) => ({ status: 'clear', matches: [], listVersions: {} }));
    const { service, transactionTrace } = harness(
      baseFixture({
        leads: ids.map((id) => leadRow(`55555555-5555-4555-8555-5555555555${id.slice(-2)}`, id)),
        // Two companies share a name and country (two sites of one firm); the third is in another country.
        companies: [
          company(ids[0]!, { name: 'Pumpen Nord GmbH' }),
          company(ids[1]!, { name: 'Pumpen Nord GmbH' }),
          company(ids[2]!, { name: 'Pumpen Nord GmbH', country: 'AT' }),
        ],
        evidence: ids.map((id) => evidence(id)),
        outcomes: [],
      }),
      screen as never,
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });

    expect(report.rows).toBe(3);
    expect(screen.mock.calls).toEqual([
      ['Pumpen Nord GmbH', 'DE'],
      ['Pumpen Nord GmbH', 'AT'],
    ]);
    expect(transactionTrace).toEqual([
      { call: 'screen', inTransaction: false },
      { call: 'screen', inTransaction: false },
      { call: 'log', inTransaction: true },
    ]);
  });

  it('neutralizes spreadsheet formulas in company data', async () => {
    const companyId = '44444444-4444-4444-8444-444444444401';
    const { service } = harness(
      baseFixture({ companies: [company(companyId, { name: '=HYPERLINK("https://evil.example","Pumpen")' })] }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)[0]!['公司名']).toBe(`'=HYPERLINK("https://evil.example","Pumpen")`);
  });

  it('attributes the cost to the latest run created before the accept, never to a later run', async () => {
    const companyId = '44444444-4444-4444-8444-444444444401';
    const { service, tx } = harness(
      baseFixture({
        outcomes: [
          { canonicalCompanyId: companyId, runId: RUN_OLD },
          { canonicalCompanyId: companyId, runId: RUN_NEW },
          { canonicalCompanyId: companyId, runId: RUN_AFTER_ACCEPT },
        ],
        runs: [
          { id: RUN_OLD, icpId: ICP, createdAt: new Date('2026-10-01T00:00:00.000Z') },
          { id: RUN_NEW, icpId: ICP, createdAt: new Date('2026-10-12T00:00:00.000Z') },
          // Found the company again a day after it was accepted: neither its run nor its cost.
          { id: RUN_AFTER_ACCEPT, icpId: ICP, createdAt: new Date('2026-10-14T00:00:00.000Z') },
        ],
        receipts: [
          { runId: RUN_OLD, accountKey: 'discovery.run:old' },
          { runId: RUN_NEW, accountKey: 'discovery.run:new' },
          { runId: RUN_AFTER_ACCEPT, accountKey: 'discovery.run:after' },
        ],
        accounts: [
          { accountKey: 'discovery.run:old', chargedMicrousd: 100n, reservedMicrousd: 0n },
          { accountKey: 'discovery.run:new', chargedMicrousd: 2_840_000n, reservedMicrousd: 0n },
          { accountKey: 'discovery.run:after', chargedMicrousd: 9_000_000n, reservedMicrousd: 0n },
        ],
      }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)[0]).toMatchObject({ '所属发现 run ID': RUN_NEW, [COST_COLUMN]: '2.840000' });
    expect(tx.discoveryQueryReceipt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { runId: { in: [RUN_NEW] } } }),
    );
  });

  it('leaves run and cost empty when every run that found the company started after the accept', async () => {
    const { service, tx } = harness(
      baseFixture({
        outcomes: [{ canonicalCompanyId: '44444444-4444-4444-8444-444444444401', runId: RUN_AFTER_ACCEPT }],
        runs: [{ id: RUN_AFTER_ACCEPT, icpId: ICP, createdAt: new Date('2026-10-13T10:00:00.001Z') }],
        receipts: [{ runId: RUN_AFTER_ACCEPT, accountKey: 'discovery.run:after' }],
        accounts: [{ accountKey: 'discovery.run:after', chargedMicrousd: 9_000_000n, reservedMicrousd: 0n }],
      }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)[0]).toMatchObject({ '所属发现 run ID': '', [COST_COLUMN]: '' });
    expect(tx.discoveryQueryReceipt.findMany).not.toHaveBeenCalled();
  });

  it('leaves the cost empty while any account of the run still holds a reservation', async () => {
    const { service, tx } = harness(
      baseFixture({
        receipts: [
          { runId: RUN_NEW, accountKey: 'discovery.run:new' },
          { runId: RUN_NEW, accountKey: 'discovery.run:new-second' },
        ],
        accounts: [
          { accountKey: 'discovery.run:new', chargedMicrousd: 2_840_000n, reservedMicrousd: 0n },
          // A RESULT_UNKNOWN or still RESERVED operation: what it spent is not known yet.
          { accountKey: 'discovery.run:new-second', chargedMicrousd: 10_000n, reservedMicrousd: 50_000n },
        ],
      }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)[0]).toMatchObject({ '所属发现 run ID': RUN_NEW, [COST_COLUMN]: '' });
    expect(tx.toolBudgetAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { accountKey: true, chargedMicrousd: true, reservedMicrousd: true } }),
    );
  });

  it('leaves the cost empty when any ledger account of the run is missing', async () => {
    const { service } = harness(
      baseFixture({
        receipts: [
          { runId: RUN_NEW, accountKey: 'discovery.run:new' },
          { runId: RUN_NEW, accountKey: 'discovery.run:missing' },
        ],
      }),
    );
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)[0]).toMatchObject({
      '所属发现 run ID': RUN_NEW,
      '本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）': '',
    });
  });

  it('returns only the header and logs nothing for a week without accepted leads', async () => {
    const { service, tx } = harness(baseFixture({ leads: [] }));
    const report = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' });
    expect(records(report.csv)).toEqual([]);
    expect(report).toMatchObject({ rows: 0, withheld: { rights: 0, sanctions: 0, quarantined: 0 } });
    expect(tx.canonicalCompany.findMany).not.toHaveBeenCalled();
    expect(tx.policyDecisionLog.createMany).not.toHaveBeenCalled();
  });

  it('refuses a week larger than the row limit instead of truncating it', async () => {
    const leads = Array.from({ length: WEEKLY_REPORT_MAX_LEADS + 1 }, (_, index) =>
      leadRow(`lead-${index}`, '44444444-4444-4444-8444-444444444401'),
    );
    const { service, tx } = harness(baseFixture({ leads }));
    const error = await service.weekly(ctx, { icpId: ICP, week: '2026-W42' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      error: { code: 'WEEKLY_REPORT_TOO_LARGE' },
    });
    expect(tx.policyDecisionLog.createMany).not.toHaveBeenCalled();
  });
});
