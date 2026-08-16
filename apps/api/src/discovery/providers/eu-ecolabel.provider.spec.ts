import { describe, expect, it, vi } from 'vitest';
import { EuEcolabelOrganizationDiscoveryProvider } from './eu-ecolabel.provider';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const SOURCE_URL = 'https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/products?offset=0&limit=10&fields=licence_number%2Cexpiration_date%2Cdecision%2Cgroup_name%2Clicence_holder%2Clicence_holder_country%2Citem_id%2Cproduct_name&order_by=licence_number%2Citem_id&licence_holder=Hagleitner+Hygiene+International+GmbH&licence_holder_country=Austria';
const PROVENANCE = {
  sourceUrl: SOURCE_URL,
  fetchedAt: '2026-08-16T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'ec-env-data-ecolabel-products-v2/1',
};
const product = {
  licenceNumber: 'AT/004/001', expirationDate: '2028-12-31T00:00:00', decision: '(EU) 2019/70',
  groupName: 'Tissue Paper and Tissue Products', licenceHolder: 'Hagleitner Hygiene International GmbH',
  licenceHolderCountry: 'Austria', licenceHolderCountryCode: 'AT', itemId: '124717', productName: 'multiROLL handTUCH X2.2 L',
};

function query(filters: Record<string, unknown>) {
  return { sourceClass: 'public_intelligence' as const, filters, keywords: [], limit: 10 };
}

describe('EU Ecolabel organization discovery provider', () => {
  it('requires exact source hint, country, and a clearly organizational exact name before Broker invocation', async () => {
    const broker = { invoke: vi.fn() };
    const provider = new EuEcolabelOrganizationDiscoveryProvider({ broker: broker as never });
    for (const filters of [
      { country: 'Austria', organization_name: 'ACME GmbH' },
      { source_hint: ['eu_ecolabel'], country: 'Austria', organization_name: 'ACME GmbH' },
    ]) {
      await expect(provider.discoverCompanies(query(filters), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    }
    await expect(provider.discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: '', organization_name: 'ACME GmbH',
    }), CTX)).rejects.toThrow('EU_ECOLABEL_COUNTRY_REQUIRED');
    await expect(provider.discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'John Smith',
    }), CTX)).rejects.toThrow('EU_ECOLABEL_EXACT_ORGANIZATION_REQUIRED');
    await expect(provider.discoverCompanies({ ...query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'ACME GmbH',
    }), limit: Number.NaN }, CTX)).rejects.toThrow('EU_ECOLABEL_LIMIT_INVALID');
    await expect(provider.discoverCompanies({ ...query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'ACME GmbH',
    }), sourceClass: 'company_registry' }, CTX)).resolves.toEqual({ records: [], costCents: 0 });
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('maps award evidence without promoting a certification number to company identity or retaining contact data', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { products: [product] }, costCents: 0, provenance: PROVENANCE,
    })) };
    const result = await new EuEcolabelOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'Hagleitner Hygiene International GmbH',
    }), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('ec-env-data.ecolabel-products.search', {
      organizationName: 'Hagleitner Hygiene International GmbH', country: 'Austria', offset: 0, limit: 10,
    }, expect.objectContaining({ purpose: 'discovery' }));
    expect(result.records).toEqual([expect.objectContaining({
      externalId: 'eu-ecolabel:AT%2F004%2F001:124717',
      name: 'Hagleitner Hygiene International GmbH', country: 'AT',
      industry: 'Tissue Paper and Tissue Products', license: 'EC-REUSE-CC-BY-4.0', provenance: PROVENANCE,
    })]);
    expect(result.records[0]).not.toHaveProperty('identifier');
    expect(result.records[0]).not.toHaveProperty('identifiers');
    const attributes = result.records[0]?.attributes?.eu_ecolabel as Record<string, unknown>;
    expect(Object.keys(attributes)).not.toEqual(expect.arrayContaining([
      'licence_holder_vat', 'service_email', 'service_phone', 'service_street',
      'service_postal_code', 'service_longitude', 'service_latitude',
    ]));
    expect(JSON.stringify(result.records[0])).not.toMatch(/private@example|MUST_NOT_SURVIVE|\+43 000 000/iu);
  });

  it('rejects unrelated broker rows and provenance not bound to the exact page', async () => {
    const unrelated = { ...product, licenceHolder: 'OTHER COMPANY GmbH' };
    const unrelatedBroker = { invoke: vi.fn(async () => ({
      data: { products: [unrelated] }, costCents: 0, provenance: PROVENANCE,
    })) };
    await expect(new EuEcolabelOrganizationDiscoveryProvider({ broker: unrelatedBroker as never }).discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'Hagleitner Hygiene International GmbH',
    }), CTX)).rejects.toThrow('EU_ECOLABEL_BROKER_RESULT_INVALID');

    const wrongPageBroker = { invoke: vi.fn(async () => ({
      data: { products: [product] }, costCents: 0,
      provenance: { ...PROVENANCE, sourceUrl: SOURCE_URL.replace('offset=0', 'offset=10') },
    })) };
    await expect(new EuEcolabelOrganizationDiscoveryProvider({ broker: wrongPageBroker as never }).discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'Hagleitner Hygiene International GmbH',
    }), CTX)).rejects.toThrow('EU_ECOLABEL_PROVENANCE_REQUIRED');
  });

  it('rejects malformed or oversized Broker result envelopes', async () => {
    for (const data of [
      undefined,
      { products: 'not-an-array' },
      { products: Array.from({ length: 11 }, () => product) },
      { products: [null] },
      { products: [42] },
    ]) {
      const broker = { invoke: vi.fn(async () => ({ data, costCents: 0, provenance: PROVENANCE })) };
      await expect(new EuEcolabelOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'Hagleitner Hygiene International GmbH',
      }), CTX)).rejects.toThrow('EU_ECOLABEL_BROKER_RESULT_INVALID');
    }
  });

  it('binds continuation to the exact holder and country scope', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { products: [product], nextCursor: '10' }, costCents: 0, provenance: PROVENANCE,
    })) };
    const scoped = query({
      source_hint: 'eu_ecolabel', country: 'Austria', organization_name: 'Hagleitner Hygiene International GmbH',
    });
    const first = await new EuEcolabelOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(scoped, CTX);
    expect(first.nextCursor).toBeTruthy();

    const nextBroker = { invoke: vi.fn(async () => ({
      data: { products: [] }, costCents: 0,
      provenance: { ...PROVENANCE, sourceUrl: SOURCE_URL.replace('offset=0', 'offset=10') },
    })) };
    const resumed = new EuEcolabelOrganizationDiscoveryProvider({ broker: nextBroker as never });
    await resumed.discoverCompanies(scoped, CTX, { cursor: first.nextCursor });
    expect(nextBroker.invoke).toHaveBeenCalledWith('ec-env-data.ecolabel-products.search', expect.objectContaining({ offset: 10 }), expect.any(Object));
    await expect(resumed.discoverCompanies(query({
      source_hint: 'eu_ecolabel', country: 'Belgium', organization_name: 'Hagleitner Hygiene International GmbH',
    }), CTX, { cursor: first.nextCursor })).rejects.toThrow('EU_ECOLABEL_CURSOR_INVALID');
  });
});
