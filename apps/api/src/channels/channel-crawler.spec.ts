import { describe, expect, it, vi } from 'vitest';
import { crawlChannel } from './channel-crawler';
import { parseChannelConfig, crawlPageUrls, ChannelConfigError } from './channel-config';

const CONFIG = parseChannelConfig('crawl', {
  list: {
    url: 'https://expo.example/exhibitors?page={page}',
    maxPages: 3,
    itemSelector: '.card',
    itemUrlSelector: 'a::attr(href)',
  },
  detail: {
    enabled: true,
    fields: {
      name: 'h1.company',
      website: 'a.site::attr(href)',
      country: '.country',
      products: '.products li',
    },
  },
});

const LIST_1 = `<div class="card"><a href="/exhibitor/acme">Acme</a></div>
<div class="card"><a href="https://expo.example/exhibitor/beta">Beta</a></div>`;
const LIST_2 = `<div class="card"><a href="/exhibitor/gamma">Gamma</a></div>`;
const DETAILS: Record<string, string> = {
  'https://expo.example/exhibitor/acme': `<h1 class="company">Acme Pumpen GmbH</h1><a class="site" href="https://acme-pumpen.de/">site</a><span class="country">Germany</span><ul class="products"><li>Pumpen</li><li>Ventile</li></ul>`,
  'https://expo.example/exhibitor/beta': `<h1 class="company">Beta Werke</h1><a class="site" href="http://beta.example">site</a><span class="country">Austria</span><ul class="products"><li>Armaturen</li></ul>`,
  'https://expo.example/exhibitor/gamma': `<h1 class="company">Gamma AG</h1><span class="country">Switzerland</span>`,
};

function fetcher(pages: Record<string, string>) {
  return vi.fn(async (url: string) => (pages[url] === undefined ? null : { url, html: pages[url]! }));
}

