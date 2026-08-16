import { describe, expect, it, vi } from 'vitest';
import {
  FranceOfficialOrganizationDiscoveryProvider,
  NppesOrganizationDiscoveryProvider,
  RorOrganizationDiscoveryProvider,
  SecEdgarOrganizationDiscoveryProvider,
} from './official-organization.providers';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const query = (filters: Record<string, unknown>, keywords = ['example']) => ({
  sourceClass: 'company_registry' as const,
  filters,
  keywords,
  limit: 10,
});
const FR_PROVENANCE = {
  sourceUrl: 'https://recherche-entreprises.api.gouv.fr/search?q=example',
  fetchedAt: '2026-08-13T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'recherche-entreprises/1',
};
const NPPES_PROVENANCE = {
  sourceUrl: 'https://npiregistry.cms.hhs.gov/api/?version=2.1',
  fetchedAt: '2026-08-13T00:00:00.000Z',
  contentHash: 'b'.repeat(64),
  parserVersion: 'nppes-v2.1/1',
};
const ROR_PROVENANCE = {
  sourceUrl: 'https://api.ror.org/v2/organizations?query=Oxford&page=1',
  fetchedAt: '2026-08-14T00:00:00.000Z',
  contentHash: 'c'.repeat(64),
  parserVersion: 'ror-v2.1/2',
};
const SEC_DIRECTORY_PROVENANCE = {
  sourceUrl: 'https://www.sec.gov/files/company_tickers_exchange.json',
  fetchedAt: '2026-08-14T00:00:00.000Z',
  contentHash: 'd'.repeat(64),
  parserVersion: 'sec-edgar-company-tickers-exchange/1',
};

