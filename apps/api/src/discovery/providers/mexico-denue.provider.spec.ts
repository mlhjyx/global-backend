import { describe, expect, it, vi } from 'vitest';
import { MexicoDenueOrganizationDiscoveryProvider } from './mexico-denue.provider';

const CTX = { workspaceId: 'workspace-1', runId: 'run-1' };
const PROVENANCE = {
  sourceUrl: 'https://www.inegi.org.mx/app/api/denue/v1/consulta/Nombre/NISSAN%20MEXICANA/01/1/20/REDACTED_TOKEN',
  fetchedAt: '2026-08-15T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'denue-nombre-v1/1',
};
const organization = {
  clee: '25012713120003411000000000U6', denueId: '1234567890',
  name: 'NISSAN MEXICANA', legalName: 'NISSAN MEXICANA, S.A. DE C.V.',
  economicActivity: 'Fabricacion de automoviles', state: 'AGUASCALIENTES', municipality: 'AGUASCALIENTES',
  website: 'https://www.nissan.com.mx/',
};

function query(filters: Record<string, unknown>) {
  return { sourceClass: 'company_registry' as const, filters, keywords: [], limit: 20 };
}

describe('Mexico DENUE discovery provider', () => {
  it('requires exact hint, MX, state and one explicit organization name before Broker invocation', async () => {
    const broker = { invoke: vi.fn() };
    const provider = new MexicoDenueOrganizationDiscoveryProvider({ broker: broker as never });
    for (const filters of [
      { country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA' },
      { source_hint: ['mexico_denue'], country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA' },
    ]) {
      await expect(provider.discoverCompanies(query(filters), CTX)).resolves.toEqual({ records: [], costCents: 0 });
    }
    await expect(provider.discoverCompanies(query({
      source_hint: 'mexico_denue', country: 'US', state_code: '01', organization_name: 'NISSAN MEXICANA',
    }), CTX)).rejects.toThrow('DENUE_COUNTRY_SCOPE_INVALID');
    await expect(provider.discoverCompanies(query({
      source_hint: 'mexico_denue', country: 'MX', state_code: '00', organization_name: 'NISSAN MEXICANA',
    }), CTX)).rejects.toThrow('DENUE_STATE_CODE_INVALID');
    await expect(provider.discoverCompanies(query({
      source_hint: 'mexico_denue', country: 'MX', state_code: '01', organization_name: 'todos',
    }), CTX)).rejects.toThrow('DENUE_EXACT_QUERY_REQUIRED');
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('maps only coarse organization evidence and does not create a strong identity or domain', async () => {
    const broker = { invoke: vi.fn(async () => ({
      data: { organizations: [organization] }, costCents: 0, provenance: PROVENANCE,
    })) };
    const result = await new MexicoDenueOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
      source_hint: 'mexico_denue', country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA',
    }), CTX);
    expect(broker.invoke).toHaveBeenCalledWith('mexico-denue.search', {
      query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 20,
    }, expect.objectContaining({ purpose: 'discovery' }));
    expect(result.records).toEqual([expect.objectContaining({
      externalId: 'mexico-denue:1234567890', name: 'NISSAN MEXICANA, S.A. DE C.V.', country: 'MX',
      license: 'INEGI_FREE_USE_WITH_ATTRIBUTION', provenance: PROVENANCE,
    })]);
    expect(result.records[0]).not.toHaveProperty('domain');
    expect(result.records[0]).not.toHaveProperty('identifier');
    expect(result.records[0]).not.toHaveProperty('identifiers');
    expect(JSON.stringify(result.records[0])).not.toMatch(/phone|email|street|latitude|longitude/iu);
  });

  it('binds continuation to the exact organization and state scope', async () => {
    const firstBroker = { invoke: vi.fn(async () => ({
      data: { organizations: [organization], nextCursor: '21' }, costCents: 0, provenance: PROVENANCE,
    })) };
    const provider = new MexicoDenueOrganizationDiscoveryProvider({ broker: firstBroker as never });
    const scoped = query({ source_hint: 'mexico_denue', country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA' });
    const first = await provider.discoverCompanies(scoped, CTX);
    expect(first.nextCursor).toBeTruthy();

    const secondProvenance = { ...PROVENANCE, sourceUrl: PROVENANCE.sourceUrl.replace('/1/20/', '/21/40/') };
    const secondBroker = { invoke: vi.fn(async () => ({ data: { organizations: [] }, costCents: 0, provenance: secondProvenance })) };
    const resumed = new MexicoDenueOrganizationDiscoveryProvider({ broker: secondBroker as never });
    await resumed.discoverCompanies(scoped, CTX, { cursor: first.nextCursor });
    expect(secondBroker.invoke).toHaveBeenCalledWith('mexico-denue.search', expect.objectContaining({ start: 21 }), expect.any(Object));
    await expect(resumed.discoverCompanies(query({
      source_hint: 'mexico_denue', country: 'MX', state_code: '02', organization_name: 'NISSAN MEXICANA',
    }), CTX, { cursor: first.nextCursor })).rejects.toThrow('DENUE_CURSOR_INVALID');
  });

  it('rejects a broker row outside the frozen exact name or published CLEE structure', async () => {
    for (const bad of [{ ...organization, name: 'OTHER' }, { ...organization, clee: 'bad' }]) {
      const broker = { invoke: vi.fn(async () => ({ data: { organizations: [bad] }, costCents: 0, provenance: PROVENANCE })) };
      await expect(new MexicoDenueOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'mexico_denue', country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA',
      }), CTX)).rejects.toThrow('DENUE_BROKER_RESULT_INVALID');
    }
  });

  it('binds provenance to the requested name, state and page and normalizes malformed URLs', async () => {
    for (const sourceUrl of [
      PROVENANCE.sourceUrl.replace('/01/', '/02/'),
      PROVENANCE.sourceUrl.replace('NISSAN%20MEXICANA', 'OTHER'),
      'not-a-url',
    ]) {
      const broker = { invoke: vi.fn(async () => ({
        data: { organizations: [organization] }, costCents: 0, provenance: { ...PROVENANCE, sourceUrl },
      })) };
      await expect(new MexicoDenueOrganizationDiscoveryProvider({ broker: broker as never }).discoverCompanies(query({
        source_hint: 'mexico_denue', country: 'MX', state_code: '01', organization_name: 'NISSAN MEXICANA',
      }), CTX)).rejects.toThrow('DENUE_PROVENANCE_REQUIRED');
    }
  });
});