describe('M1 配置驱动通用爬虫 v0', () => {
  it('crawls list pages, opens detail pages and extracts configured fields', async () => {
    const fetchPage = fetcher({
      'https://expo.example/exhibitors?page=1': LIST_1,
      'https://expo.example/exhibitors?page=2': LIST_2,
      ...DETAILS,
    });
    const result = await crawlChannel(CONFIG as never, fetchPage, { pageCap: 20, perRequestDelayMs: 0, sleep: async () => {} });

    expect(result.records.map((record) => record.name).sort()).toEqual([
      'Acme Pumpen GmbH',
      'Beta Werke',
      'Gamma AG',
    ]);
    const acme = result.records.find((record) => record.name.startsWith('Acme'))!;
    expect(acme).toMatchObject({
      website: 'https://acme-pumpen.de/',
      country: 'Germany',
      products: ['Pumpen', 'Ventile'],
      sourceUrl: 'https://expo.example/exhibitor/acme',
    });
    // http 站点的 website 统一升级为 https
    expect(result.records.find((record) => record.name === 'Beta Werke')!.website).toBe('https://beta.example/');
    expect(result.pageFailures).toBe(0);
  });

  it('stops at the page cap and reports truncation', async () => {
    const fetchPage = fetcher({ 'https://expo.example/exhibitors?page=1': LIST_1, ...DETAILS });
    const result = await crawlChannel(CONFIG as never, fetchPage, { pageCap: 2, perRequestDelayMs: 0, sleep: async () => {} });
    expect(result.truncatedByCap).toBe(true);
    expect(result.pagesFetched).toBeLessThanOrEqual(2);
  });

  it('counts page failures instead of aborting the run', async () => {
    const fetchPage = vi.fn(async (url: string) => {
      if (url.endsWith('page=1')) throw new Error('boom');
      if (url.endsWith('page=2')) return { url, html: LIST_2 };
      return DETAILS[url] ? { url, html: DETAILS[url]! } : null;
    });
    const result = await crawlChannel(CONFIG as never, fetchPage, { pageCap: 20, perRequestDelayMs: 0, sleep: async () => {} });
    expect(result.pageFailures).toBeGreaterThanOrEqual(1);
    expect(result.records.map((record) => record.name)).toContain('Gamma AG');
  });

  it('builds page urls from {page} or pageParam', () => {
    expect(crawlPageUrls(CONFIG as never, 2)).toEqual([
      'https://expo.example/exhibitors?page=1',
      'https://expo.example/exhibitors?page=2',
    ]);
    const paramConfig = parseChannelConfig('crawl', {
      list: { url: 'https://expo.example/list?p=1', pageParam: 'p', maxPages: 2, itemSelector: '.card' },
    });
    expect(crawlPageUrls(paramConfig as never, 2)).toEqual([
      'https://expo.example/list?p=1',
      'https://expo.example/list?p=2',
    ]);
  });

  it('rejects unsafe or incomplete crawl configs', () => {
    expect(() => parseChannelConfig('crawl', { list: { url: 'http://expo.example/?page={page}', maxPages: 1, itemSelector: '.x' } })).toThrow(ChannelConfigError);
    expect(() => parseChannelConfig('crawl', { list: { url: 'https://expo.example/?page={page}', maxPages: 99, itemSelector: '.x' } })).toThrow(ChannelConfigError);
    expect(() => parseChannelConfig('crawl', { list: { url: 'https://expo.example/list', maxPages: 1, itemSelector: '.x' } })).toThrow(/pageParam/);
    expect(() => parseChannelConfig('crawl', { list: { url: 'https://e.example/?page={page}', maxPages: 1, itemSelector: '.x' }, detail: { enabled: true, fields: { fax: '.fax' } } })).toThrow(/channel field/);
  });

  it('only accepts contact fields in detail-page mode (enabled + itemUrlSelector)', () => {
    // detail 未启用：拒绝。
    expect(() => parseChannelConfig('crawl', { list: { url: 'https://e.example/?page={page}', maxPages: 1, itemSelector: '.x', itemUrlSelector: 'a' }, detail: { enabled: false, fields: { email: '.mail' } } })).toThrow(/detail-page mode/);
    // 详情启用但无 itemUrlSelector：同样拒绝（没有逐条详情就没有可信的字段作用域）。
    expect(() => parseChannelConfig('crawl', { list: { url: 'https://e.example/?page={page}', maxPages: 1, itemSelector: '.x' }, detail: { enabled: true, fields: { email: '.mail' } } })).toThrow(/detail-page mode/);
    // 完整详情模式：允许全部联系人字段。
    expect(() => parseChannelConfig('crawl', {
      list: { url: 'https://e.example/?page={page}', maxPages: 1, itemSelector: '.x', itemUrlSelector: 'a' },
      detail: { enabled: true, fields: { contactName: '.name', contactTitle: '.title', email: '.mail', phone: '.tel' } },
    })).not.toThrow();
  });

  it('extracts contact fields from detail pages only, with PII cleaning', async () => {
    const config = parseChannelConfig('crawl', {
      list: { url: 'https://expo.example/exhibitors?page={page}', maxPages: 1, itemSelector: '.card', itemUrlSelector: 'a::attr(href)' },
      detail: { enabled: true, fields: { name: 'h1.company', contactName: '.cname', contactTitle: '.ctitle', email: '.mail', phone: '.tel' } },
    });
    const fetchPage = fetcher({
      'https://expo.example/exhibitors?page=1': '<div class="card"><a href="/exhibitor/acme">Acme</a></div>',
      'https://expo.example/exhibitor/acme': '<h1 class="company">Acme Pumpen GmbH</h1><span class="cname">Max Mustermann</span><span class="ctitle">Sales Manager</span><span class="mail"> Sales@Acme-Pumpen.DE </span><span class="tel"> +49 30 123456 </span>',
    });
    const result = await crawlChannel(config, fetchPage, { pageCap: 5, perRequestDelayMs: 0, sleep: async () => {} });
    expect(result.records[0]).toMatchObject({
      name: 'Acme Pumpen GmbH',
      contactName: 'Max Mustermann',
      contactTitle: 'Sales Manager',
      email: 'sales@acme-pumpen.de',
      phone: '+49 30 123456',
    });
  });

  it('never extracts contact fields from list-page fallback (defense in depth)', async () => {
    const config = parseChannelConfig('crawl', {
      list: { url: 'https://expo.example/exhibitors?page={page}', maxPages: 1, itemSelector: '.card', itemUrlSelector: 'a::attr(href)' },
      detail: { enabled: true, fields: { name: 'h1.company', email: '.mail' } },
    });
    // 绕过校验器直接构造 detail.enabled=false 的退化配置，验证爬虫层兜底：列表页回退不抽联系人字段。
    const degraded = { ...config, detail: { enabled: false, fields: config.detail.fields } };
    const fetchPage = fetcher({
      'https://expo.example/exhibitors?page=1': '<div class="card"><a href="/exhibitor/acme">Acme Co</a></div><span class="mail">x@y.z</span>',
    });
    const result = await crawlChannel(degraded as never, fetchPage, { pageCap: 1, perRequestDelayMs: 0, sleep: async () => {} });
    expect(result.records[0]!.email).toBeUndefined();
  });
});
