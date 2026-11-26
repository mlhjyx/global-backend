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
  delete process.env.URL_CONTENT_CACHE;
});

describe('crawl4ai.fetch 的 HTTP-first 分级（PR-A）', () => {
  it('does not send an exact evidence request if HTTP-first is disabled', async () => {
    process.env.HTTP_FIRST_FETCH = 'off';
    const fetchHttpFirst = vi.fn();
    const crawlUrl = vi.fn();
    const tool = makeTool({ fetchHttpFirst, crawlUrl });
    const out = await tool.execute({ url: 'https://acme.example/project', exactHtml: true }, ctx);
    expect(out.data.text).toBe('');
    expect(fetchHttpFirst).not.toHaveBeenCalled();
    expect(crawlUrl).not.toHaveBeenCalled();
  });

  it('strict evidence requests bypass normal cache and never fall back to rendering', async () => {
    const url = 'https://acme.example/referenzen/';
    const fetchHttpFirst = vi.fn(async () => null);
    const renderer = vi.fn();
    const tool = makeTool({ fetchHttpFirst, crawlUrl: renderer });
    const input = { url, exactHtml: true as const };
    expect(tool.idempotencyKey!(input)).not.toBe(tool.idempotencyKey!({ url }));
    expect((await tool.execute(input, ctx)).data.text).toBe('');
    expect(fetchHttpFirst).toHaveBeenCalledWith(url, expect.objectContaining({ exactUrl: true }));
    expect(renderer).not.toHaveBeenCalled();
  });

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

  it('falls back to the rendered markdown when the HTTP page is thin without charging phantom 1c', async () => {
    const crawlUrl = vi.fn(async () => ({ url: 'https://acme.example/', text: 'rendered content' }));
    const tool = makeTool({ crawlUrl });
    const out = await tool.execute({ url: 'https://acme.example/' }, ctx);
    expect(crawlUrl).toHaveBeenCalledOnce();
    expect(out.data.text).toBe('rendered content');
    expect(out.costCents).toBe(0);
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

  it('settles cleanly at $0 on workspace render TimeoutError instead of leaving budget RESERVED', async () => {
    const crawlUrl = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const tool = makeTool({ crawlUrl });
    const out = await tool.execute({ url: 'https://slow.example/' }, ctx);
    expect(out).toEqual({
      data: { url: 'https://slow.example/', text: '', contentHash: '' },
      costCents: 0,
      degraded: true,
    });
  });

  it('still propagates TimeoutError under platformEgress mode', async () => {
    const crawlUrl = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const tool = makeTool({ crawlUrl });
    await expect(
      tool.execute({ url: 'https://slow.example/' }, { ...(ctx as object), platformEgress: {} } as never),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('wires the PR-B page cache port with the workspace and reports cache provenance', async () => {
    const port = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const fetchHttpFirst = vi.fn(async () => ({
      markdown: '# Acme\ncentrifugal pumps distributor',
      title: 'Acme',
      contentHash: 'a'.repeat(64),
      fromCache: 'conditional-304' as const,
    }));
    const tool = createCrawl4aiFetchTool({
      crawlUrl: vi.fn() as never,
      isAllowedByRobots: async () => true,
      fetchHttpFirst: fetchHttpFirst as never,
      urlContentCache: port,
    });
    const wsCtx = {
      workspaceId: 'workspace-cache-1',
      authorizeExternalAction: async () => undefined,
      beforePhysicalWire: async () => undefined,
    } as never;

    const out = await tool.execute({ url: 'https://acme.example/' }, wsCtx);

    expect(fetchHttpFirst.mock.calls[0]?.[1]).toMatchObject({
      cache: { workspaceId: 'workspace-cache-1', port },
    });
    expect(out.provenance?.cache).toBe('conditional-304');
  });

  it('does not consult the page cache when URL_CONTENT_CACHE=off', async () => {
    process.env.URL_CONTENT_CACHE = 'off';
    const port = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
    const fetchHttpFirst = vi.fn(async () => ({
      markdown: '# Acme\ncentrifugal pumps distributor',
      title: 'Acme',
      contentHash: 'a'.repeat(64),
    }));
    const tool = createCrawl4aiFetchTool({
      crawlUrl: vi.fn() as never,
      isAllowedByRobots: async () => true,
      fetchHttpFirst: fetchHttpFirst as never,
      urlContentCache: port,
    });

    const out = await tool.execute(
      { url: 'https://acme.example/' },
      { workspaceId: 'workspace-cache-1' } as never,
    );

    expect(fetchHttpFirst.mock.calls[0]?.[1]).not.toHaveProperty('cache');
    expect(out.provenance?.cache).toBeUndefined();
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

describe('profile capture physical gates and legacy renderer compatibility', () => {
  const input = {url: 'https://manufacturer.example/location', exactHtml: true as const, profileTextRevision: 'manufacturer-profile/v1' as const};
  it('stops a v2 profile before HTTP or renderer when robots denies it', async () => {
    process.env.HTTP_FIRST_FETCH = 'on';
    const fetchHttpFirst = vi.fn(); const crawlUrl = vi.fn();
    const tool = createCrawl4aiFetchTool({fetchHttpFirst, crawlUrl, isAllowedByRobots: async () => false});
    expect((await tool.execute(input, ctx)).data.text).toBe('');
    expect(fetchHttpFirst).not.toHaveBeenCalled(); expect(crawlUrl).not.toHaveBeenCalled();
  });
  it('passes a false final source/suppression authorization through without a renderer fallback', async () => {
    process.env.HTTP_FIRST_FETCH = 'on';
    const renderer = vi.fn();
    const fetchHttpFirst = vi.fn(async (_url, options) => {
      expect(options.profileTextRevision).toBe('manufacturer-profile/v1');
      expect(await options.hooks.authorizeExternalAction()).toBe(false);
      return null;
    });
    const tool = makeTool({fetchHttpFirst, crawlUrl: renderer});
    expect((await tool.execute(input, {workspaceId: 'offline', authorizeExternalAction: async () => false})).data.text).toBe('');
    expect(renderer).not.toHaveBeenCalled(); expect(fetchHttpFirst).toHaveBeenCalledOnce();
  });
  it('propagates a failed physical-wire fence instead of hiding it as an empty profile', async () => {
    process.env.HTTP_FIRST_FETCH = 'on';
    const denied = new Error('PHYSICAL_FENCE_DENIED'); let wires = 0;
    const renderer = vi.fn();
    const fetchHttpFirst = vi.fn(async (_url, options) => {await options.hooks.beforePhysicalWire(); wires++; return null;});
    const tool = makeTool({fetchHttpFirst, crawlUrl: renderer});
    await expect(tool.execute(input, {workspaceId: 'offline', beforePhysicalWire: async () => {throw denied;}})).rejects.toBe(denied);
    expect(wires).toBe(0); expect(renderer).not.toHaveBeenCalled(); expect(fetchHttpFirst).toHaveBeenCalledOnce();
  });
  it('keeps the existing non-profile renderer authorization callback intact', async () => {
    process.env.HTTP_FIRST_FETCH = 'off';
    const authorize = vi.fn(async () => true);
    const crawlUrl = vi.fn(async (_url, before) => {await before(); return {text: 'Legacy page text'};});
    const tool = makeTool({crawlUrl});
    expect((await tool.execute({url: input.url}, {workspaceId: 'offline', authorizeExternalAction: authorize})).data.text).toBe('Legacy page text');
    expect(authorize).toHaveBeenCalledOnce(); expect(crawlUrl).toHaveBeenCalledOnce();
  });
});

it.each(['conditional-304', undefined] as const)('keeps ordinary cache forwarding/provenance (%s) while a v2 profile bypasses that cache', async fromCache => {
  process.env.HTTP_FIRST_FETCH = 'on'; process.env.URL_CONTENT_CACHE = 'on';
  const port = {get: vi.fn(), put: vi.fn()};
  const fetchHttpFirst = vi.fn(async () => ({markdown: 'Cached ordinary page', title: null, contentHash: 'a'.repeat(64), ...(fromCache ? {fromCache} : {})}));
  const tool = createCrawl4aiFetchTool({urlContentCache: port, fetchHttpFirst: fetchHttpFirst as never, isAllowedByRobots: async () => true, crawlUrl: vi.fn()});
  const ordinary = await tool.execute({url:'https://acme.example/'}, {workspaceId:'offline'});
  expect(fetchHttpFirst).toHaveBeenLastCalledWith('https://acme.example/', expect.objectContaining({cache:{workspaceId:'offline',port}}));
  expect(ordinary.provenance).toMatchObject({cache:fromCache ?? 'miss'});
  await tool.execute({url:'https://manufacturer.example/location',exactHtml:true,profileTextRevision:'manufacturer-profile/v1'}, {workspaceId:'offline'});
  expect(fetchHttpFirst.mock.calls[1]![1]).not.toHaveProperty('cache');
});
