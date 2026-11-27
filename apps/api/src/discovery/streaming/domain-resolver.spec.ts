import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ExecutionBroker } from '../../tools/tool-contract';
import {
  buildDomainLookupQuery,
  extractDomainFromAttributes,
  isExcludedOfficialHost,
  pickOfficialDomainFromSearchResults,
  resolveMissingCompanyDomain,
} from './domain-resolver';

const WORKSPACE_ID = '10000000-0000-4000-8000-000000000001';
const COMPANY_ID = '20000000-0000-4000-8000-000000000002';

function makePrisma(updateResult: () => Promise<{ count: number }>) {
  const updateMany = vi.fn(updateResult);
  const prisma = {
    withWorkspace: vi.fn(async (_ws: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ canonicalCompany: { updateMany } }),
    ),
  } as unknown as PrismaService;
  return { prisma, updateMany };
}

describe('L0.5 domain-resolver pure helpers', () => {
  it('excludes social networks, registries, directories, and industry news portals', () => {
    expect(isExcludedOfficialHost('linkedin.com')).toBe(true);
    expect(isExcludedOfficialHost('www.northdata.de')).toBe(true);
    expect(isExcludedOfficialHost('find-and-update.company-information.service.gov.uk')).toBe(true);
    expect(isExcludedOfficialHost('enfsolar.com')).toBe(true);
    expect(isExcludedOfficialHost('intersolar.de')).toBe(true);
    expect(isExcludedOfficialHost('app.fieldwire.com')).toBe(true);
    expect(isExcludedOfficialHost('docs.example.com')).toBe(true);
    expect(isExcludedOfficialHost('alpha-ess.de')).toBe(false);
    expect(isExcludedOfficialHost('solarparken.com')).toBe(false);
  });

  it('extracts official website domain from company attributes while ignoring directory URLs', () => {
    expect(extractDomainFromAttributes({ website: 'https://www.alpha-ess.de/en' })).toBe('alpha-ess.de');
    expect(extractDomainFromAttributes({ raw: { homepage: 'https://solarparken.com' } })).toBe('solarparken.com');
    expect(extractDomainFromAttributes({ url: 'https://www.linkedin.com/company/alphaess' })).toBeNull();
    expect(extractDomainFromAttributes({ source_kind: 'directory' })).toBeNull();
  });

  it('builds localized lookup queries with country hints', () => {
    expect(buildDomainLookupQuery('Alpha Ess Europe GmbH', 'DE')).toBe(
      '"Alpha Ess Europe GmbH" Germany official website',
    );
    expect(buildDomainLookupQuery('琏升科技股份有限公司', 'CN')).toBe('琏升科技股份有限公司 官网');
  });

  it('picks official corporate domains and ignores directories for real buyer patterns', () => {
    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.northdata.de/Alpha+ESS+Europe+GmbH', title: 'Alpha ESS Europe GmbH - North Data' },
          { url: 'https://www.linkedin.com/company/alphaess', title: 'Alpha ESS Europe GmbH | LinkedIn' },
          { url: 'https://www.alpha-ess.de/', title: 'AlphaESS Europe GmbH - Energy Storage' },
        ],
        'Alpha Ess Europe GmbH',
        'DE',
      ),
    ).toBe('alpha-ess.de');

    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.enfsolar.com/7c-solarparken', title: '7C Solarparken NV' },
          { url: 'https://www.solarparken.com/', title: '7C Solarparken AG - Solar Power Plants' },
        ],
        '7C SOLARPARKEN NV',
        'DE',
      ),
    ).toBe('solarparken.com');

    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.field.energy/', title: 'Field Deutschland - Grid-scale Battery Storage' },
          { url: 'https://www.pv-magazine.com/2026/field-deutschland', title: 'Field Deutschland GmbH builds BESS' },
        ],
        'Field Deutschland GmbH',
        'DE',
      ),
    ).toBe('field.energy');
  });

  it('returns null when search results contain only unrelated sites, app subdomains, or partial-word collisions', () => {
    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.europages.com/some-company', title: 'Some Solar GmbH' },
          { url: 'https://www.randomblog.org/article/solar-trends', title: 'Solar market news 2026' },
        ],
        'BHFM Technologies GMBH',
        'DE',
      ),
    ).toBeNull();

    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.procarton.com/sitemap/', title: 'Pro Carton' },
          { url: 'https://app.fieldwire.com/login', title: 'Fieldwire Construction App' },
          { url: 'https://www.fieldwire.com/', title: 'Fieldwire Construction Management' },
        ],
        'Field Deutschland GmbH',
        'DE',
      ),
    ).toBeNull();

    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://www.dispatchit.com/company/locations', title: 'DispatchIt Delivery' },
          { url: 'https://work.dispatch.me/', title: 'Dispatch Work Portal' },
        ],
        'Dispatch B.V.',
        'NL',
      ),
    ).toBeNull();
  });

  it('prefers top-ranked multi-hit industry match over low-ranked generic newspaper domain', () => {
    const filler = Array.from({ length: 8 }, (_, idx) => ({
      url: `https://unrelated-${idx}.org/page`,
      title: `Unrelated ${idx}`,
    }));
    expect(
      pickOfficialDomainFromSearchResults(
        [
          { url: 'https://dispatchgridservices.com/projects', title: 'Dispatch Grid Services - Projects' },
          { url: 'https://www.dispatchgridservices.com/', title: 'Dispatch Grid Services - Battery Storage' },
          { url: 'https://dispatchgridservices.com/about', title: 'About Dispatch' },
          ...filler,
          { url: 'https://www.dispatch.com/', title: 'The Columbus Dispatch' },
        ],
        'Dispatch B.V.',
        'NL',
      ),
    ).toBe('dispatchgridservices.com');
  });
});

