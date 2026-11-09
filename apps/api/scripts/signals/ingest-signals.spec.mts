import { describe, expect, it } from 'vitest';
import { EgressBlockedError, type PublicHttpResponse } from '../../src/adapters/guarded-http';
import {
  collectCompanySignals,
  parseIngestSignalsArgs,
  persistSources,
  resolveRssUrl,
  serviceResolver,
  type ScopedStoreRunner,
  type SignalHttpRequest,
} from './ingest-signals';
import {
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

// ── 出网：治理出口注入（不触网） ────────────────────────────────────────────

function httpResponse(text: string, overrides: Partial<PublicHttpResponse> = {}): PublicHttpResponse {
  return {
    status: overrides.status ?? 200,
    ok: overrides.ok ?? true,
    headers: overrides.headers ?? {},
    body: Buffer.from(text),
    text,
    finalUrl: overrides.finalUrl ?? 'https://example.test/',
  };
}

const RSS_BODY =
  '<rss><channel><item><title>Nees News</title><link>https://www.nees-pumpen.de/news</link><pubDate>Mon, 10 Nov 2026 09:30:00 GMT</pubDate></item></channel></rss>';

describe('collectCompanySignals —— 经 requestPublicHttp 出口（注入 fake request）', () => {
  it('本机 RSSHub 路由 + watches：目标 URL、x-api-key 头与重定向策略；从未变更的 watch 不是信号', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string>; maxRedirects?: number }> = [];
    const request: SignalHttpRequest = async (url, options) => {
      calls.push({ url, headers: options?.headers, maxRedirects: options?.maxRedirects });
      if (url.endsWith('/api/v1/watch')) {
        return httpResponse(
          JSON.stringify({
            aaaa: { url: 'https://biergangs.de/karriere', title: 'Karriere', last_changed: 1762700000 },
            bbbb: { url: 'https://unbewegt.de/x', title: 'Nie geändert', last_changed: 0 },
          }),
        );
      }
      return httpResponse(RSS_BODY);
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['github/issue/a/b'],
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      changeDetectionApiKey: 'test-key',
      deps: { request },
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:1200/github/issue/a/b',
      'http://127.0.0.1:5055/api/v1/watch',
    ]);
    expect(calls[0]!.maxRedirects).toBe(3);
    // x-api-key 只发给 changedetection，且禁跟随重定向（防止密钥被带往他处）。
    expect(calls[0]!.headers).not.toHaveProperty('x-api-key');
    expect(calls[1]!.headers).toMatchObject({ 'x-api-key': 'test-key' });
    expect(calls[1]!.maxRedirects).toBe(0);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ source: 'rss:github/issue/a/b', dropped: 0, error: null });
    expect(sources[0]!.items).toHaveLength(1);
    expect(sources[1]).toMatchObject({ source: 'changedetection', error: null });
    expect(sources[1]!.items).toHaveLength(1);
  });

  it('治理出口拒绝（EgressBlockedError）→ 源级错误可见', async () => {
    const request: SignalHttpRequest = async () => {
      throw new EgressBlockedError('non_global_address');
    };
    const sources = await collectCompanySignals({
      rssRoutes: ['https://internal.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { request },
    });
    expect(sources[0]!.error).toContain('net-guard');
    expect(sources[0]!.error).toContain('non_global_address');
  });

  it('HTTP 非 2xx / 非 RSS 文档 / 非 JSON 都记源级错误，不静默', async () => {
    const failing = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { request: async () => httpResponse('down', { status: 503, ok: false, finalUrl: 'https://feeds.example/feed' }) },
    });
    expect(failing[0]!.error).toContain('503');

    const html = await collectCompanySignals({
      rssRoutes: ['https://feeds.example/feed'],
      includeWatchChanges: false,
      rsshubUrl: 'http://127.0.0.1:1200',
      deps: { request: async () => httpResponse('<html>maintenance</html>') },
    });
    expect(html[0]!.error).toContain('不是 RSS/Atom');

    const notJson = await collectCompanySignals({
      rssRoutes: [],
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      changeDetectionApiKey: 'k',
      deps: { request: async () => httpResponse('<html>not json</html>') },
    });
    expect(notJson[0]!.error).toContain('不是 JSON');
  });

  it('changedetection 缺 API key → 该源报错，不发起请求', async () => {
    let called = 0;
    const request: SignalHttpRequest = async () => {
      called += 1;
      return httpResponse('{}');
    };
    const sources = await collectCompanySignals({
      rssRoutes: [],
      includeWatchChanges: true,
      rsshubUrl: 'http://127.0.0.1:1200',
      changeDetectionUrl: 'http://127.0.0.1:5055',
      deps: { request },
    });
    expect(called).toBe(0);
    expect(sources[0]!.error).toContain('CHANGE_DETECTION_API_KEY');
  });
});

