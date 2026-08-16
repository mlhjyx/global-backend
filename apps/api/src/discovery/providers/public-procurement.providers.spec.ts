import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import type { CompanyDiscoveryQuery, ExecutionContext } from '../provider-contract';
import type { ProcurementPage } from '../../adapters/public-procurement';
import {
  BrazilPncpDiscoveryProvider,
  PROCUREMENT_TOOL_IDS,
  SingaporeGebizDiscoveryProvider,
  UkContractsFinderDiscoveryProvider,
  UkFindATenderDiscoveryProvider,
  UsaSpendingAwardsDiscoveryProvider,
  WorldBankProcurementDiscoveryProvider,
} from './public-procurement.providers';

const CTX: ExecutionContext = { workspaceId: 'ws-1', runId: 'run-1' };
const PROVENANCE = {
  sourceUrl: 'https://official.example/api?q=pump',
  fetchedAt: '2026-08-13T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'wire/v1',
};

function query(
  provider: string,
  country: string,
  keywords = ['pump'],
  procurementRole: 'buyer' | 'supplier' = provider === 'singapore_gebiz' ? 'supplier' : 'buyer',
): CompanyDiscoveryQuery {
  return {
    sourceClass: 'public_intelligence',
    filters: { source_hint: provider, country, procurement_role: procurementRole },
    keywords,
    limit: 25,
  };
}

function brokerWith<T>(page: ProcurementPage<T>): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(async (_toolId: string, _input: unknown, _ctx: ToolContext): Promise<ToolResult<unknown>> => ({
    data: page,
    costCents: 0,
    provenance: page.provenance,
  }));
  return {
    invokeMock,
    checkSourcePolicy: async () => ({ allowed: true }),
    invoke: invokeMock as ExecutionBroker['invoke'],
  };
}

describe('public procurement provider admission gates', () => {
  const constructors = [
    WorldBankProcurementDiscoveryProvider,
    UsaSpendingAwardsDiscoveryProvider,
    UkFindATenderDiscoveryProvider,
    BrazilPncpDiscoveryProvider,
    SingaporeGebizDiscoveryProvider,
    UkContractsFinderDiscoveryProvider,
  ];

  for (const Provider of constructors) {
    it(`${Provider.name}: no broker, provider hint, country or keyword stays a no-op`, async () => {
      const page = { records: [], provenance: PROVENANCE };
      const broker = brokerWith(page);
      const provider = new Provider({ broker });
      await expect(provider.discoverCompanies({ sourceClass: 'public_intelligence', filters: {}, keywords: ['pump'], limit: 5 }, CTX)).resolves.toEqual({ records: [], costCents: 0 });
      await expect(provider.discoverCompanies({ sourceClass: 'public_intelligence', filters: { source_hint: provider.key }, keywords: ['pump'], limit: 5 }, CTX)).resolves.toEqual({ records: [], costCents: 0 });
      const validCountry = Provider === WorldBankProcurementDiscoveryProvider ? 'Kenya' : Provider === UsaSpendingAwardsDiscoveryProvider ? 'US' : 'wrong-country';
      await expect(provider.discoverCompanies({ sourceClass: 'public_intelligence', filters: { source_hint: provider.key, country: validCountry }, keywords: [], limit: 5 }, CTX)).resolves.toEqual({ records: [], costCents: 0 });
      expect(broker.invokeMock).not.toHaveBeenCalled();
      await expect(new Provider().discoverCompanies(query(provider.key, Provider === WorldBankProcurementDiscoveryProvider ? 'Kenya' : Provider === UsaSpendingAwardsDiscoveryProvider ? 'US' : 'GB'), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    });
  }

  it('propagates a governed source failure so the run quality ledger can count it', async () => {
    const broker: ExecutionBroker = {
      checkSourcePolicy: async () => ({ allowed: true }),
      invoke: vi.fn(async () => {
        throw new Error('SOURCE_SCHEMA_CHANGED');
      }) as ExecutionBroker['invoke'],
    };
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'Kenya'), CTX)).rejects.toThrow(
      'SOURCE_SCHEMA_CHANGED',
    );
  });

  it('fails closed on an unsupported procurement role instead of silently defaulting to buyer', async () => {
    const broker = brokerWith({ records: [], provenance: PROVENANCE });
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });
    const invalidRoleQuery = query(provider.key, 'Kenya');
    invalidRoleQuery.filters.procurement_role = 'reseller';

    await expect(provider.discoverCompanies(invalidRoleQuery, CTX)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });
});