describe('resolveMissingCompanyDomain', () => {
  it('short-circuits when company already has a domain without invoking broker', async () => {
    const broker = { invoke: vi.fn() } as unknown as ExecutionBroker;
    const { prisma, updateMany } = makePrisma(async () => ({ count: 1 }));
    const res = await resolveMissingCompanyDomain({
      broker,
      prisma,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runAccountKey: 'run-1',
      company: { name: 'Alpha Ess', domain: 'alpha-ess.de', country: 'DE', attributes: {} },
    });
    expect(res).toEqual({ domain: 'alpha-ess.de', source: 'existing' });
    expect(broker.invoke).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('resolves via searxng.search, persists safely, and skips search when unauthorized', async () => {
    const broker = {
      invoke: vi.fn(async () => ({
        data: {
          results: [
            { url: 'https://www.northdata.de/Alpha+ESS', title: 'Alpha ESS Europe GmbH' },
            { url: 'https://www.alpha-ess.de/', title: 'Alpha ESS Europe GmbH' },
          ],
        },
      })),
    } as unknown as ExecutionBroker;
    const { prisma, updateMany } = makePrisma(async () => ({ count: 1 }));

    const denied = await resolveMissingCompanyDomain({
      broker,
      prisma,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runAccountKey: 'run-1',
      company: { name: 'Alpha Ess Europe GmbH', domain: null, country: 'DE', attributes: {} },
      authorizeExternalAction: async () => false,
    });
    expect(denied).toEqual({ domain: null, source: 'none' });
    expect(broker.invoke).not.toHaveBeenCalled();

    const ok = await resolveMissingCompanyDomain({
      broker,
      prisma,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runAccountKey: 'run-1',
      company: { name: 'Alpha Ess Europe GmbH', domain: null, country: 'DE', attributes: {} },
      authorizeExternalAction: async () => true,
    });
    expect(ok).toEqual({ domain: 'alpha-ess.de', source: 'searxng' });
    expect(broker.invoke).toHaveBeenCalledWith(
      'searxng.search',
      { q: '"Alpha Ess Europe GmbH" Germany official website', categories: ['general'] },
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        taskContractId: 'discovery.extract_company',
        purpose: ['discovery'],
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: COMPANY_ID, domain: null, status: { not: 'SUPPRESSED' } },
        data: { domain: 'alpha-ess.de', version: { increment: 1 } },
      }),
    );
  });

  it('handles workspace domain unique constraint (P2002) cleanly without throwing', async () => {
    const broker = { invoke: vi.fn() } as unknown as ExecutionBroker;
    const { prisma } = makePrisma(async () => {
      const err = new Error('Unique constraint failed');
      (err as { code?: string }).code = 'P2002';
      throw err;
    });
    const res = await resolveMissingCompanyDomain({
      broker,
      prisma,
      workspaceId: WORKSPACE_ID,
      companyId: COMPANY_ID,
      runAccountKey: 'run-1',
      company: {
        name: 'Alpha Ess Europe GmbH',
        domain: null,
        country: 'DE',
        attributes: { website: 'https://www.alpha-ess.de' },
      },
    });
    expect(res).toEqual({ domain: null, source: 'conflict' });
  });
});
