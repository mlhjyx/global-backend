import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAllowedByRobots } from '../../adapters/robots';
import { ToolPolicyDenied } from '../../tools/tool-broker';
import {
  StructuredHarvestProvider,
  fetchSitemapUrls,
  isBuyingRole,
  parseSitemapXml,
  pickCareersUrl,
  pickJobDetailUrls,
  probeCommonCareersPath,
  slugToTitle,
  tallySections,
} from './structured-harvest.provider';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'company-1',
};

describe('结构化收割 · 纯解析器', () => {
  it('sitemap XML：普通 sitemap 抽 <loc>', () => {
    const xml = `<urlset><url><loc>https://acme.de/</loc></url><url><loc>https://acme.de/careers</loc></url></urlset>`;
    const r = parseSitemapXml(xml);
    expect(r.isIndex).toBe(false);
    expect(r.locs).toEqual(['https://acme.de/', 'https://acme.de/careers']);
  });

  it('sitemap XML：sitemap index 识别 + 抽子表', () => {
    const xml = `<sitemapindex><sitemap><loc>https://acme.de/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    const r = parseSitemapXml(xml);
    expect(r.isIndex).toBe(true);
    expect(r.locs).toEqual(['https://acme.de/sitemap-1.xml']);
  });

  it('挑 careers 页：命中招聘词，短路径优先', () => {
    const urls = [
      'https://acme.de/products',
      'https://acme.de/en/company/careers-and-jobs',
      'https://acme.de/careers',
      'https://acme.de/about',
    ];
    expect(pickCareersUrl(urls)).toBe('https://acme.de/careers');
    expect(pickCareersUrl(['https://acme.de/karriere'])).toBe('https://acme.de/karriere');
    expect(pickCareersUrl(['https://acme.de/products'])).toBeUndefined();
  });

  it('站点区块盘点：按一级路径段计数', () => {
    const t = tallySections([
      'https://acme.de/products/a',
      'https://acme.de/products/b',
      'https://acme.de/about',
    ]);
    expect(t.products).toBe(2);
    expect(t.about).toBe(1);
  });

  it('职位详情 URL 识别 + slug → 岗位名', () => {
    const urls = [
      'https://acme.de/careers',
      'https://acme.de/careers/jobs/strategic-sourcing-manager',
      'https://acme.de/en/stellenangebote/senior-einkaeufer-12345',
      'https://acme.de/products/laser',
    ];
    const jobs = pickJobDetailUrls(urls);
    expect(jobs).toHaveLength(2);
    expect(slugToTitle('https://acme.de/careers/jobs/strategic-sourcing-manager')).toBe('strategic sourcing manager');
    expect(slugToTitle('https://acme.de/en/stellenangebote/senior-einkaeufer-12345')).toBe('senior einkaeufer');
    expect(isBuyingRole(slugToTitle('https://acme.de/en/stellenangebote/senior-einkaeufer-12345'))).toBe(true);
  });

  it('采购/供应链岗判定（多语）→ 买家团队扩张信号', () => {
    expect(isBuyingRole('Strategic Sourcing Manager')).toBe(true);
    expect(isBuyingRole('Einkäufer (m/w/d)')).toBe(true);
    expect(isBuyingRole('Head of Procurement')).toBe(true);
    expect(isBuyingRole('Frontend Developer')).toBe(false);
  });
});

describe('StructuredHarvestProvider runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
  });

  it('fails closed for a missing domain or broker', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = new StructuredHarvestProvider();
    await expect(provider.enrichCompany({ name: 'No domain' }, ctx)).resolves.toMatchObject({ matched: false });
    await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({ matched: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broker unavailable'));
    warn.mockRestore();
  });

  it('derives hiring directly from sitemap job URLs without rendering a page', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url: string }) => {
        expect(tool).toBe('http.get');
        if (input.url.endsWith('/robots.txt')) {
          return { data: { ok: true, status: 200, text: 'Sitemap: https://pump.example/sitemap.xml', finalUrl: input.url }, costCents: 0 };
        }
        if (input.url.endsWith('/sitemap.xml')) {
          return { data: {
            ok: true,
            status: 200,
            text: '<urlset><url><loc>https://pump.example/products/p1</loc></url><url><loc>https://pump.example/jobs/strategic-sourcing-manager</loc></url><url><loc>https://pump.example/jobs/frontend-developer</loc></url></urlset>',
            finalUrl: input.url,
          }, costCents: 0 };
        }
        return { data: { ok: false, status: 404, text: '', finalUrl: input.url }, costCents: 0 };
      }),
    };
    const provider = new StructuredHarvestProvider({ broker: broker as any });

    const result = await provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx);

    expect(result).toMatchObject({
      matched: true,
      confidence: 1,
      attributes: {
        sitemap_url_count: 3,
        site_sections: { products: 1, jobs: 2 },
        careers_url: 'https://pump.example/jobs/frontend-developer',
        hiring_signal: {
          source: 'sitemap',
          open_roles: 2,
          has_buying_role: true,
        },
      },
      costCents: 0,
    });
    expect(result.provenance?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(broker.invoke).not.toHaveBeenCalledWith('crawl4ai.render', expect.anything(), expect.anything());
  });

  it('uses a detected ATS board before JobPosting JSON-LD', async () => {
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url: string }) => {
        if (tool === 'crawl4ai.render') {
          return {
            data: {
              html: '<a href="https://jobs.lever.co/pumpco">Open roles</a><script type="application/ld+json">{"@type":"JobPosting","title":"Fallback role"}</script>',
            },
            costCents: 0,
          };
        }
        if (input.url.includes('api.lever.co')) {
          return { data: {
            ok: true,
            status: 200,
            text: JSON.stringify([
              { text: 'Procurement Manager', categories: { department: 'Supply Chain', location: 'Berlin' }, createdAt: 1_700_000_000_000 },
            ]),
            finalUrl: input.url,
          }, costCents: 0 };
        }
        if (input.url.endsWith('/robots.txt')) {
          return { data: { ok: true, status: 200, text: '', finalUrl: input.url }, costCents: 0 };
        }
        if (input.url.endsWith('/sitemap.xml')) {
          return { data: { ok: true, status: 200, text: '<urlset><url><loc>https://pump.example/careers</loc></url></urlset>', finalUrl: input.url }, costCents: 0 };
        }
        return { data: { ok: false, status: 404, text: '', finalUrl: input.url }, costCents: 0 };
      }),
    };
    const provider = new StructuredHarvestProvider({ broker: broker as any });

    const result = await provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx);

    expect(result.attributes).toMatchObject({
      careers_url: 'https://pump.example/careers',
      hiring_signal: {
        source: 'ats:lever',
        open_roles: 1,
        titles: ['Procurement Manager'],
        has_buying_role: true,
      },
    });
  });

  it('keeps sitemap facts but does not render careers when the robots check fails closed', async () => {
    vi.mocked(isAllowedByRobots).mockRejectedValueOnce(new Error('robots unavailable'));
    const broker = {
      invoke: vi.fn(async (tool: string, input: { url: string }) => {
        if (tool === 'crawl4ai.render') {
          return {
            data: {
              html: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Category Buyer"}</script>',
            },
            costCents: 0,
          };
        }
        if (input.url.endsWith('/robots.txt')) return { data: { ok: true, status: 200, text: '', finalUrl: input.url }, costCents: 0 };
        if (input.url.endsWith('/sitemap.xml')) return { data: { ok: true, status: 200, text: '<urlset><url><loc>https://pump.example/careers</loc></url></urlset>', finalUrl: input.url }, costCents: 0 };
        return { data: { ok: false, status: 404, text: '', finalUrl: input.url }, costCents: 0 };
      }),
    };
    const provider = new StructuredHarvestProvider({ broker: broker as any });

    const result = await provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx);

    expect(result.attributes).toMatchObject({
      careers_url: 'https://pump.example/careers',
      sitemap_url_count: 1,
    });
    expect(result.attributes).not.toHaveProperty('hiring_signal');
  });

  it('keeps sitemap facts when careers rendering is blocked or fails', async () => {
    for (const render of [
      { data: { html: '<html>ignored</html>', robotsBlocked: true }, costCents: 0 },
      new Error('render failed'),
    ]) {
      const broker = {
        invoke: vi.fn(async (tool: string, input: { url: string }) => {
          if (tool === 'crawl4ai.render') {
            if (render instanceof Error) throw render;
            return render;
          }
          if (input.url.endsWith('/robots.txt')) return { data: { ok: true, status: 200, text: '', finalUrl: input.url }, costCents: 0 };
          if (input.url.endsWith('/sitemap.xml')) return { data: { ok: true, status: 200, text: '<urlset><url><loc>https://pump.example/careers</loc></url></urlset>', finalUrl: input.url }, costCents: 0 };
          return { data: { ok: false, status: 404, text: '', finalUrl: input.url }, costCents: 0 };
        }),
      };
      const provider = new StructuredHarvestProvider({ broker: broker as any });
      await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({
        matched: true,
        attributes: { sitemap_url_count: 1, careers_url: 'https://pump.example/careers' },
      });
    }
  });

  it('returns a miss when sitemap and common-path probes provide no facts', async () => {
    const broker = {
      invoke: vi.fn(async (_tool: string, input: { url: string }) => ({
        data: { ok: false, status: 404, text: '', finalUrl: input.url },
        costCents: 0,
      })),
    };
    const provider = new StructuredHarvestProvider({ broker: broker as any });
    await expect(provider.enrichCompany({ name: 'Pump', domain: 'pump.example' }, ctx)).resolves.toMatchObject({
      matched: false,
      attributes: {},
    });
  });
});

describe('structured harvest bounded HTTP helpers', () => {
  it('follows bounded same-site sitemap indexes and deduplicates URL entries', async () => {
    const httpGet = vi.fn(async ({ url }: { url: string }) => {
      if (url.endsWith('/robots.txt')) {
        return { ok: true, status: 200, text: [
          'Sitemap: https://acme.de/root.xml',
          'Sitemap: https://outside.example/leak.xml',
        ].join('\n'), finalUrl: url };
      }
      if (url.endsWith('/root.xml')) {
        return { ok: true, status: 200, text: '<sitemapindex><sitemap><loc>https://acme.de/one.xml</loc></sitemap><sitemap><loc>https://outside.example/two.xml</loc></sitemap></sitemapindex>', finalUrl: url };
      }
      if (url.endsWith('/one.xml')) {
        return { ok: true, status: 200, text: '<urlset><url><loc>https://acme.de/products/a</loc></url><url><loc>https://acme.de/products/a</loc></url></urlset>', finalUrl: url };
      }
      return { ok: false, status: 404, text: '', finalUrl: url };
    });
    await expect(fetchSitemapUrls('acme.de', httpGet as any)).resolves.toEqual([
      'https://acme.de/products/a',
    ]);
    expect(httpGet).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://outside.example/leak.xml' }));
  });

  it('probes common careers paths through failures and constrains off-site redirects', async () => {
    const httpGet = vi.fn()
      .mockRejectedValueOnce(new Error('head failed'))
      .mockResolvedValueOnce({ ok: false, status: 404, text: '', finalUrl: 'https://acme.de/en/careers' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: '', finalUrl: 'https://outside.example/jobs' });
    await expect(probeCommonCareersPath('acme.de', httpGet)).resolves.toBe('https://acme.de/career');
    expect(httpGet).toHaveBeenCalledTimes(3);
  });
});

describe('fetchSitemapUrls — terminal policy denial', () => {
  it.each(['suppression_action_gate', 'suspended'])('does not downgrade %s into fallback', async (reason) => {
    const httpGet = vi.fn(async () => {
      throw new ToolPolicyDenied('http.get', reason);
    });

    await expect(fetchSitemapUrls('acme.example', httpGet)).rejects.toThrow(reason);
    expect(httpGet).toHaveBeenCalledOnce();
  });
});
