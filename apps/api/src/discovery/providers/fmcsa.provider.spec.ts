import { describe, expect, it, vi } from 'vitest';
import { FmcsaQcmobileOrganizationDiscoveryProvider } from './fmcsa.provider';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const PROVENANCE = {
  sourceUrl: 'https://mobile.fmcsa.dot.gov/qc/services/carriers/name/ACME%20LOGISTICS%20LLC?start=0&size=10&webKey=REDACTED',
  fetchedAt: '2026-08-15T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'fmcsa-qcmobile-v1/1',
};
const carrier = {
  usdotNumber: '1234567', legalName: 'ACME LOGISTICS LLC', dbaName: 'ACME FREIGHT',
  allowedToOperate: 'Y', outOfService: 'N', state: 'TX',
};

function query(filters: Record<string, unknown>) {
  return { sourceClass: 'company_registry' as const, filters, keywords: [], limit: 10 };
}

describe('FMCSA QCMobile discovery provider', () => {
  it('requires exact hint, US scope, and one explicit organization name before Broker invocation', async () => {
    const broker = { invoke: vi.fn() };
    const provider = new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: broker as never });
    for (const filters of [
      { country: 'US', organization_name: 'ACME LOGISTICS LLC' },
      { source_hint: ['fmcsa_qcmobile'], country: 'US', organization_name: 'ACME LOGISTICS LLC' },
    ]) {
      await expect(provider.discoverCompanies(query(filters), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    }
    await expect(provider.discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'CA', organization_name: 'ACME LOGISTICS LLC',
    }), CTX)).rejects.toThrow('FMCSA_COUNTRY_SCOPE_INVALID');
    await expect(provider.discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'all',
    }), CTX)).rejects.toThrow('FMCSA_EXACT_QUERY_REQUIRED');
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('maps a validated USDOT authority and coarse status without contact or address data', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { carriers: [carrier] }, costCents: 0, provenance: PROVENANCE,
    })) };
    const result = await new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'ACME LOGISTICS LLC',
    }), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('fmcsa-qcmobile.search', {
      query: 'ACME LOGISTICS LLC', start: 0, limit: 10,
    }, expect.objectContaining({ purpose: 'discovery' }));
    expect(result.records).toEqual([expect.objectContaining({
      externalId: 'fmcsa-qcmobile:1234567', name: 'ACME LOGISTICS LLC', country: 'US', region: 'TX',
      identifiers: [{ scheme: 'usdot', jurisdiction: 'US', value: '1234567' }],
      license: 'SOURCE_SPECIFIC', provenance: PROVENANCE,
    })]);
    expect(result.records[0]).not.toHaveProperty('domain');
    const attributes = result.records[0]?.attributes?.fmcsa_qcmobile as Record<string, unknown>;
    expect(Object.keys(attributes)).not.toEqual(expect.arrayContaining(['phone', 'email', 'street', 'city', 'zip']));
    expect(JSON.stringify(result.records[0])).not.toMatch(/555-0100|private@example|MUST_NOT_SURVIVE|78701/iu);
  });

  it('accepts an exact DBA match but rejects unrelated broker rows', async () => {
    const acceptedBroker = { invoke: vi.fn(async () => ({
      data: { carriers: [carrier] }, costCents: 0,
      provenance: { ...PROVENANCE, sourceUrl: PROVENANCE.sourceUrl.replace('ACME%20LOGISTICS%20LLC', 'ACME%20FREIGHT') },
    })) };
    const accepted = await new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: acceptedBroker as never }).discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'ACME FREIGHT',
    }), CTX);
    expect(accepted.records).toHaveLength(1);

    const rejectedBroker = { invoke: vi.fn(async () => ({
      data: { carriers: [{ ...carrier, legalName: 'OTHER LOGISTICS LLC', dbaName: 'OTHER' }] },
      costCents: 0, provenance: PROVENANCE,
    })) };
    await expect(new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: rejectedBroker as never }).discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'ACME LOGISTICS LLC',
    }), CTX)).rejects.toThrow('FMCSA_BROKER_RESULT_INVALID');
  });

  it('binds continuation to the exact organization scope', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { carriers: [carrier], nextCursor: '10' }, costCents: 0, provenance: PROVENANCE,
    })) };
    const scoped = query({ source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'ACME LOGISTICS LLC' });
    const first = await new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(scoped, CTX);
    expect(first.nextCursor).toBeTruthy();

    const secondProvenance = { ...PROVENANCE, sourceUrl: PROVENANCE.sourceUrl.replace('start=0', 'start=10') };
    const secondBroker = { invoke: vi.fn(async () => ({ data: { carriers: [] }, costCents: 0, provenance: secondProvenance })) };
    const resumed = new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: secondBroker as never });
    await resumed.discoverCompanies(scoped, CTX, { cursor: first.nextCursor });
    expect(secondBroker.invoke).toHaveBeenCalledWith('fmcsa-qcmobile.search', expect.objectContaining({ start: 10 }), expect.any(Object));
    await expect(resumed.discoverCompanies(query({
      source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'OTHER LOGISTICS LLC',
    }), CTX, { cursor: first.nextCursor })).rejects.toThrow('FMCSA_CURSOR_INVALID');
  });

  it('binds provenance to the requested name and page', async () => {
    for (const sourceUrl of [
      PROVENANCE.sourceUrl.replace('start=0', 'start=10'),
      PROVENANCE.sourceUrl.replace('ACME%20LOGISTICS%20LLC', 'OTHER'),
      PROVENANCE.sourceUrl.replace('webKey=REDACTED', 'webKey=secret'),
      'not-a-url',
    ]) {
      const broker = { invoke: vi.fn(async () => ({
        data: { carriers: [carrier] }, costCents: 0, provenance: { ...PROVENANCE, sourceUrl },
      })) };
      await expect(new FmcsaQcmobileOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'fmcsa_qcmobile', country: 'US', organization_name: 'ACME LOGISTICS LLC',
      }), CTX)).rejects.toThrow('FMCSA_PROVENANCE_REQUIRED');
    }
  });
});