describe('World Bank provider mapping', () => {
  it('passes explicit scope through Broker and preserves wire provenance exactly', async () => {
    const broker = brokerWith({
      records: [{
        id: 'OP-1',
        organizationName: 'Water Project Unit',
        organizationRole: 'procurement_buyer_or_implementing_agency',
        signalStage: 'published_notice',
        country: 'Kenya',
        projectCountry: 'Kenya',
        projectId: 'P100',
        projectName: 'Water Programme',
        title: 'Industrial pump package',
      }],
      provenance: PROVENANCE,
    });
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'Kenya'), CTX);
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.worldBank,
      expect.objectContaining({ keywords: ['pump'], country: 'Kenya', offset: 0, limit: 25 }),
      expect.objectContaining({ workspaceId: 'ws-1', runId: 'run-1', purpose: 'discovery' }),
    );
    expect(result.records[0]).toMatchObject({
      externalId: 'worldbank:OP-1',
      name: 'Water Project Unit',
      country: 'Kenya',
      license: 'CC BY 4.0',
      attributes: {
        source_role: 'procurement_buyer_or_implementing_agency',
        signal_stage: 'published_notice',
        procurement: { project_country: 'Kenya' },
      },
      provenance: PROVENANCE,
    });
    expect(result.records[0].identifier).toBeUndefined();
    expect(result.records[0].identifiers).toBeUndefined();
    expect(result.records[0].domain).toBeUndefined();
  });

  it('reads a full wire page to absorb filtered notices but emits no more than the confirmed query limit', async () => {
    const broker = brokerWith({
      records: Array.from({ length: 30 }, (_, index) => ({
        id: `OP-${index + 1}`,
        organizationName: `Water Buyer ${index + 1}`,
        organizationRole: 'procurement_buyer_or_implementing_agency' as const,
        signalStage: 'published_notice' as const,
        country: 'Kenya',
        title: 'Industrial pump package',
      })),
      nextCursor: '25',
      provenance: PROVENANCE,
    });
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });
    const scoped = query(provider.key, 'Kenya');
    scoped.limit = 25;

    const result = await provider.discoverCompanies(scoped, CTX);

    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.worldBank,
      expect.objectContaining({ offset: 0, limit: 25 }),
      expect.any(Object),
    );
    expect(result.records).toHaveLength(25);
    expect(result.nextCursor).toBe('25');
  });

  it('post-filters World Bank notices to the explicitly requested country instead of trusting qterm', async () => {
    const broker = brokerWith({
      records: [
        {
          id: 'OP-KE',
          organizationName: 'Kenya Water Board',
          organizationRole: 'procurement_buyer_or_implementing_agency',
          signalStage: 'published_notice',
          country: '  KENYA  ',
          title: 'Industrial pump package',
        },
        {
          id: 'OP-UG',
          organizationName: 'Uganda Water Board',
          organizationRole: 'procurement_buyer_or_implementing_agency',
          signalStage: 'published_notice',
          country: 'Uganda',
          title: 'Industrial pump package',
        },
        {
          id: 'OP-UNKNOWN',
          organizationName: 'Unknown-country Board',
          organizationRole: 'procurement_buyer_or_implementing_agency',
          signalStage: 'published_notice',
          projectCountry: 'Kenya',
          title: 'Industrial pump package',
        },
        {
          id: 'OP-PROJECT-COUNTRY-ONLY',
          organizationName: 'Foreign Implementation Agency',
          organizationRole: 'procurement_buyer_or_implementing_agency',
          signalStage: 'published_notice',
          country: 'Uganda',
          projectCountry: 'Kenya',
          title: 'Industrial pump package',
        },
      ],
      provenance: PROVENANCE,
    });

    const result = await new WorldBankProcurementDiscoveryProvider({ broker })
      .discoverCompanies(query('world_bank_procurement', 'Ｋｅｎｙａ'), CTX);

    expect(result.records.map((record) => record.name)).toEqual(['Kenya Water Board']);
  });

  it('post-filters World Bank full-text recall to business evidence using query tokens', async () => {
    const broker = brokerWith({
      records: [
        {
          id: 'OP-PUMP', organizationName: 'Nairobi Utility',
          organizationRole: 'procurement_buyer_or_implementing_agency', signalStage: 'published_notice',
          country: 'Kenya', title: 'Supply of industrial pumps', projectName: 'Urban Services',
        },
        {
          id: 'OP-WATER', organizationName: 'Regional Water Board',
          organizationRole: 'procurement_buyer_or_implementing_agency', signalStage: 'published_notice',
          country: 'Kenya', title: 'Civil works', projectName: 'Road Programme',
        },
        {
          id: 'OP-NO-MATCH', organizationName: 'Roads Authority',
          organizationRole: 'procurement_buyer_or_implementing_agency', signalStage: 'published_notice',
          country: 'Kenya', title: 'Bridge construction', projectName: 'Transport Programme',
        },
      ],
      provenance: PROVENANCE,
    });
    const scoped = query('world_bank_procurement', 'Kenya');
    scoped.keywords = ['water pump'];

    const result = await new WorldBankProcurementDiscoveryProvider({ broker }).discoverCompanies(scoped, CTX);

    expect(result.records.map((record) => record.externalId)).toEqual(['worldbank:OP-PUMP', 'worldbank:OP-WATER']);
  });

  it('does not admit an unrelated notice through stop words in a multi-word business query', async () => {
    const broker = brokerWith({
      records: [{
        id: 'OP-STOP-WORD',
        organizationName: 'Roads Authority',
        organizationRole: 'procurement_buyer_or_implementing_agency',
        signalStage: 'published_notice',
        country: 'Kenya',
        title: 'Construction of bridge',
        projectName: 'Transport Programme',
      }],
      provenance: PROVENANCE,
    });
    const scoped = query('world_bank_procurement', 'Kenya');
    scoped.keywords = ['supply of water pumps'];

    const result = await new WorldBankProcurementDiscoveryProvider({ broker }).discoverCompanies(scoped, CTX);

    expect(result.records).toEqual([]);
  });

  it('keeps project metadata as evidence and never promotes it into identity fields', async () => {
    const broker = brokerWith({
      records: [{
        id: 'OP-WEAK-IDENTITY',
        organizationName: 'Water Services Board',
        organizationRole: 'procurement_buyer_or_implementing_agency',
        signalStage: 'published_notice',
        country: 'Kenya',
        projectCountry: 'Rwanda',
        projectId: 'P100',
        projectName: 'Clean Water Programme',
        title: 'Industrial pump package',
      }],
      provenance: PROVENANCE,
    });
    const result = await new WorldBankProcurementDiscoveryProvider({ broker })
      .discoverCompanies(query('world_bank_procurement', 'Kenya'), CTX);

    expect(result.records[0]).toMatchObject({
      name: 'Water Services Board',
      country: 'Kenya',
      attributes: {
        source_role: 'procurement_buyer_or_implementing_agency',
        procurement: {
          project_id: 'P100',
          project_name: 'Clean Water Programme',
          project_country: 'Rwanda',
        },
      },
    });
    expect(result.records[0]).not.toHaveProperty('domain');
    expect(result.records[0]).not.toHaveProperty('identifier');
    expect(result.records[0]).not.toHaveProperty('identifiers');
  });

  it('accepts continuation only from internal options and ignores query-plan offset injection', async () => {
    const broker = brokerWith({ records: [], provenance: PROVENANCE });
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });
    const injected = query(provider.key, 'Kenya');
    injected.filters.offset = 9999;
    injected.filters._offset = 8888;

    await provider.discoverCompanies(injected, CTX, { cursor: '25' });

    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.worldBank,
      expect.objectContaining({ offset: 25 }),
      expect.any(Object),
    );
  });

  it('rejects a malformed internal continuation before Broker invocation', async () => {
    const broker = brokerWith({ records: [], provenance: PROVENANCE });
    const provider = new WorldBankProcurementDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'Kenya'), CTX, { cursor: '../next' }))
      .rejects.toThrow(/cursor is invalid/u);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });
});