describe('official organization discovery providers', () => {
  it('maps official French SIREN as a jurisdiction-scoped strong identifier', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [{ siren: '356000000', name: 'LA POSTE' }] },
      costCents: 0,
      provenance: { ...FR_PROVENANCE, internalSecret: 'MUST_NOT_SURVIVE' },
    })) };
    const result = await new FranceOfficialOrganizationDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query({ country: 'FR' }, ['la poste']), CTX);
    expect(result.records[0]).toMatchObject({
      identifiers: [{ scheme: 'siren', jurisdiction: 'FR', value: '356000000' }],
      provenance: FR_PROVENANCE,
    });
    expect(result.records[0]?.provenance).toEqual(FR_PROVENANCE);
  });

  it('keeps only the exact SIREN when discovery was explicitly identifier-scoped', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [
        { siren: '356000000', name: 'LA POSTE' },
        { siren: '562082909', name: 'Unrelated Search Hit' },
      ] },
      costCents: 0,
      provenance: FR_PROVENANCE,
    })) };

    const result = await new FranceOfficialOrganizationDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query({ siren: '356 000 000', country: 'FR' }, []), CTX);

    expect(result.records.map((record) => record.externalId)).toEqual(['fr-company:356000000']);
  });

  it('maps NPI-2 organization units without synthesizing person fields', async () => {
    const broker = { invoke: vi.fn(async () => ({ data: { organizations: [{
      npi: '1234567893', name: 'Example Clinic', status: 'A', state: 'MD', taxonomyDescriptions: ['Clinic/Center'],
    }] }, costCents: 0, provenance: NPPES_PROVENANCE })) };
    const result = await new NppesOrganizationDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query({ country: 'US', healthcare: true }, ['example clinic']), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('nppes.search', expect.objectContaining({ organizationName: 'example clinic' }), expect.any(Object));
    expect(result.records[0]).toMatchObject({
      name: 'Example Clinic',
      identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: '1234567893' }],
      provenance: NPPES_PROVENANCE,
    });
    expect(JSON.stringify(result.records[0])).not.toMatch(/authorized|phone|email|first_name|last_name/iu);
  });

  it('requires the US healthcare scope and preserves an exact deactivated NPI as a provenance-backed lifecycle fact', async () => {
    const broker = { invoke: vi.fn(async () => ({ data: { organizations: [{
      npi: '1234567893', name: 'Deactivated Clinic', status: 'D', state: 'MD', taxonomyDescriptions: ['Clinic/Center'],
    }] }, costCents: 0, provenance: NPPES_PROVENANCE })) };
    const provider = new NppesOrganizationDiscoveryProvider({ broker: broker as never });

    await expect(provider.discoverCompanies(query({ npi: '1234567893' }, []), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invoke).not.toHaveBeenCalled();

    await expect(provider.discoverCompanies(query({ npi: '1234567893', country: 'US', healthcare: true }, []), CTX))
      .resolves.toEqual({
        records: [expect.objectContaining({
          externalId: 'nppes:1234567893',
          identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: '1234567893' }],
          attributes: {
            nppes: expect.objectContaining({
              npi: '1234567893',
              status: 'D',
              candidate_eligible: false,
              observation_scope: 'exact_npi',
            }),
          },
          provenance: NPPES_PROVENANCE,
        })],
        costCents: 0,
      });
    expect(broker.invoke).toHaveBeenCalledOnce();
  });

  it('still excludes deactivated NPI units from name-based acquisition discovery', async () => {
    const broker = { invoke: vi.fn(async () => ({ data: { organizations: [{
      npi: '1234567893', name: 'Deactivated Clinic', status: 'D', state: 'MD', taxonomyDescriptions: ['Clinic/Center'],
    }] }, costCents: 0, provenance: NPPES_PROVENANCE })) };

    await expect(new NppesOrganizationDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query({ country: 'US', healthcare: true }, ['deactivated clinic']), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
  });

  it.each([undefined, '', 'UNKNOWN', 'X'])(
    'fails the provider for an unknown NPPES lifecycle status (%s) instead of reporting a zero result',
    async (status) => {
      const broker = { invoke: vi.fn(async () => ({ data: { organizations: [{
        npi: '1234567893', name: 'Uncertain Clinic', status, state: 'MD', taxonomyDescriptions: ['Clinic/Center'],
      }] }, costCents: 0, provenance: NPPES_PROVENANCE })) };
      await expect(new NppesOrganizationDiscoveryProvider({ broker: broker as never })
        .discoverCompanies(query({ country: 'US', healthcare: true }, ['uncertain clinic']), CTX))
        .rejects.toThrow('NPPES_STATUS_UNKNOWN');
    },
  );

  it('fails closed without a ToolBroker', async () => {
    await expect(new FranceOfficialOrganizationDiscoveryProvider().discoverCompanies(query({ country: 'FR' }), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
  });

  it('routes ROR only with explicit country/type scope and emits only the checksum-valid ROR authority', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: {
        organizations: [{
          rorId: 'https://ror.org/052gg0110', name: 'University of Oxford', country: 'GB',
          types: ['education', 'funder'], reportedDomains: ['ox.ac.uk'],
        }],
        nextCursor: '2',
        total: 24,
      },
      costCents: 0,
      provenance: ROR_PROVENANCE,
    })) };
    const provider = new RorOrganizationDiscoveryProvider({ broker: broker as never });

    await expect(provider.discoverCompanies(query({ country: 'GB', organization_types: ['education'] }, ['Oxford']), CTX))
      .resolves.toEqual({ records: [], costCents: 0 });
    await expect(provider.discoverCompanies(query({
      source_hint: ['ror'], country: 'GB', organization_types: ['education'],
    }, ['Oxford']), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    const result = await provider.discoverCompanies(query({
      source_hint: 'ror', country: 'GB', organization_types: ['education'],
    }, ['Oxford']), CTX);

    expect(result.records[0]).toMatchObject({
      externalId: 'ror:052gg0110',
      name: 'University of Oxford',
      identifiers: [{ scheme: 'ror-id', jurisdiction: 'GLOBAL', value: 'https://ror.org/052gg0110' }],
      attributes: { ror: { reported_domain_candidates: ['ox.ac.uk'], domain_identity_status: 'source_reported_evidence_only' } },
      provenance: ROR_PROVENANCE,
    });
    expect(result.records[0]?.domain).toBeUndefined();
    expect(result.nextCursor).toBeTruthy();
    await expect(provider.discoverCompanies(query({
      source_hint: 'ror', country: 'GB', organization_types: ['education'],
    }, ['Different']), CTX, { cursor: result.nextCursor })).rejects.toThrow('ROR_CURSOR_INVALID');
  });

  it('rejects a brokered ROR ID whose checksum is invalid', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [{ rorId: '052gg0111', name: 'Bad ROR', country: 'GB', types: ['education'], reportedDomains: [] }] },
      costCents: 0,
      provenance: ROR_PROVENANCE,
    })) };
    await expect(new RorOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
      source_hint: 'ror', country: 'GB', organization_types: ['education'],
    }, ['Bad ROR']), CTX)).rejects.toThrow('ROR_ID_INVALID');
  });

  it('rejects brokered ROR rows outside the frozen country and organization type scope', async () => {
    for (const organization of [
      { rorId: '052gg0110', name: 'Wrong Country', country: 'US', types: ['education'], reportedDomains: [] },
      { rorId: '052gg0110', name: 'Wrong Type', country: 'GB', types: ['company'], reportedDomains: [] },
    ]) {
      const broker = { invoke: vi.fn(async () => ({
        data: { organizations: [organization] }, costCents: 0, provenance: ROR_PROVENANCE,
      })) };
      await expect(new RorOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'ror', country: 'GB', organization_types: ['education'],
      }, ['Oxford']), CTX)).rejects.toThrow('ROR_BROKER_RESULT_INVALID');
    }
  });

  it('rejects tool results that do not carry the real response provenance', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [{ siren: '356000000', name: 'LA POSTE' }] },
      costCents: 0,
    })) };
    await expect(new FranceOfficialOrganizationDiscoveryProvider({ broker: broker as never })
      .discoverCompanies(query({ country: 'FR' }, ['la poste']), CTX))
      .rejects.toThrow('OFFICIAL_ORGANIZATION_PROVENANCE_REQUIRED');
  });

  it('routes SEC directory discovery only by an exact string hint and never invokes submissions', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [{ cik: '0000000123', name: 'ACME CORPORATION', ticker: 'ACME' }] },
      costCents: 0,
      provenance: SEC_DIRECTORY_PROVENANCE,
    })) };
    const provider = new SecEdgarOrganizationDiscoveryProvider({ broker: broker as never });

    for (const sourceHint of [undefined, ['sec_edgar'], 'sec', 'sec_edgar_extra']) {
      await expect(provider.discoverCompanies(query({ source_hint: sourceHint }, ['ACME']), CTX))
        .resolves.toEqual({ records: [], costCents: 0 });
    }
    const result = await provider.discoverCompanies(query({ source_hint: 'sec_edgar' }, ['ACME']), CTX);

    expect(broker.invoke).toHaveBeenCalledOnce();
    expect(broker.invoke).toHaveBeenCalledWith(
      'sec-edgar.company-directory.search',
      { query: 'ACME', limit: 5 },
      expect.objectContaining({ purpose: 'discovery' }),
    );
    expect(broker.invoke).not.toHaveBeenCalledWith('sec-edgar.submission.fetch', expect.anything(), expect.anything());
    expect(result.records).toEqual([expect.objectContaining({
      externalId: 'sec-edgar:0000000123',
      name: 'ACME CORPORATION',
      identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: '0000000123' }],
      identifier: { scheme: 'cik', jurisdiction: 'US', value: '0000000123' },
      provenance: SEC_DIRECTORY_PROVENANCE,
    })]);
    expect(result.records[0]?.domain).toBeUndefined();
    expect(JSON.stringify(result.records[0])).not.toMatch(/filings|formerNames|addresses|ein|phone|website/iu);
  });

});
