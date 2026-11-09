import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CHANGEDETECTION,
  PROVIDER_RSS,
  attributeCompany,
  buildSignalRow,
  chooseCompanyMatch,
  hostnameOfUrl,
  ingestCompanySignals,
  ingestKeyFor,
  parseChangedetectionWatches,
  parseRssFeed,
  persistSignalRows,
  registrableDomain,
  resolveRssUrl,
  signalFingerprint,
  stripHtml,
  type CompanySignalCreateInput,
  type CompanySignalStore,
  type SignalCompanyRecord,
  type SignalFetch,
} from './company-signals';

const RSS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Nees Pumpen News</title>
    <link>https://www.nees-pumpen.de</link>
    <item>
      <title><![CDATA[Nees Pumpen <b>News</b>]]></title>
      <link>https://www.nees-pumpen.de/news/neue-pumpe</link>
      <description><![CDATA[<p>Neue <b>Pumpe</b> &amp; Zubehör</p>]]></description>
      <pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Ohne Datum</title>
      <link>https://biergangs.de/karriere</link>
    </item>
    <item>
      <title>Ohne Link</title>
      <pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Festool</title>
  <entry>
    <title>Neue Produktlinie</title>
    <link rel="self" href="https://rsshub.example/self"/>
    <link rel="alternate" href="https://www.festool.de/produkte/neu"/>
    <updated>2026-11-10T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Pumpen &amp;amp; Zubehör&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Ohne Link</title>
    <updated>2026-11-10T08:00:00Z</updated>
  </entry>