describe('USAspending provider mapping', () => {
  it('maps the awarding sub-agency as a historical buyer and keeps the top-level agency as context', async () => {
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const broker = brokerWith({
      records: [
        {
          awardId: 'A-1', awardingAgency: 'Department of Energy', awardingSubAgency: 'Federal Energy Office', recipientName: 'Acme Industrial Systems Inc.',
          amount: 450000,
          description: 'Industrial pump equipment. Contact Jane Doe at private@example.test or +1 202-555-0100.',
          startDate: '2026-01-01', endDate: '2027-01-01',
        },
        {
          awardId: 'A-EXTRA', awardingAgency: 'Department of the Interior', awardingSubAgency: 'Bureau of Reclamation',
          recipientName: 'Other Supplier Inc.', description: 'Industrial pump equipment',
        },
      ],
      provenance: PROVENANCE,
    });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker });
    const scoped = query(provider.key, 'US');
    scoped.limit = 1;
    const result = await provider.discoverCompanies(scoped, CTX);

    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.usaSpending,
      expect.objectContaining({
        keywords: ['pump'], startDate: '2024-08-13', endDate: '2026-08-13', page: 1, limit: 100,
      }),
      expect.objectContaining({ workspaceId: 'ws-1', purpose: 'discovery' }),
    );
    expect(result.records[0]).toMatchObject({
      externalId: 'usaspending:A-1:buyer',
      name: 'Department of Energy / Federal Energy Office',
      country: 'US',
      license: 'USAspending public award data',
      attributes: {
        source_role: 'buyer', signal_stage: 'historical_award_buyer',
        procurement: {
          awarding_agency: 'Department of Energy',
          awarding_sub_agency: 'Federal Energy Office',
          award_id: 'A-1',
          source_page: 1,
          query_start_date: '2024-08-13',
          query_end_date: '2026-08-13',
          query_keywords: ['pump'],
          query_match: true,
          match_basis: ['description'],
          query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
      provenance: PROVENANCE,
    });
    expect(result.records[0].identifier).toBeUndefined();
    expect(result.records[0].identifiers).toBeUndefined();
    expect(result.records[0].domain).toBeUndefined();
    expect(result.records[0].attributes?.procurement).not.toHaveProperty('recipient_name');
    expect(result.records[0].attributes?.procurement).not.toHaveProperty('description');
    expect(JSON.stringify(result.records[0])).not.toMatch(/Acme Industrial Systems|Jane Doe|private@example|202-555-0100/u);
    expect(result.records).toHaveLength(1);
  });

  it('persists only bounded enum match bases when agency facts justify the query', async () => {
    const broker = brokerWith({
      records: [{
        awardId: 'A-AGENCY',
        awardingAgency: 'Department of Pump Infrastructure',
        awardingSubAgency: 'Pump Construction Office',
        recipientName: 'Jane Doe',
        description: 'Contact jane@example.test or +1 202-555-0199',
      }],
      provenance: PROVENANCE,
    });

    const result = await new UsaSpendingAwardsDiscoveryProvider({ broker })
      .discoverCompanies(query('usaspending_awards', 'US'), CTX);

    expect(result.records[0].attributes?.procurement).toEqual(expect.objectContaining({
      query_match: true,
      match_basis: ['awarding_agency', 'awarding_sub_agency'],
    }));
    expect(JSON.stringify(result.records[0])).not.toMatch(/Jane Doe|jane@example|202-555-0199/u);
  });

  it('keeps same-named sub-agencies under different parents as distinct auditable buyer names', async () => {
    const broker = brokerWith({
      records: [
        {
          awardId: 'A-ENERGY', awardingAgency: 'Department of Energy', awardingSubAgency: 'Office of the Secretary',
          recipientName: 'Acme Inc.', description: 'industrial pump maintenance',
        },
        {
          awardId: 'A-INTERIOR', awardingAgency: 'Department of the Interior', awardingSubAgency: 'Office of the Secretary',
          recipientName: 'Other Supplier LLC', description: 'industrial pump maintenance',
        },
      ],
      provenance: PROVENANCE,
    });

    const result = await new UsaSpendingAwardsDiscoveryProvider({ broker })
      .discoverCompanies(query('usaspending_awards', 'US'), CTX);

    expect(result.records.map((record) => record.name)).toEqual([
      'Department of Energy / Office of the Secretary',
      'Department of the Interior / Office of the Secretary',
    ]);
    expect(new Set(result.records.map((record) => record.name)).size).toBe(2);
  });

  it('does not admit a buyer when only the recipient name matches the requested product', async () => {
    const broker = brokerWith({
      records: [{
        awardId: 'A-RECIPIENT-ONLY',
        awardingAgency: 'Department of Administrative Services',
        awardingSubAgency: 'Office of General Operations',
        recipientName: 'Industrial Pump Specialists LLC',
        description: 'Management consulting services',
      }],
      provenance: PROVENANCE,
    });

    const result = await new UsaSpendingAwardsDiscoveryProvider({ broker })
      .discoverCompanies(query('usaspending_awards', 'US'), CTX);

    expect(result.records).toEqual([]);
  });

  it('does not turn a top-level federal department into a buyer lead when no sub-agency is present', async () => {
    const broker = brokerWith({
      records: [{ awardId: 'A-PARENT', awardingAgency: 'Department of Energy', recipientName: 'Acme Inc.', description: 'pump equipment' }],
      provenance: PROVENANCE,
    });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'US'), CTX)).resolves.toMatchObject({ records: [] });
  });

  it('does not treat a differently formatted copy of the top-level agency as a sub-agency', async () => {
    const broker = brokerWith({
      records: [{
        awardId: 'A-SAME', awardingAgency: 'Social Security Administration',
        awardingSubAgency: '  SOCIAL-SECURITY administration  ', recipientName: 'Acme Inc.', description: 'pump equipment',
      }],
      provenance: PROVENANCE,
    });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'US'), CTX)).resolves.toMatchObject({ records: [] });
  });

  it('keeps historical suppliers fail-closed until USAspending supplies a verified recipient entity type', async () => {
    const broker = brokerWith({
      records: [{ awardId: 'A-2', awardingAgency: 'Department of the Interior', recipientName: 'Acme Pumps Inc.', description: 'pump service' }],
      provenance: PROVENANCE,
    });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'United States', ['pump'], 'supplier'), CTX);
    expect(result.records).toEqual([]);
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('freezes the date window in an opaque continuation and rejects reuse for another query', async () => {
    vi.setSystemTime(new Date('2026-08-13T23:59:59Z'));
    const firstBroker = brokerWith({
      records: [{
        awardId: 'A-PAGE-1',
        awardingAgency: 'Department of Energy',
        awardingSubAgency: 'Federal Energy Office',
        recipientName: 'Page One Supplier Inc.',
        description: 'Industrial pump maintenance',
      }],
      nextCursor: '2',
      provenance: PROVENANCE,
    });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker: firstBroker });
    const first = await provider.discoverCompanies(query(provider.key, 'US'), CTX);
    expect(first.nextCursor).toBeTruthy();
    const firstProcurement = first.records[0]?.attributes?.procurement as Record<string, unknown>;
    expect(firstProcurement).toMatchObject({
      source_page: 1,
      query_start_date: '2024-08-13',
      query_end_date: '2026-08-13',
      query_keywords: ['pump'],
      query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    vi.setSystemTime(new Date('2026-08-14T00:00:01Z'));
    const secondBroker = brokerWith({
      records: [{
        awardId: 'A-PAGE-2',
        awardingAgency: 'Department of the Interior',
        awardingSubAgency: 'Bureau of Reclamation',
        recipientName: 'Acme Inc.',
        description: 'Industrial pump maintenance',
      }],
      provenance: PROVENANCE,
    });
    const resumed = new UsaSpendingAwardsDiscoveryProvider({ broker: secondBroker });
    const pageTwo = await resumed.discoverCompanies(query(resumed.key, 'US'), CTX, { cursor: first.nextCursor });
    expect(secondBroker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.usaSpending,
      expect.objectContaining({ startDate: '2024-08-13', endDate: '2026-08-13', page: 2 }),
      expect.any(Object),
    );
    expect(pageTwo.records[0]).toMatchObject({
      externalId: 'usaspending:A-PAGE-2:buyer',
      attributes: {
        procurement: {
          source_page: 2,
          query_start_date: '2024-08-13',
          query_end_date: '2026-08-13',
          query_keywords: ['pump'],
          query_fingerprint: firstProcurement.query_fingerprint,
        },
      },
    });

    await expect(resumed.discoverCompanies(query(resumed.key, 'US', ['valve']), CTX, { cursor: first.nextCursor }))
      .rejects.toThrow(/cursor is invalid/u);

    const decoded = JSON.parse(Buffer.from(first.nextCursor as string, 'base64url').toString('utf8')) as Record<string, unknown>;
    const tamperedWindow = Buffer.from(JSON.stringify({ ...decoded, startDate: '2020-01-01' }), 'utf8').toString('base64url');
    await expect(resumed.discoverCompanies(query(resumed.key, 'US'), CTX, { cursor: tamperedWindow }))
      .rejects.toThrow(/cursor is invalid/u);
  });

  it('does not invoke the source outside the explicit US scope', async () => {
    const broker = brokerWith({ records: [], provenance: PROVENANCE });
    const provider = new UsaSpendingAwardsDiscoveryProvider({ broker });
    await expect(provider.discoverCompanies(query(provider.key, 'Germany'), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });
});

