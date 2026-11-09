import { describe, expect, it } from 'vitest';
import {
  collectCompanySignals,
  parseIngestSignalsArgs,
  resolveRssUrl,
  type SignalFetch,
  type SignalResponse,
} from './ingest-signals';
import {
  persistCollectedSource,
  summarizeSignalReports,
  type CompanySignalCreateInput,
  type CompanySignalStore,
  type SignalCompanyRecord,
} from '../../src/signals/company-signals';

const UUID = 'd46d2170-4c39-44c1-8496-5db6b568de2f';

describe('parseIngestSignalsArgs / resolveRssUrl', () => {
  it('--workspace 必填且必须是 uuid；--rss 可重复；--include-watch-changes/--json', () => {
    expect(
      parseIngestSignalsArgs(
        ['--workspace', UUID, '--rss', 'a/b', '--rss', 'https://x.example/f', '--include-watch-changes', '--json'],
        {},
      ),
    ).toEqual({
      workspace: UUID,
      rssRoutes: ['a/b', 'https://x.example/f'],
      includeWatchChanges: true,
      json: true,
    });
  });

  it('未给 --rss 时读 SIGNAL_RSS_ROUTES（逗号分隔、去空白）', () => {
    const args = parseIngestSignalsArgs(['--workspace', UUID], { SIGNAL_RSS_ROUTES: ' r/1 , r/2 ' });
    expect(args.rssRoutes).toEqual(['r/1', 'r/2']);
  });

  it('参数错误抛错：缺 workspace / 非法 uuid / 没有任何信号源', () => {
    expect(() => parseIngestSignalsArgs([], {})).toThrow(/--workspace/);
    expect(() => parseIngestSignalsArgs(['--workspace', 'nope'], {})).toThrow(/--workspace/);
    expect(() => parseIngestSignalsArgs(['--workspace', UUID], {})).toThrow(/没有可拉取的信号源/);
  });

  it('route 拼 RSSHub 基址；完整 URL 原样', () => {
    expect(resolveRssUrl('github/issue/a/b', 'http://127.0.0.1:1200')).toBe(
      'http://127.0.0.1:1200/github/issue/a/b',
    );
    expect(resolveRssUrl('/rss/x', 'http://127.0.0.1:1200/')).toBe('http://127.0.0.1:1200/rss/x');
    expect(resolveRssUrl('https://example.com/feed.xml', 'http://127.0.0.1:1200')).toBe(
      'https://example.com/feed.xml',
    );
  });
});

// ── collectCompanySignals：net-guard / 重定向 / 字节上限 / 解析失败可见 ─────────

function response(overrides: Partial<SignalResponse> & { body?: string } = {}): SignalResponse {
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    headers: overrides.headers ?? { get: () => null },
    text: async () => overrides.body ?? '',
  };
}

function redirect(location: string): SignalResponse {
  return {
    ok: false,
    status: 302,
    headers: { get: (name) => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}

const RSS_BODY =
  '<rss><channel><item><title>Nees News</title><link>https://www.nees-pumpen.de/news</link><pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate></item></channel></rss>';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 as const }];

