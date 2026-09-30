import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({ isAllowedByRobots: vi.fn(async () => true) }));

import {
  StructuredHarvestProvider,
  fetchSitemapUrls,
  parseSitemapXml,
  pickCareersUrl,
  tallySections,
  isBuyingRole,
  pickJobDetailUrls,
  slugToTitle,
} from './structured-harvest.provider';
import { ToolPolicyDenied } from '../../tools/tool-broker';
import type { HttpGetInput, HttpGetOutput } from '../../tools/source-tools';
import {
  MAX_SITEMAP_HTTP_GETS,
  MAX_SITEMAP_ROOTS,
  MAX_STRUCTURED_HARVEST_HTTP_GETS,
  MAX_STRUCTURED_HARVEST_RENDERS,
} from '../execution-envelope';

/** A site that maximizes wires: many advertised sitemaps, big indexes, no careers URL in any sitemap. */
function adversarialSite(url: string): HttpGetOutput {
  const text = (body: string): HttpGetOutput => ({ status: 200, ok: true, mediaType: 'text/plain', text: body });
  if (url.endsWith('/robots.txt')) {
    return text(Array.from({ length: 10 }, (_, i) => `Sitemap: https://acme.example/root-${i}.xml`).join('\n'));
  }
  if (url.includes('/root-') || url.endsWith('/sitemap.xml') || url.endsWith('/sitemap_index.xml')) {
    return text(`<sitemapindex>${Array.from({ length: 10 }, (_, i) =>
      `<sitemap><loc>https://acme.example/child-${i}.xml</loc></sitemap>`).join('')}</sitemapindex>`);
  }
  if (url.includes('/child-')) return text('<urlset><url><loc>https://acme.example/about</loc></url></urlset>');
  if (url.endsWith('/company/careers')) return { status: 200, ok: true, mediaType: 'text/plain', text: '' };
  if (url.includes('greenhouse')) return text('{"jobs":[]}');
  return { status: 404, ok: false, mediaType: 'text/plain', text: '' };
}

describe('structured harvest — bounded physical reads (G2 quote)', () => {
  it('reads robots.txt, at most MAX_SITEMAP_ROOTS roots and a bounded number of children', async () => {
    const httpGet = vi.fn(async (input: HttpGetInput) => adversarialSite(input.url));

    await fetchSitemapUrls('acme.example', httpGet);

    const urls = httpGet.mock.calls.map(([input]) => input.url);
    expect(urls.filter((url) => url.includes('/root-'))).toHaveLength(MAX_SITEMAP_ROOTS);
    expect(urls.length).toBeLessThanOrEqual(MAX_SITEMAP_HTTP_GETS);
  });

  it('never exceeds the quoted per-company http.get and render ceilings', async () => {
    const invoke = vi.fn(async (toolId: string, input: { url: string }) => {
      if (toolId === 'http.get') return { data: adversarialSite(input.url) };
      if (toolId === 'crawl4ai.render') {
        return { data: { html: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>' } };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });

    await new StructuredHarvestProvider({ broker: { invoke } as never }).enrichCompany(
      { companyId: 'c1', name: 'Acme', domain: 'acme.example' } as never,
      { workspaceId: '00000000-0000-4000-8000-0000000000a1' },
    );

    const tools = invoke.mock.calls.map(([toolId]) => toolId);
    expect(tools.filter((toolId) => toolId === 'crawl4ai.render')).toHaveLength(MAX_STRUCTURED_HARVEST_RENDERS);
    expect(tools.filter((toolId) => toolId === 'http.get').length).toBeLessThanOrEqual(
      MAX_STRUCTURED_HARVEST_HTTP_GETS,
    );
    // The adversarial site forces every probe path, so the bound is tight.
    expect(tools.filter((toolId) => toolId === 'http.get')).toHaveLength(MAX_STRUCTURED_HARVEST_HTTP_GETS);
  });
});

describe('fetchSitemapUrls — terminal suppression denial', () => {
  it('does not retry roots or children after the action gate denies a physical request', async () => {
    const httpGet = vi.fn(async () => {
      throw new ToolPolicyDenied('http.get', 'suppression_action_gate');
    });

    await expect(fetchSitemapUrls('acme.example', httpGet)).rejects.toThrow(/suppression_action_gate/);
    expect(httpGet).toHaveBeenCalledOnce();
  });

  it('does not downgrade a machine source-policy denial into sitemap fallback', async () => {
    const httpGet = vi.fn(async () => {
      throw new ToolPolicyDenied('http.get', 'suspended');
    });

    await expect(fetchSitemapUrls('acme.example', httpGet)).rejects.toThrow(/suspended/);
    expect(httpGet).toHaveBeenCalledOnce();
  });
});

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
    const t = tallySections(['https://acme.de/products/a', 'https://acme.de/products/b', 'https://acme.de/about']);
    expect(t.products).toBe(2);
    expect(t.about).toBe(1);
  });

  it('站点区块盘点：只产出有界且非联系/密钥的闭集一级路径段', () => {
    const sections = tallySections([
      'https://acme.example/products/a',
      'https://acme.example/products/b',
      'https://acme.example/about',
      'https://acme.example/.well-known/security.txt',
      'https://acme.example/source/a',
      'https://acme.example/notice/a',
      'https://acme.example/contact/a',
      'https://acme.example/person@example.test/a',
      'https://acme.example/555-0100/a',
      'https://acme.example/%D9%A5%D9%A5%D9%A5-%D9%A0%D9%A1%D9%A0%D9%A0/a',
      'https://acme.example/bearer-secret/a',
      'https://acme.example/%70roducts/a',
      `https://acme.example/${'x'.repeat(25)}/a`,
      'https://acme.example/Ａbout/a',
    ]);

    // Hand-fixed bytes: this expectation does not call the stored-value
    // sanitizer or derive an allow-list from production code.
    expect(JSON.stringify(sections)).toBe('{".well-known":1,"about":1,"products":2}');
  });

  it('站点区块盘点：输出最多 20 个 key，单 key 计数最多 5000', () => {
    const closedSectionUrls = [
      '.well-known',
      'about',
      'blog',
      'careers',
      'company',
      'docs',
      'downloads',
      'events',
      'industries',
      'insights',
      'jobs',
      'news',
      'partners',
      'press',
      'products',
      'publications',
      'resources',
      'services',
      'solutions',
      'support',
      'sustainability',
      'technology',
    ].map((section) => `https://acme.example/${section}/index.html`);
    const boundedKeys = tallySections(closedSectionUrls);
    expect(Object.keys(boundedKeys)).toHaveLength(20);
    expect(boundedKeys).not.toHaveProperty('sustainability');
    expect(boundedKeys).not.toHaveProperty('technology');

    const boundedCount = tallySections(
      Array.from({ length: 5001 }, (_, index) => `https://acme.example/products/${index}`),
    );
    expect(boundedCount).toEqual({ products: 5000 });
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
