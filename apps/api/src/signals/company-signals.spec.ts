import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CHANGEDETECTION,
  PROVIDER_RSS,
  attributeCompany,
  buildSignalRow,
  chooseCompanyMatch,
  hostnameOfUrl,
  ingestKeyFor,
  parseChangedetectionWatches,
  parseRssFeed,
  persistCollectedSource,
  persistSignalRows,
  registrableDomain,
  signalFingerprint,
  stripHtml,
  summarizeSignalReports,
  type CollectedSignalSource,
  type CompanySignalCreateInput,
  type CompanySignalStore,
  type SignalCompanyRecord,
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

describe('parseRssFeed —— RSS2（CDATA / 缺失字段宽容 / recognized）', () => {
  it('解析标题（CDATA）、链接、描述（去 HTML）、pubDate；缺 title/link 的条目计入 dropped', () => {
    const feed = parseRssFeed(RSS_XML);
    expect(feed.recognized).toBe(true);
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

  it('非 RSS/Atom 文档返回空集且 recognized=false（调用方记源级错误，不静默吞）', () => {
    for (const body of ['<html><body>error</body></html>', 'not xml at all', '{"json":true}']) {
      const feed = parseRssFeed(body);
      expect(feed.items).toEqual([]);
      expect(feed.recognized).toBe(false);
    }
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

  it('只有 enclosure/self 链接的条目不算原文链接（计 dropped，不把媒体 URL 当 source_url）', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Podcast</title>
        <link rel="self" href="https://feeds.example/self"/>
        <link rel="enclosure" href="https://cdn.example/ep1.mp3"/>
        <updated>2026-11-10T08:00:00Z</updated>
      </entry>
    </feed>`;
    const feed = parseRssFeed(xml);
    expect(feed.items).toHaveLength(0);
    expect(feed.dropped).toBe(1);
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

  it('越界 last_changed 不产生 Invalid Date（跳过该 watch）', () => {
    const feed = parseChangedetectionWatches([
      { url: 'https://a.example/x', title: 'A', last_changed: 1e20 },
      { url: 'https://b.example/x', title: 'B', last_changed: 1700000000 },
    ]);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]!.observedAt.toString()).not.toContain('Invalid');
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
  it('hostnameOfUrl：canonicalDomain 归一（去 www/尾点、小写）；非 http(s)/非法 URL → null', () => {
    expect(hostnameOfUrl('https://www.Nees-Pumpen.de/news')).toBe('nees-pumpen.de');
    expect(hostnameOfUrl('https://example.de./news')).toBe('example.de');
    expect(hostnameOfUrl('not a url')).toBeNull();
    expect(hostnameOfUrl('ftp://example.com/x')).toBeNull();
  });

  it('registrableDomain：两级公开后缀取三段；未收录后缀按「通用 SLD + 1」取三段', () => {
    expect(registrableDomain('shop.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('a.b.example.de')).toBe('example.de');
    expect(registrableDomain('example.de')).toBe('example.de');
    expect(registrableDomain('192.168.1.1')).toBeNull();
    // 未收录的两段后缀（com.co / co.id）：绝不坍缩成公共后缀本身。
    expect(registrableDomain('shop.example.com.co')).toBe('example.com.co');
    expect(registrableDomain('example.co.id')).toBe('example.co.id');
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

  it('多租户托管后缀：同注册域的兄弟子域绝不互认（wordpress.com/github.io…）', () => {
    expect(
      chooseCompanyMatch('evil.wordpress.com', [{ id: 'acme', domain: 'acme.wordpress.com' }]),
    ).toBeNull();
    expect(
      chooseCompanyMatch('evil.github.io', [{ id: 'acme', domain: 'acme.github.io' }]),
    ).toBeNull();
    // 父子域仍然可信（谁控制父域谁控制子域）。
    expect(
      chooseCompanyMatch('news.acme.wordpress.com', [{ id: 'acme', domain: 'acme.wordpress.com' }]),
    ).toBe('acme');
  });

  it('attributeCompany：先精确后后缀两段查询；显式 workspaceId', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const exactRow: SignalCompanyRecord = { id: 'exact', domain: 'shop.example.de' };
    const store = {
      canonicalCompany: {
        async findMany(args: Record<string, unknown>) {
          calls.push(args);
          return [exactRow];
        },
      },
    } as unknown as CompanySignalStore;

    await expect(attributeCompany(store, 'ws-1', 'shop.example.de')).resolves.toBe('exact');
    expect(calls).toHaveLength(1);
    const where = calls[0]!.where as { workspaceId: string; OR: Array<Record<string, unknown>> };
    expect(where.workspaceId).toBe('ws-1');
    expect(JSON.stringify(where.OR)).toContain('"equals"');
    expect(JSON.stringify(where.OR)).not.toContain('"endsWith"');
  });

  it('attributeCompany：精确段无果才走 endsWith 兜底（第二段查询）', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store = {
      canonicalCompany: {
        async findMany(args: Record<string, unknown>) {
          calls.push(args);
          const where = args.where as { OR: Array<Record<string, unknown>> };
          return JSON.stringify(where.OR).includes('"endsWith"')
            ? [{ id: 'parent', domain: 'example.de' }]
            : [];
        },
      },
    } as unknown as CompanySignalStore;

    await expect(attributeCompany(store, 'ws-1', 'news.example.de')).resolves.toBe('parent');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]!.where)).toContain('"endsWith"');
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

describe('persistCollectedSource / summarizeSignalReports —— 归因 + 落库（事务内），计数口径', () => {
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

  const companies: SignalCompanyRecord[] = [
    { id: 'c-nees', domain: 'nees-pumpen.de' },
    { id: 'c-bier', domain: 'biergangs.de' },
  ];

  const collected: CollectedSignalSource = {
    source: 'rss:github/issue/a/b',
    items: [
      {
        providerKey: PROVIDER_RSS,
        signalKind: 'rss_item',
        sourceUrl: 'https://www.nees-pumpen.de/news',
        title: 'Nees News',
        excerpt: null,
        observedAt: new Date('2026-11-10T09:30:00.000Z'),
      },
      {
        providerKey: PROVIDER_RSS,
        signalKind: 'rss_item',
        sourceUrl: 'https://unknown.example.com/x',
        title: 'Unbekannt',
        excerpt: null,
        observedAt: new Date(0),
      },
    ],
    dropped: 1,
    error: null,
  };

  it('归因 + 入库计数；重跑全跳过；skipped 只计唯一约束跳过（dropped 单列）', async () => {
    const { store } = fakeCompanyStore(companies);
    const first = await persistCollectedSource(store, 'ws-1', collected);
    expect(first).toMatchObject({ source: 'rss:github/issue/a/b', parsed: 2, dropped: 1, inserted: 2, skipped: 0, matched: 1, error: null });
    const cache = new Map<string, string | null>();
    const second = await persistCollectedSource(store, 'ws-1', collected, cache);
    expect(second).toMatchObject({ inserted: 0, skipped: 2, matched: 1 });
    const summary = summarizeSignalReports([first, second]);
    expect(summary).toMatchObject({ inserted: 2, skipped: 2, matched: 2 });
    expect(summary.sources).toHaveLength(2);
  });

  it('采集期错误原样进报告，不写库', async () => {
    const { store, inserted } = fakeCompanyStore(companies);
    const report = await persistCollectedSource(store, 'ws-1', {
      source: 'changedetection',
      items: [],
      dropped: 0,
      error: 'HTTP 401',
    });
    expect(report).toMatchObject({ parsed: 0, inserted: 0, error: 'HTTP 401' });
    expect(inserted).toHaveLength(0);
  });

  it('写失败向上抛（调用方事务整体回滚，不吞错）', async () => {
    const store = {
      canonicalCompany: { async findMany() { return companies; } },
      companySignal: {
        async createMany() {
          throw new Error('insert failed');
        },
      },
    } as unknown as CompanySignalStore;
    await expect(persistCollectedSource(store, 'ws-1', collected)).rejects.toThrow(/insert failed/);
  });
});

describe('stripHtml / resolve helpers', () => {
  it('stripHtml：去标签、解实体（含数字实体）、截断', () => {
    expect(stripHtml('<p>A &amp; B</p>')).toBe('A & B');
    expect(stripHtml('<p>&#8220;Hallo&#8221;</p>')).toBe('“Hallo”');
    expect(stripHtml('<script>alert(1)</script>Text')).toBe('Text');
    expect(stripHtml('x'.repeat(600), 500)).toHaveLength(500);
    expect(stripHtml('<b></b>')).toBe('');
  });
});