describe('UK providers', () => {
  const ocdsPage = {
    records: [
      {
        externalId: 'ocds:release:buyer:1', ocid: 'ocds-1', releaseId: 'release-1', organizationName: 'City Council',
        organizationRole: 'buyer' as const, signalStage: 'planning_or_tender' as const, sourcePartyId: '1',
        country: 'United Kingdom', region: 'England' as const, declaredUrl: 'https://declared.example/path',
        title: 'Industrial pump contract', description: 'Private Person private@example.test 020 3920 8054', status: 'active',
        noticeUrl: 'https://www.find-tender.service.gov.uk/Notice/release-1', deadline: '2026-09-01T12:00:00Z',
        estimatedValue: 125000, currency: 'GBP', classificationIds: ['42122000'],
      },
      {
        externalId: 'ocds:release:supplier:2', ocid: 'ocds-1', releaseId: 'release-1', organizationName: 'Acme Pumps Ltd',
        organizationRole: 'supplier' as const, signalStage: 'awarded' as const, sourcePartyId: '2',
        country: 'France', title: 'Industrial pump contract',
      },
      {
        externalId: 'ocds:release:buyer:3', ocid: 'ocds-2', releaseId: 'release-2', organizationName: 'Unrelated Buyer',
        organizationRole: 'buyer' as const, signalStage: 'planning_or_tender' as const, title: 'Office pencils', status: 'active',
      },
    ],
    provenance: PROVENANCE,
  };

  it('Find a Tender maps roles, keyword filters locally and does not promote party id or URL to strong identity', async () => {
    const broker = brokerWith(ocdsPage);
    const provider = new UkFindATenderDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'United Kingdom'), CTX);
    expect(result.records).toHaveLength(1);
    expect(result.records.map((item) => item.attributes?.source_role)).toEqual(['buyer']);
    expect(result.records[0].attributes?.procurement).toMatchObject({
      source_party_id: '1', declared_url: 'https://declared.example/path',
      notice_url: 'https://www.find-tender.service.gov.uk/Notice/release-1',
      deadline: '2026-09-01T12:00:00Z', estimated_value: 125000, currency: 'GBP', cpv_codes: ['42122000'],
    });
    expect(result.records.every((item) => item.domain === undefined && item.identifiers === undefined)).toBe(true);
    expect(result.records[0]).toMatchObject({ country: 'United Kingdom', region: 'England' });
    expect(JSON.stringify(result.records[0])).not.toMatch(/Private Person|private@example\.test|020 3920 8054/u);
    expect(result.records.every((item) => item.provenance === PROVENANCE)).toBe(true);
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.ukFts,
      expect.objectContaining({ stage: 'tender', limit: 100 }),
      expect.any(Object),
    );
  });

  it('searches the full 100-record wire page before applying the smaller business limit', async () => {
    const unrelated = Array.from({ length: 99 }, (_, index) => ({
      ...ocdsPage.records[2],
      externalId: `unrelated:${index}`,
      ocid: `ocds-unrelated-${index}`,
      releaseId: `release-unrelated-${index}`,
    }));
    const broker = brokerWith({
      ...ocdsPage,
      records: [...unrelated, ocdsPage.records[0]],
    });
    const provider = new UkFindATenderDiscoveryProvider({ broker });
    const narrowQuery = query(provider.key, 'GB');
    narrowQuery.limit = 1;

    const result = await provider.discoverCompanies(narrowQuery, CTX);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].name).toBe('City Council');
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.ukFts,
      expect.objectContaining({ limit: 100, stage: 'tender' }),
      expect.any(Object),
    );
  });

  it('returns the adapter continuation and passes it back only through internal options', async () => {
    const broker = brokerWith({ ...ocdsPage, nextCursor: '{"cursor":"safe","updatedTo":"2026-08-13T00:00:00Z"}' });
    const provider = new UkFindATenderDiscoveryProvider({ broker });
    const injected = query(provider.key, 'GB');
    injected.filters.cursor = 'attacker-controlled';

    const result = await provider.discoverCompanies(injected, CTX, { cursor: 'opaque-from-previous-page' });

    expect(result.nextCursor).toBe('{"cursor":"safe","updatedTo":"2026-08-13T00:00:00Z"}');
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.ukFts,
      expect.objectContaining({ cursor: 'opaque-from-previous-page' }),
      expect.any(Object),
    );
  });

  it('admits historical awarded suppliers only when the query explicitly asks for the supplier role', async () => {
    const broker = brokerWith(ocdsPage);
    const provider = new UkFindATenderDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'GB', ['pump'], 'supplier'), CTX);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      name: 'Acme Pumps Ltd', country: 'France',
      attributes: { source_role: 'supplier', signal_stage: 'awarded' },
    });
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.ukFts,
      expect.objectContaining({ stage: 'award', limit: 100 }),
      expect.any(Object),
    );
  });

  it('does not emit a cancelled tender as current buyer demand', async () => {
    const broker = brokerWith({
      ...ocdsPage,
      records: [{
        ...ocdsPage.records[0],
        status: 'cancelled',
      }],
    });
    const provider = new UkFindATenderDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'GB'), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
  });

  it('Contracts Finder has its own provider key and official tool route', async () => {
    const broker = brokerWith(ocdsPage);
    const provider = new UkContractsFinderDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'GB'), CTX);
    expect(broker.invokeMock.mock.calls[0]?.[0]).toBe(PROCUREMENT_TOOL_IDS.ukContractsFinder);
    expect(broker.invokeMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ stage: 'tender', limit: 100 }));
    expect(result.records[0].externalId).toMatch(/^uk_contracts_finder:/u);
    expect(result.records[0].license).toBe('OGL-UK-3.0');
  });

  it('Contracts Finder is explicit buyer-only and never calls the wire for supplier mode', async () => {
    const broker = brokerWith(ocdsPage);
    const provider = new UkContractsFinderDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'GB', ['pump'], 'supplier'), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });

  it('Contracts Finder rejects an expired active notice before it can become a Lead', async () => {
    vi.setSystemTime(new Date('2026-09-02T00:00:00Z'));
    const broker = brokerWith(ocdsPage);
    const provider = new UkContractsFinderDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'GB'), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    vi.useRealTimers();
  });

  it('Contracts Finder rejects an ambiguous deadline without an explicit timezone', async () => {
    const broker = brokerWith({
      ...ocdsPage,
      records: [{ ...ocdsPage.records[0], deadline: '2099-09-01T12:00:00' }],
    });
    const provider = new UkContractsFinderDiscoveryProvider({ broker });

    await expect(provider.discoverCompanies(query(provider.key, 'GB'), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
  });

  it('filters a UK constituent on organization address while preserving continuation on an empty page', async () => {
    const broker = brokerWith({ ...ocdsPage, nextCursor: 'next-page' });
    const provider = new UkContractsFinderDiscoveryProvider({ broker });
    const northernIreland = query(provider.key, 'United Kingdom');
    northernIreland.filters.region = 'Northern Ireland';

    await expect(provider.discoverCompanies(northernIreland, CTX)).resolves.toEqual({
      records: [], costCents: 0, nextCursor: 'next-page',
    });
  });

  it('a wrong-country request cannot invoke either UK source', async () => {
    for (const Provider of [UkFindATenderDiscoveryProvider, UkContractsFinderDiscoveryProvider]) {
      const broker = brokerWith(ocdsPage);
      const provider = new Provider({ broker });
      await expect(provider.discoverCompanies(query(provider.key, 'Brazil'), CTX)).resolves.toEqual({ records: [], costCents: 0 });
      expect(broker.invokeMock).not.toHaveBeenCalled();
    }
  });
});

