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
});