describe('collectCompanySignals —— 拉取（不触网，fetch/DNS 注入）', () => {
  it('本机 RSSHub 路由 + watches：解析、x-api-key 头、从未变更的 watch 不产生信号', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl: SignalFetch = async (url, init) => {
      seen.push({ url, headers: init?.headers });
      if (url.endsWith('/api/v1/watch')) {
        return response({
          body: JSON.stringify({
            aaaa: { url: 'https://biergangs.de/karriere', title: 'Karriere', last_changed: 1762700000 },
            bbbb: { url: 'https://unbewegt.de/x', title: 'Nie geändert', last_changed: 0 },
          }),
        });
      }
      return response({ body: RSS_BODY });
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['github/issue/a/b'],
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      changeDetectionApiKey: 'test-key',
      deps: { fetchImpl },
    });
    expect(seen.map((call) => call.url)).toEqual([
      'http://127.0.0.1:1200/github/issue/a/b',
      'http://127.0.0.1:5055/api/v1/watch',
    ]);
    expect(seen[1]!.headers).toMatchObject({ 'x-api-key': 'test-key' });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ source: 'rss:github/issue/a/b', dropped: 0, error: null });
    expect(sources[0]!.items).toHaveLength(1);
    expect(sources[1]).toMatchObject({ source: 'changedetection', error: null });
    expect(sources[1]!.items).toHaveLength(1);
  });

  it('公网目标经 net-guard：私网解析被拒且不发请求', async () => {
    let called = 0;
    const fetchImpl: SignalFetch = async () => {
      called += 1;
      return response({ body: RSS_BODY });
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['https://internal.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: {
        fetchImpl,
        resolveHost: async () => [{ address: '10.0.0.5', family: 4 as const }],
      },
    });
    expect(called).toBe(0);
    expect(sources[0]!.error).toContain('net-guard');
  });

  it('回环目标不在本机服务白名单 → 拒绝', async () => {
    let called = 0;
    const fetchImpl: SignalFetch = async () => {
      called += 1;
      return response({ body: RSS_BODY });
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['http://127.0.0.1:6379/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { fetchImpl },
    });
    expect(called).toBe(0);
    expect(sources[0]!.error).toContain('回环');
  });

  it('公网地址经 DNS 放行；重定向每跳重验（跳到私网被拒）', async () => {
    const fetchImpl: SignalFetch = async (url) => {
      if (url === 'https://feeds.example/feed') return redirect('https://169.254.169.254/latest');
      return response({ body: RSS_BODY });
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { fetchImpl, resolveHost: PUBLIC_DNS },
    });
    expect(sources[0]!.error).toContain('net-guard');
  });

  it('重定向超过 3 次 → 报错；content-length 超 5MB → 报错', async () => {
    const loopFetch: SignalFetch = async (url) =>
      url.includes('hop=4') ? response({ body: RSS_BODY }) : redirect(`https://feeds.example/feed?hop=${Number(new URL(url).searchParams.get('hop') ?? 0) + 1}`);
    const looped = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed?hop=0'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { fetchImpl: loopFetch, resolveHost: PUBLIC_DNS },
    });
    expect(looped[0]!.error).toContain('重定向超过');

    const bigFetch: SignalFetch = async () =>
      response({
        body: RSS_BODY,
        headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024) : null) },
      });
    const big = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { fetchImpl: bigFetch, resolveHost: PUBLIC_DNS },
    });
    expect(big[0]!.error).toContain('响应过大');
  });

  it('200 但不是 RSS/Atom（错误页/JSON）→ 源级错误而非静默 0', async () => {
    const fetchImpl: SignalFetch = async () => response({ body: '<html>maintenance</html>' });
    const sources = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { fetchImpl, resolveHost: PUBLIC_DNS },
    });
    expect(sources[0]!.error).toContain('不是 RSS/Atom');
  });

  it('changedetection 缺 API key → 该源报错，不发起请求', async () => {
    let called = 0;
    const fetchImpl: SignalFetch = async () => {
      called += 1;
      return response({ body: '{}' });
    };
    const sources = await collectCompanySignals({
      rssRoutes: [],
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      deps: { fetchImpl },
    });
    expect(called).toBe(0);
    expect(sources[0]!.error).toContain('CHANGE_DETECTION_API_KEY');
  });
});

// ── 采集（网络）+ 落库（事务）组合：与 CLI 主流程同构 ────────────────────────

describe('collect → persist 组合 —— 逐源事务的计数与幂等', () => {
  function fakeStore(companies: SignalCompanyRecord[]) {
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

  const fetchImpl: SignalFetch = async (url) => {
    if (url.endsWith('/api/v1/watch')) {
      return response({
        body: JSON.stringify({
          aaaa: { url: 'https://biergangs.de/karriere', title: 'Karriere', last_changed: 1762700000 },
        }),
      });
    }
    return response({
      body: `<rss><channel>
        <item><title>Nees News</title><link>https://www.nees-pumpen.de/news</link><pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate></item>
        <item><title>Unbekannt</title><link>https://unknown.example.com/x</link></item>
      </channel></rss>`,
    });
  };

  it('首跑 3 条（2 归因）；重跑全跳过；单源错误不拖垮其它源', async () => {
    const companies: SignalCompanyRecord[] = [
      { id: 'c-nees', domain: 'nees-pumpen.de' },
      { id: 'c-bier', domain: 'biergangs.de' },
    ];
    const { store } = fakeStore(companies);
    const options = {
      rssRoutes: ['github/issue/a/b'] as const,
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      changeDetectionApiKey: 'test-key',
      deps: { fetchImpl },
    };

    const collected = await collectCompanySignals({ ...options, rssRoutes: [...options.rssRoutes] });
    const first = summarizeSignalReports(
      await Promise.all(collected.map((source) => persistCollectedSource(store, 'ws-1', source))),
    );
    expect(first).toMatchObject({ inserted: 3, skipped: 0, matched: 2 });
    expect(first.sources.map((source) => source.source)).toEqual([
      'rss:github/issue/a/b',
      'changedetection',
    ]);

    const again = await collectCompanySignals({ ...options, rssRoutes: [...options.rssRoutes] });
    const second = summarizeSignalReports(
      await Promise.all(again.map((source) => persistCollectedSource(store, 'ws-1', source))),
    );
    expect(second).toMatchObject({ inserted: 0, skipped: 3, matched: 2 });
  });
});