describe('Brazil PNCP provider mapping', () => {
  beforeEach(() => vi.setSystemTime(new Date('2026-08-13T00:00:00Z')));

  it('emits a checksum-validated matching CNPJ as Brazilian identity authority', async () => {
    const broker = brokerWith({
      records: [{
        controlNumber: '11222333000181-1-2026', organizationName: 'Municipio de Exemplo', organizationRole: 'buyer',
        signalStage: 'open_for_proposals', buyerCnpjClaim: '11222333000181', title: 'Compra de bombas pump',
        deadline: '2026-09-01T00:00:00', estimatedValue: 100000,
      }],
      provenance: PROVENANCE,
    });
    const provider = new BrazilPncpDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'Brazil'), CTX);
    expect(broker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.brazilPncp,
      expect.objectContaining({ dateFinal: '20260812', page: 1, pageSize: 50 }),
      expect.any(Object),
    );
    expect(result.records[0]).toMatchObject({
      country: 'BR',
      attributes: {
        source_role: 'buyer',
        signal_stage: 'open_for_proposals',
        procurement: {
          title: 'Compra de bombas pump',
          matched_query_terms: ['pump'],
          cnpj_claim: '11222333000181',
          cnpj_identity_status: 'validated_authority',
          source_page: 1,
          query_date_final: '20260812',
          query_keywords: ['pump'],
          query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      },
      identifiers: [{ scheme: 'br-cnpj', jurisdiction: 'BR', value: '11222333000181' }],
    });
    expect(result.records[0].identifier).toBeUndefined();
    expect(result.records[0].region).toBeUndefined();
  });

  it('does not emit a CNPJ claim or identifier when the adapter did not validate it', async () => {
    const broker = brokerWith({
      records: [{
        controlNumber: '12345678000191-1-2026', organizationName: 'Municipio de Exemplo', organizationRole: 'buyer',
        signalStage: 'open_for_proposals', title: 'Compra de bombas pump', deadline: '2026-09-01T00:00:00',
      }],
      provenance: PROVENANCE,
    });
    const provider = new BrazilPncpDiscoveryProvider({ broker });

    const result = await provider.discoverCompanies(query(provider.key, 'Brazil'), CTX);

    expect(result.records[0].identifiers).toBeUndefined();
    expect(result.records[0].attributes).toEqual(expect.objectContaining({
      procurement: expect.not.objectContaining({
        cnpj_claim: expect.anything(),
        cnpj_identity_status: expect.anything(),
      }),
    }));
  });

  it('revalidates brokered CNPJ claims at the Provider boundary', async () => {
    const broker = brokerWith({
      records: [
        {
          controlNumber: '12345678000190-1-2026', organizationName: 'Prefix Mismatch Buyer', organizationRole: 'buyer',
          signalStage: 'open_for_proposals', buyerCnpjClaim: '11222333000181', title: 'Compra de bombas pump',
          deadline: '2026-09-01T00:00:00',
        },
        {
          controlNumber: '11222333000181/2026', organizationName: 'Malformed Control Buyer', organizationRole: 'buyer',
          signalStage: 'open_for_proposals', buyerCnpjClaim: '11222333000181', title: 'Compra de válvulas pump',
          deadline: '2026-09-01T00:00:00',
        },
      ],
      provenance: PROVENANCE,
    });
    const provider = new BrazilPncpDiscoveryProvider({ broker });

    const result = await provider.discoverCompanies(query(provider.key, 'Brazil'), CTX);

    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.identifiers).toBeUndefined();
      expect(record.attributes).toEqual(expect.objectContaining({
        procurement: expect.not.objectContaining({
          cnpj_claim: expect.anything(),
          cnpj_identity_status: expect.anything(),
        }),
      }));
    }
  });

  it('rejects stale PNCP rows before persistence and freezes Brasilia date in a bound cursor', async () => {
    const firstBroker = brokerWith({
      records: [{
        controlNumber: '123-1-2026', organizationName: 'Municipio de Exemplo', organizationRole: 'buyer' as const,
        signalStage: 'open_for_proposals' as const, title: 'Compra de bombas pump', deadline: '2026-08-12T20:59:59',
      }],
      nextCursor: '2',
      provenance: PROVENANCE,
    });
    const firstProvider = new BrazilPncpDiscoveryProvider({ broker: firstBroker });
    const first = await firstProvider.discoverCompanies(query(firstProvider.key, 'BR'), CTX);
    expect(first.records).toEqual([]);
    expect(first.nextCursor).toBeTruthy();

    vi.setSystemTime(new Date('2026-08-14T04:00:00Z'));
    const resumedBroker = brokerWith({ records: [], provenance: PROVENANCE });
    const resumedProvider = new BrazilPncpDiscoveryProvider({ broker: resumedBroker });
    await resumedProvider.discoverCompanies(query(resumedProvider.key, 'BR'), CTX, { cursor: first.nextCursor });
    expect(resumedBroker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.brazilPncp,
      expect.objectContaining({ dateFinal: '20260812', page: 2 }),
      expect.any(Object),
    );

    const changed = query(resumedProvider.key, 'BR', ['different']);
    await expect(resumedProvider.discoverCompanies(changed, CTX, { cursor: first.nextCursor }))
      .rejects.toThrow(/PNCP cursor is invalid/u);
    const changedLimit = query(resumedProvider.key, 'BR');
    changedLimit.limit = 1;
    await expect(resumedProvider.discoverCompanies(changedLimit, CTX, { cursor: first.nextCursor }))
      .resolves.toEqual({ records: [], costCents: 0 });

    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    decoded.dateFinal = '20260811';
    const tamperedDate = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    await expect(resumedProvider.discoverCompanies(query(resumedProvider.key, 'BR'), CTX, { cursor: tamperedDate }))
      .rejects.toThrow(/PNCP cursor is invalid/u);
  });

  it('binds an optional Brazilian state to the official request and cursor', async () => {
    const firstBroker = brokerWith({ records: [], nextCursor: '2', provenance: PROVENANCE });
    const provider = new BrazilPncpDiscoveryProvider({ broker: firstBroker });
    const scoped = query(provider.key, 'BR');
    scoped.filters.state = 'pe';
    const first = await provider.discoverCompanies(scoped, CTX);
    expect(firstBroker.invokeMock).toHaveBeenCalledWith(
      PROCUREMENT_TOOL_IDS.brazilPncp,
      expect.objectContaining({ uf: 'PE', pageSize: 50 }),
      expect.any(Object),
    );

    const changedState = query(provider.key, 'BR');
    changedState.filters.state = 'SP';
    await expect(provider.discoverCompanies(changedState, CTX, { cursor: first.nextCursor }))
      .rejects.toThrow(/PNCP cursor is invalid/u);
  });

  it('normalizes PNCP title matching with NFKC and Brazilian Portuguese casing', async () => {
    const broker = brokerWith({
      records: [{
        controlNumber: '123-1-2026', organizationName: 'Municipio de Exemplo', organizationRole: 'buyer' as const,
        signalStage: 'open_for_proposals' as const, title: 'Prestação de SERVIÇO de manutenção',
        deadline: '2026-09-01T00:00:00',
      }],
      provenance: PROVENANCE,
    });
    const provider = new BrazilPncpDiscoveryProvider({ broker });
    const decomposedKeyword = `servic\u0327o`;

    await expect(provider.discoverCompanies(query(provider.key, 'BR', [decomposedKeyword]), CTX))
      .resolves.toMatchObject({ records: [expect.objectContaining({ name: 'Municipio de Exemplo' })] });
  });

  it('rejects an impossible PNCP calendar deadline before persistence', async () => {
    const broker = brokerWith({
      records: [{
        controlNumber: '123-1-2026', organizationName: 'Municipio de Exemplo', organizationRole: 'buyer' as const,
        signalStage: 'open_for_proposals' as const, title: 'Compra de bombas pump',
        deadline: '2026-02-30T12:00:00',
      }],
      provenance: PROVENANCE,
    });
    const provider = new BrazilPncpDiscoveryProvider({ broker });
    await expect(provider.discoverCompanies(query(provider.key, 'BR'), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
  });
});