describe('serviceResolver —— 本机服务 origin 固定回环连接（防 DNS rebinding 前置解析）', () => {
  const resolver = serviceResolver(new Set(['http://127.0.0.1:1200', 'http://localhost:5055']));

  it('白名单 origin → 固定 127.0.0.1，不查外部 DNS', async () => {
    await expect(resolver('http://127.0.0.1:1200/rss/x')).resolves.toMatchObject({
      ip: '127.0.0.1',
      family: 4,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });
    await expect(resolver('http://localhost:5055/api/v1/watch')).resolves.toMatchObject({
      ip: '127.0.0.1',
    });
  });

  it('白名单 origin 指向非回环主机 / 带凭据 → 拒绝', async () => {
    const resolver2 = serviceResolver(new Set(['http://example.com:1200']));
    await expect(resolver2('http://example.com:1200/rss')).rejects.toMatchObject({
      code: 'service_origin_not_loopback',
    });
    await expect(resolver('http://user:pass@127.0.0.1:1200/rss')).rejects.toMatchObject({
      code: 'url_credentials_forbidden',
    });
  });
});

// ── 落库：逐源隔离（与 CLI main 同构：串行 + 共享缓存 + 单源 try/catch） ─────

function fakeStore(
  companies: SignalCompanyRecord[],
  options: { failHost?: string } = {},
) {
  const keys = new Set<string>();
  const inserted: CompanySignalCreateInput[] = [];
  const store: CompanySignalStore = {
    canonicalCompany: {
      async findMany(args) {
        if (options.failHost && JSON.stringify(args.where).includes(options.failHost)) {
          throw new Error('db down');
        }
        return companies;
      },
    },
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

function collectedSource(source: string, urls: readonly string[]) {
  return {
    source,
    items: urls.map((sourceUrl, index) => ({
      providerKey: 'rss',
      signalKind: 'rss_item' as const,
      sourceUrl,
      title: `T${index}`,
      excerpt: null,
      observedAt: new Date(0),
    })),
    dropped: 0,
    error: null,
  };
}

describe('persistSources —— 逐源 scoped 事务、单源失败隔离', () => {
  it('一个源归因失败只回滚该源，其它源照常入库，汇总保留错误', async () => {
    const companies: SignalCompanyRecord[] = [{ id: 'c-nees', domain: 'nees-pumpen.de' }];
    const { store, inserted } = fakeStore(companies, { failHost: 'boom.example' });
    const runner: ScopedStoreRunner = async (fn) => fn(store);
    const summary = await persistSources(runner, 'ws-1', [
      collectedSource('rss:bad', ['https://boom.example/x']),
      collectedSource('rss:good', ['https://www.nees-pumpen.de/news']),
    ]);
    expect(summary.sources[0]!.error).toContain('事务失败');
    expect(summary.sources[0]!.inserted).toBe(0);
    expect(summary.sources[1]).toMatchObject({ inserted: 1, matched: 1, error: null });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ companyId: 'c-nees' });
  });

  it('collect → persist 组合：首跑入库、重跑全跳过（幂等）', async () => {
    const companies: SignalCompanyRecord[] = [{ id: 'c-nees', domain: 'nees-pumpen.de' }];
    const { store } = fakeStore(companies);
    const runner: ScopedStoreRunner = async (fn) => fn(store);
    const request: SignalHttpRequest = async () => httpResponse(RSS_BODY);
    const collect = () =>
      collectCompanySignals({
        rssRoutes: ['github/issue/a/b'],
        includeWatchChanges: false,
        rsshubUrl: 'http://127.0.0.1:1200',
        deps: { request },
      });

    const first = await persistSources(runner, 'ws-1', await collect());
    expect(first).toMatchObject({ inserted: 1, skipped: 0, matched: 1 });
    const second = await persistSources(runner, 'ws-1', await collect());
    expect(second).toMatchObject({ inserted: 0, skipped: 1, matched: 1 });
  });
});