</feed>`;

describe('parseRssFeed —— RSS2（CDATA / 缺失字段宽容）', () => {
  it('解析标题（CDATA）、链接、描述（去 HTML）、pubDate；缺 title/link 的条目计入 dropped', () => {
    const feed = parseRssFeed(RSS_XML);
    expect(feed.dropped).toBe(1);
    expect(feed.items).toHaveLength(2);
    const [first, second] = feed.items;
    expect(first).toMatchObject({
      providerKey: PROVIDER_RSS,
      signalKind: 'rss_item',
      sourceUrl: 'https://www.nees-pumpen.de/news/neue-pumpe',
      title: 'Nees Pumpen News',
      excerpt: 'Neue Pumpe & Zubehör',
    });
    expect(first!.observedAt.toISOString()).toBe('2026-11-10T09:30:00.000Z');
    // 缺 pubDate：稳定兜底 epoch 0（重跑同指纹，不随时间漂移）。
    expect(second!.observedAt.getTime()).toBe(0);
    expect(second!.excerpt).toBeNull();
  });

  it('非 RSS/Atom 文档返回空集而不抛错（错误页/JSON 由调用方按 parsed=0 观察）', () => {
    expect(parseRssFeed('<html><body>error</body></html>').items).toEqual([]);
    expect(parseRssFeed('not xml at all').items).toEqual([]);
  });

  it('单条 item（非数组）也能解析', () => {
    const xml = '<rss><channel><item><title>T</title><link>https://a.example/x</link></item></channel></rss>';
    expect(parseRssFeed(xml).items).toHaveLength(1);
  });
});

describe('parseRssFeed —— Atom（link href / updated / summary）', () => {
  it('取 rel=alternate 的 href，解析 updated 与 html summary；缺 link 的条目计入 dropped', () => {
    const feed = parseRssFeed(ATOM_XML);
    expect(feed.dropped).toBe(1);
    expect(feed.items).toHaveLength(1);
    const [item] = feed.items;
    expect(item).toMatchObject({
      providerKey: PROVIDER_RSS,
      signalKind: 'rss_item',
      sourceUrl: 'https://www.festool.de/produkte/neu',
      title: 'Neue Produktlinie',
      excerpt: 'Pumpen & Zubehör',
    });
    expect(item!.observedAt.toISOString()).toBe('2026-11-10T08:00:00.000Z');
  });
});

describe('parseChangedetectionWatches —— watch 列表映射（last_changed>0）', () => {
  it('对象按 uuid 键：last_changed epoch 秒 → observedAt；从未变更/缺 title 的处理', () => {
    const feed = parseChangedetectionWatches({
      '11111111-1111-1111-1111-111111111111': {
        url: 'https://biergangs.de/karriere',
        title: 'Karriere',
        last_changed: 1762700000,
      },
      '22222222-2222-2222-2222-222222222222': {
        url: 'https://festool.de/neu',
        title: '',
        last_changed: 1762700100,
      },
      '33333333-3333-3333-3333-333333333333': {
        url: 'https://nees-pumpen.de',
        title: 'Nees',
        last_changed: 0,
      },
    });
    expect(feed.dropped).toBe(0);
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      providerKey: PROVIDER_CHANGEDETECTION,
      signalKind: 'page_change',
      sourceUrl: 'https://biergangs.de/karriere',
      title: 'Karriere',
      excerpt: null,
    });
    expect(feed.items[0]!.observedAt.toISOString()).toBe('2025-11-09T14:53:20.000Z');
    // title 为空 → 回退 url；last_changed=0（从未变更）不是信号。
    expect(feed.items[1]!.title).toBe('https://festool.de/neu');
  });

  it('数组形态与畸形成员（缺 url 计入 dropped）', () => {
    const feed = parseChangedetectionWatches([
      { url: 'https://a.example/x', title: 'A', last_changed: 1700000000 },
      { title: 'no url', last_changed: 1700000000 },
    ]);
    expect(feed.items).toHaveLength(1);
    expect(feed.dropped).toBe(1);
  });
});

describe('signalFingerprint / ingestKeyFor —— 指纹稳定与去重键', () => {
  const observedAt = new Date('2026-11-10T09:30:00.000Z');

  it('同 provider/url/title/秒 → 同 sha256 hex；毫秒不参与', () => {
    const a = signalFingerprint(PROVIDER_RSS, 'https://a.example/x', 'T', observedAt);
    const b = signalFingerprint(
      PROVIDER_RSS,
      'https://a.example/x',
      'T',
      new Date('2026-11-10T09:30:00.999Z'),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ingestKeyFor(PROVIDER_RSS, a)).toBe(`${PROVIDER_RSS}:${a}`);
  });

  it('任一字段不同（provider/url/title/秒）→ 指纹不同', () => {
    const base = signalFingerprint(PROVIDER_RSS, 'https://a.example/x', 'T', observedAt);
    expect(signalFingerprint(PROVIDER_CHANGEDETECTION, 'https://a.example/x', 'T', observedAt)).not.toBe(base);
    expect(signalFingerprint(PROVIDER_RSS, 'https://a.example/y', 'T', observedAt)).not.toBe(base);
    expect(signalFingerprint(PROVIDER_RSS, 'https://a.example/x', 'T2', observedAt)).not.toBe(base);
    expect(
      signalFingerprint(PROVIDER_RSS, 'https://a.example/x', 'T', new Date('2026-11-10T09:30:01.000Z')),
    ).not.toBe(base);
  });
});

describe('域名归因 —— 精确 / 子域 / 同注册域 / 无匹配', () => {
  it('hostnameOfUrl：去 www、小写；非 http(s)/非法 URL → null', () => {
    expect(hostnameOfUrl('https://www.Nees-Pumpen.de/news')).toBe('nees-pumpen.de');
    expect(hostnameOfUrl('not a url')).toBeNull();
    expect(hostnameOfUrl('ftp://example.com/x')).toBeNull();
  });

  it('registrableDomain：两级公开后缀取三段', () => {
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.example.de')).toBe('example.de');
    expect(registrableDomain('example.de')).toBe('example.de');
    expect(registrableDomain('192.168.1.1')).toBeNull();
  });

  it('chooseCompanyMatch：精确 > 子域 > 同注册域；无匹配 → null', () => {
    const companies: SignalCompanyRecord[] = [
      { id: 'parent', domain: 'example.de' },
      { id: 'exact', domain: 'shop.example.de' },
      { id: 'unrelated', domain: 'other.com' },
    ];
    // 精确（rank 0）压过父域。
    expect(chooseCompanyMatch('shop.example.de', companies)).toBe('exact');
    // 信号 host 是公司域的子域（rank 1）。
    expect(chooseCompanyMatch('news.example.de', companies)).toBe('parent');
    // 同注册域的兄弟子域（rank 2）。
    expect(chooseCompanyMatch('shop.example.de', [{ id: 'www', domain: 'www.example.de' }])).toBe('www');
    // 公司域比信号 host 更具体（rank 3）。
    expect(chooseCompanyMatch('example.de', [{ id: 'shop', domain: 'shop.example.de' }])).toBe('shop');
    expect(chooseCompanyMatch('unknown.example.org', companies)).toBeNull();
    // 空/非法域名不参与。
    expect(chooseCompanyMatch('shop.example.de', [{ id: 'x', domain: null }])).toBeNull();
  });

  it('attributeCompany：显式 workspaceId + 候选（host/注册域/www 变体）预过滤，结果再收口', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const rows: SignalCompanyRecord[] = [
      { id: 'parent', domain: 'example.de' },
      { id: 'exact', domain: 'shop.example.de' },
    ];
    const store = {
      canonicalCompany: {
        async findMany(args: Record<string, unknown>) {
          captured.push(args);
          return rows;
        },
      },
    } as unknown as CompanySignalStore;
    await expect(
      attributeCompany(store, 'ws-1', 'shop.example.de'),
    ).resolves.toBe('exact');
    const where = captured[0]!.where as {
      workspaceId: string;
      OR: Array<Record<string, unknown>>;
    };
    expect(where.workspaceId).toBe('ws-1');
    const serialized = JSON.stringify(where.OR);
    expect(serialized).toContain('shop.example.de');
    expect(serialized).toContain('.shop.example.de');
    expect(serialized).toContain('www.shop.example.de');
  });
});

describe('persistSignalRows —— 幂等写入（批内去重 + skipDuplicates 忽略冲突）', () => {
  function fakeStore() {
    const keys = new Set<string>();
    const inserted: CompanySignalCreateInput[] = [];
    const store: CompanySignalStore = {
      canonicalCompany: { async findMany() { return []; } },
      companySignal: {
        async createMany({ data, skipDuplicates }) {
          let count = 0;
          for (const row of data) {
            if (skipDuplicates && keys.has(row.ingestKey)) continue;
            keys.add(row.ingestKey);
            inserted.push(row);
            count += 1;
          }
          return { count };
        },
      },
    };
    return { store, inserted };
  }

  const item = {
    providerKey: PROVIDER_RSS,
    signalKind: 'rss_item' as const,
    sourceUrl: 'https://a.example/x',
    title: 'T',
    excerpt: null,
    observedAt: new Date('2026-11-10T09:30:00.000Z'),
  };

  it('同一批重复指纹只插一条；再跑一遍全部跳过；行带 workspaceId 与 64 位指纹', async () => {
    const { store, inserted } = fakeStore();
    const row = buildSignalRow(item, 'c1');
    const first = await persistSignalRows(store, 'ws-1', [row, row]);
    expect(first).toEqual({ inserted: 1, skipped: 1 });
    expect(inserted[0]).toMatchObject({ workspaceId: 'ws-1', companyId: 'c1' });
    expect(inserted[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const rerun = await persistSignalRows(store, 'ws-1', [row]);
    expect(rerun).toEqual({ inserted: 0, skipped: 1 });
  });
});

describe('ingestCompanySignals —— 编排（fetch 注入，不触网）', () => {
  function fakeCompanyStore(companies: SignalCompanyRecord[]) {
    const keys = new Set<string>();
    const inserted: CompanySignalCreateInput[] = [];
    const store: CompanySignalStore = {
      canonicalCompany: { async findMany() { return companies; } },
      companySignal: {
        async createMany({ data, skipDuplicates }) {
          let count = 0;
          for (const row of data) {
            if (skipDuplicates && keys.has(row.ingestKey)) continue;
            keys.add(row.ingestKey);
            inserted.push(row);
            count += 1;
          }
          return { count };
        },
      },
    };
    return { store, inserted };
  }

  const WATCHES = {
    'aaaa': { url: 'https://biergangs.de/karriere', title: 'Karriere', last_changed: 1762700000 },
    'bbbb': { url: 'https://unbewegt.de/x', title: 'Nie geändert', last_changed: 0 },
  };

  function fakeFetch(): { impl: SignalFetch; calls: string[] } {
    const calls: string[] = [];
    const impl: SignalFetch = async (input) => {
      calls.push(input);
      if (input.endsWith('/api/v1/watch')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(WATCHES) };
      }
      if (input === 'http://127.0.0.1:1200/github/issue/a/b') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            `<rss><channel>
              <item><title>Nees News</title><link>https://www.nees-pumpen.de/news</link><pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate></item>
              <item><title>Unbekannt</title><link>https://unknown.example.com/x</link></item>
            </channel></rss>`,
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    };
    return { impl, calls };
  }

  it('RSS 路由 + watches：解析/归因/入库计数，重跑全跳过', async () => {
    const companies: SignalCompanyRecord[] = [
      { id: 'c-nees', domain: 'nees-pumpen.de' },
      { id: 'c-bier', domain: 'biergangs.de' },
    ];
    const { store } = fakeCompanyStore(companies);
    const fetchState = fakeFetch();
    const options = {
      store,
      workspaceId: 'ws-1',
      rssRoutes: ['github/issue/a/b'],
      includeWatchChanges: true,
      changeDetectionApiKey: 'test-key',
      fetchImpl: fetchState.impl,
    };

    const first = await ingestCompanySignals(options);
    expect(fetchState.calls).toContain('http://127.0.0.1:1200/github/issue/a/b');
    expect(fetchState.calls).toContain('http://127.0.0.1:5055/api/v1/watch');
    // 3 条信号：RSS 2（1 条归因）+ watch 1（1 条归因）；从未变更的 watch 不是信号。
    expect(first).toMatchObject({ inserted: 3, skipped: 0, matched: 2 });
    expect(first.sources.map((source) => source.source)).toEqual([
      'rss:github/issue/a/b',
      'changedetection',
    ]);
    expect(first.sources.every((source) => source.error === null)).toBe(true);

    const second = await ingestCompanySignals(options);
    expect(second).toMatchObject({ inserted: 0, skipped: 3, matched: 2 });
  });

  it('源级失败报错但不吞其它源（error 写进 source 报告）', async () => {
    const { store } = fakeCompanyStore([]);
    const impl: SignalFetch = async (input) => {
      if (input.endsWith('/api/v1/watch')) {
        return { ok: false, status: 401, text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          '<rss><channel><item><title>T</title><link>https://a.example/x</link><pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate></item></channel></rss>',
      };
    };
    const summary = await ingestCompanySignals({
      store,
      workspaceId: 'ws-1',
      rssRoutes: ['r'],
      includeWatchChanges: true,
      changeDetectionApiKey: 'k',
      fetchImpl: impl,
    });
    expect(summary.inserted).toBe(1);
    const watch = summary.sources.find((source) => source.source === 'changedetection')!;
    expect(watch.error).toContain('401');
    expect(watch.inserted).toBe(0);
  });

  it('--include-watch-changes 缺 API key → 该源报错，不发起请求', async () => {
    const { store } = fakeCompanyStore([]);
    let called = 0;
    const impl: SignalFetch = async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const summary = await ingestCompanySignals({
      store,
      workspaceId: 'ws-1',
      includeWatchChanges: true,
      fetchImpl: impl,
    });
    expect(called).toBe(0);
    expect(summary.sources[0]!.error).toContain('CHANGE_DETECTION_API_KEY');
  });
});

describe('resolveRssUrl / stripHtml', () => {
  it('route 拼 RSSHub 基址；完整 URL 原样', () => {
    expect(resolveRssUrl('github/issue/a/b', 'http://127.0.0.1:1200')).toBe(
      'http://127.0.0.1:1200/github/issue/a/b',
    );
    expect(resolveRssUrl('/rss/x', 'http://127.0.0.1:1200/')).toBe('http://127.0.0.1:1200/rss/x');
    expect(resolveRssUrl('https://example.com/feed.xml', 'http://127.0.0.1:1200')).toBe(
      'https://example.com/feed.xml',
    );
  });

  it('stripHtml：去标签、解实体、截断', () => {
    expect(stripHtml('<p>A &amp; B</p>')).toBe('A & B');
    expect(stripHtml('x'.repeat(600), 500)).toHaveLength(500);
    expect(stripHtml('<b></b>')).toBe('');
  });
});
