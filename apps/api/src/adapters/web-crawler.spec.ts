import { afterEach, describe, expect, it, vi } from 'vitest';
import { crawlHtml, crawlUrl } from './web-crawler';

afterEach(() => {
  vi.unstubAllGlobals();
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
      const onRequestStarted = vi.fn();
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
          onRequestStarted,
        ),
      ).rejects.toThrow(/suppression_action_gate/);

      expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
      expect(onRequestStarted).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['crawlUrl', crawlUrl, { markdown: 'ok', success: true }],
    ['crawlHtml', crawlHtml, { results: [{ html: '<p>ok</p>', response_headers: {} }] }],
  ] as const)('%s 只在 Crawl4AI 请求即将发出时标记已出网', async (_name, crawl, body) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const authorizeExternalAction = vi.fn(async () => undefined);
    const onRequestStarted = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await crawl(
      'https://company.example/path',
      authorizeExternalAction,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: '203.0.113.10',
        family: 4 as const,
        addresses: [{ address: '203.0.113.10', family: 4 as const }],
      })),
      onRequestStarted,
    );

    expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
    expect(onRequestStarted).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