describe('Singapore GeBIZ provider mapping', () => {
  it('emits the awarded supplier, not the buyer agency as a company lead', async () => {
    const broker = brokerWith({
      records: [{
        externalId: 'ABC:1', tenderNumber: 'ABC', organizationName: 'Acme Singapore Pte Ltd',
        organizationRole: 'supplier', signalStage: 'awarded_historical', title: 'Industrial pump',
        buyerAgency: 'Public Utilities Board', amount: 12345,
      }],
      provenance: PROVENANCE,
    });
    const provider = new SingaporeGebizDiscoveryProvider({ broker });
    const result = await provider.discoverCompanies(query(provider.key, 'Singapore'), CTX);
    expect(result.records).toEqual([
      expect.objectContaining({
        name: 'Acme Singapore Pte Ltd',
        country: 'SG',
        attributes: {
          source_role: 'supplier',
          signal_stage: 'awarded_historical',
          procurement: expect.objectContaining({ buyer_agency: 'Public Utilities Board' }),
        },
        provenance: PROVENANCE,
      }),
    ]);
  });

  it('does not put historical awarded suppliers into the default buyer candidate pool', async () => {
    const broker = brokerWith({ records: [], provenance: PROVENANCE });
    const provider = new SingaporeGebizDiscoveryProvider({ broker });
    const buyerQuery: CompanyDiscoveryQuery = {
      sourceClass: 'public_intelligence',
      filters: { source_hint: provider.key, country: 'Singapore' },
      keywords: ['pump'],
      limit: 10,
    };

    await expect(provider.discoverCompanies(buyerQuery, CTX)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invokeMock).not.toHaveBeenCalled();
  });
});
