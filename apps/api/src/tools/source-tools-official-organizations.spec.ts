import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { registerSourceTools } from './source-tools';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('official organization source-tool runtime boundary', () => {
  it('registers SEC directory and submissions as separate governed tools', () => {
    const registry = registerSourceTools(new ToolRegistry());

    expect(registry.get('fr-company.search')?.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'recherche-entreprises.api.gouv.fr',
      providerKey: 'fr_company',
      personalData: true,
    });
    expect(registry.get('nppes.search')?.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'npiregistry.cms.hhs.gov',
      providerKey: 'nppes',
      personalData: true,
    });
    expect(registry.get('ror.search')?.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'api.ror.org',
      providerKey: 'ror',
      personalData: false,
    });
    expect(registry.get('sec-edgar.search')).toBeUndefined();
    expect(registry.get('sec-edgar.company-directory.search')?.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'www.sec.gov',
      providerKey: 'sec_edgar',
      personalData: false,
      allowedPurpose: ['discovery'],
    });
    expect(registry.get('sec-edgar.submission.fetch')?.compliance).toMatchObject({
      sourcePolicy: 'required',
      policyDomain: 'data.sec.gov',
      providerKey: 'sec_edgar',
      requiresExplicitPurpose: true,
      personalData: true,
      allowedPurpose: ['enrichment'],
    });
    expect(registry.get('sec-edgar.submission.fetch')?.capabilities).toMatchObject({
      produces: ['relation'],
      accepts: ['cik'],
      enrichesOnly: true,
    });
  });

  it.each([
    ['fr-company.search', { query: 'la poste', limit: 10 }, 'discovery'],
    ['nppes.search', { organizationName: 'clinic', limit: 10 }, 'discovery'],
    ['ror.search', { query: 'Oxford', country: 'GB', types: ['education'], limit: 10, page: 1 }, 'discovery'],
    ['sec-edgar.company-directory.search', { query: 'ACME', limit: 5 }, 'discovery'],
    ['sec-edgar.submission.fetch', { cik: '0000000123', expectedName: 'ACME CORPORATION' }, 'enrichment'],
  ])('fails closed before fetch when %s has no source-policy reader', async (toolId, input, purpose) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const broker = new ToolBroker({
      registry: registerSourceTools(new ToolRegistry()),
      providerStatusReader: async () => ({ status: 'ENABLED' }),
    } as never);

    await expect(broker.invoke(toolId, input, { workspaceId: 'workspace-1', purpose }))
      .rejects.toEqual(expect.objectContaining<ToolPolicyDenied>({
        name: 'ToolPolicyDenied',
        reason: 'source_policy policy_unavailable: ' + (
          toolId === 'fr-company.search'
            ? 'recherche-entreprises.api.gouv.fr'
            : toolId === 'ror.search'
              ? 'api.ror.org'
            : toolId === 'sec-edgar.company-directory.search'
              ? 'www.sec.gov'
              : toolId === 'sec-edgar.submission.fetch'
                ? 'data.sec.gov'
                : 'npiregistry.cms.hhs.gov'
        ),
      }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seeds ROR, SEC and DENUE fail-closed and keeps runtime adapters explicitly registered', async () => {
    const providerUpsert = vi.fn(async () => ({}));
    const policyUpsert = vi.fn(async () => ({}));
    const registry = new DiscoveryProviderRegistry();
    await registry.seed({
      dataProvider: { upsert: providerUpsert },
      sourcePolicy: { upsert: policyUpsert },
    } as never);

    const providerCreates = providerUpsert.mock.calls.map(([input]) => input.create);
    expect(providerCreates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'fr_company', status: 'ENABLED' }),
      expect.objectContaining({ key: 'nppes', status: 'ENABLED' }),
      expect.objectContaining({ key: 'ror', status: 'DISABLED' }),
      expect.objectContaining({ key: 'sec_edgar', status: 'DISABLED' }),
      expect.objectContaining({ key: 'mexico_denue', status: 'DISABLED' }),
    ]));

    const policyDomains = policyUpsert.mock.calls.map(([input]) => input.create.domain);
    expect(policyDomains).toEqual(expect.arrayContaining([
      'recherche-entreprises.api.gouv.fr',
      'npiregistry.cms.hhs.gov',
      'api.ror.org',
      'www.sec.gov',
      'data.sec.gov',
      'www.inegi.org.mx',
    ]));

    const routed = await registry.routeCompanyDiscovery({
      dataProvider: {
        findMany: vi.fn(async () => [{ key: 'fr_company' }, { key: 'nppes' }, { key: 'ror' }, { key: 'sec_edgar' }, { key: 'mexico_denue' }]),
      },
    } as never, 'company_registry');
    expect(routed.map((provider) => provider.key).filter((key) => ['fr_company', 'nppes', 'ror', 'sec_edgar', 'mexico_denue'].includes(key)))
      .toEqual(['fr_company', 'nppes', 'ror', 'sec_edgar', 'mexico_denue']);
  });
});
