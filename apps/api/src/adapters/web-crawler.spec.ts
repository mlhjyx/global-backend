import { afterEach, describe, expect, it, vi } from 'vitest';
import { crawlHtml, crawlUrl } from './web-crawler';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Crawl4AI adapter 的 API 侧入口闸', () => {
  it.each([
    'http://127.0.0.1:3000/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/internal',
    'file:///etc/passwd',
  ])('crawlUrl 在请求本地 crawler 前拒绝 %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(crawlUrl(url)).rejects.toMatchObject({ name: 'EgressBlockedError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('crawlHtml 同样在本地 crawler 前拒绝 metadata', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(crawlHtml('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      name: 'EgressBlockedError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['crawlUrl', crawlUrl],
    ['crawlHtml', crawlHtml],
  ] as const)(
    '%s 在公网目标解析后、Crawl4AI dispatch 前重新授权',
    async (_name, crawl) => {
      const fetchMock = vi.fn();
      const authorizeExternalAction = vi
        .fn<() => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('suppression_action_gate'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        crawl(
          'https://company.example/path',
          authorizeExternalAction,
          vi.fn(async (raw: string) => ({
            url: new URL(raw),
            ip: '203.0.113.10',
            family: 4 as const,
            addresses: [{ address: '203.0.113.10', family: 4 as const }],
          })),
        ),
      ).rejects.toThrow(/suppression_action_gate/);

      expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('crawlUrl uses configured auth, returns bounded markdown, and redacts an upstream body on failure', async () => {
    vi.stubEnv('CRAWLER_URL', 'http://crawler.test:11235');
    vi.stubEnv('CRAWLER_TOKEN', 'secret-token');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ markdown: '# Public page' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('client_secret=do-not-log buyer@example.test', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const resolver = vi.fn(async (raw: string) => ({
      url: new URL(raw), ip: '203.0.113.10', family: 4 as const, addresses: [{ address: '203.0.113.10', family: 4 as const }],
    }));

    await expect(crawlUrl('https://company.example/path', undefined, resolver)).resolves.toEqual({
      url: 'https://company.example/path',
      text: '# Public page',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://crawler.test:11235/md');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
    });
    const error = await crawlUrl('https://company.example/path', undefined, resolver).catch((failure) => failure as Error);
    expect(error.message).toMatch(/^crawler 502: ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(error.message).not.toContain('buyer@example.test');
  });

  it('crawlHtml returns defaults, rejects missing results, and redacts failed bodies', async () => {
    const resolver = vi.fn(async (raw: string) => ({
      url: new URL(raw), ip: '203.0.113.10', family: 4 as const, addresses: [{ address: '203.0.113.10', family: 4 as const }],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{}] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: { error: 'render unavailable' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response('token=hidden', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(crawlHtml('https://company.example', undefined, resolver)).resolves.toEqual({
      url: 'https://company.example/', html: '', headers: {},
    });
    await expect(crawlHtml('https://company.example', undefined, resolver)).rejects.toThrow('render unavailable');
    const error = await crawlHtml('https://company.example', undefined, resolver).catch((failure) => failure as Error);
    expect(error.message).toMatch(/^crawler 503: ERROR_TEXT_SHA256:[0-9a-f]{64}$/);
    expect(error.message).not.toContain('hidden');
  });
});
