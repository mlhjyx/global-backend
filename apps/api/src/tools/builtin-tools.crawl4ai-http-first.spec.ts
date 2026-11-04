import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrawl4aiFetchTool, readCrawl4aiFetchLimits } from './builtin-tools';

const ctx = {
  authorizeExternalAction: async () => undefined,
  beforePhysicalWire: async () => undefined,
} as never;

function makeTool(deps: {
  crawlUrl?: ReturnType<typeof vi.fn>;
  fetchHttpFirst?: ReturnType<typeof vi.fn>;
}) {
  return createCrawl4aiFetchTool({
    crawlUrl: (deps.crawlUrl ?? vi.fn()) as never,
    isAllowedByRobots: async () => true,
    fetchHttpFirst: (deps.fetchHttpFirst ?? vi.fn(async () => null)) as never,
  });
}

afterEach(() => {
  delete process.env.HTTP_FIRST_FETCH;
  delete process.env.CRAWLER_429_RETRY_DELAY_MS;
});

describe('crawl4ai.fetch 的 HTTP-first 分级（PR-A）', () => {
  it('serves a readable page over plain HTTP without invoking the renderer', async () => {
    const crawlUrl = vi.fn();
    const tool = makeTool({
      crawlUrl,
      fetchHttpFirst: vi.fn(async () => ({
        markdown: '# Acme\ncentrifugal pumps distributor',
        title: 'Acme',
        contentHash: 'a'.repeat(64),
      })),
    });
    const out = await tool.execute({ url: 'https://acme.example/' }, ctx);
    expect(crawlUrl).not.toHaveBeenCalled();
    expect(out.data.text).toContain('centrifugal pumps');
    expect(out.costCents).toBe(0);
    expect(out.provenance?.parserVersion).toBe('http-first/1');
  });

  it('falls back to the rendered markdown when the HTTP page is thin', async () => {
    const crawlUrl = vi.fn(async () => ({ url: 'https://acme.example/', text: 'rendered content' }));
    const tool = makeTool({ crawlUrl });
    const out = await tool.execute({ url: 'https://acme.example/' }, ctx);
    expect(crawlUrl).toHaveBeenCalledOnce();
    expect(out.data.text).toBe('rendered content');
    expect(out.costCents).toBe(1);
  });

  it('goes straight to the renderer when HTTP_FIRST_FETCH=off', async () => {
    process.env.HTTP_FIRST_FETCH = 'off';
    const crawlUrl = vi.fn(async () => ({ url: 'https://acme.example/', text: 'rendered only' }));
    const fetchHttpFirst = vi.fn();
    const tool = makeTool({ crawlUrl, fetchHttpFirst });
    const out = await tool.execute({ url: 'https://acme.example/' }, ctx);
    expect(fetchHttpFirst).not.toHaveBeenCalled();
    expect(crawlUrl).toHaveBeenCalledOnce();
    expect(out.data.text).toBe('rendered only');
  });

  it('retries the render once on a 429 before accepting the result', async () => {
    process.env.CRAWLER_429_RETRY_DELAY_MS = '0';
    const crawlUrl = vi
      .fn()
      .mockRejectedValueOnce(new Error('crawler /md: 429 Too Many Requests'))
      .mockResolvedValueOnce({ url: 'https://acme.example/', text: 'after retry' });
    const tool = makeTool({ crawlUrl });
    const out = await tool.execute({ url: 'https://acme.example/' }, ctx);
    expect(crawlUrl).toHaveBeenCalledTimes(2);
    expect(out.data.text).toBe('after retry');
  });

  it('does not retry non-429 render failures', async () => {
    const crawlUrl = vi.fn().mockRejectedValue(new Error('crawler /md: 500 boom'));
    const tool = makeTool({ crawlUrl });
    await expect(tool.execute({ url: 'https://acme.example/' }, ctx)).rejects.toThrow('500');
    expect(crawlUrl).toHaveBeenCalledOnce();
  });

  it('reads limiter defaults from the environment with safe fallbacks', () => {
    expect(readCrawl4aiFetchLimits({})).toEqual({
      rps: 4,
      concurrency: 6,
      perDomainCrawlDelayMs: 2000,
    });
    expect(
      readCrawl4aiFetchLimits({
        CRAWL4AI_FETCH_RPS: '2',
        CRAWL4AI_FETCH_CONCURRENCY: '3',
        CRAWL4AI_FETCH_DOMAIN_DELAY_MS: 'junk',
      }),
    ).toEqual({ rps: 2, concurrency: 3, perDomainCrawlDelayMs: 2000 });
  });
});
