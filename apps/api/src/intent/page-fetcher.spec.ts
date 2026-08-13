import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../tools/tool-contract';
import { isAllowedByRobots } from '../adapters/robots';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import { Crawl4aiPageFetcher } from './page-fetcher';

vi.mock('../adapters/robots', () => ({ isAllowedByRobots: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(isAllowedByRobots).mockReset();
});

describe('Crawl4aiPageFetcher', () => {
  it('rejects non-http input before robots or broker access', async () => {
    const invoke = vi.fn();
    await expect(new Crawl4aiPageFetcher({ invoke } as unknown as ExecutionBroker).fetch('file:///etc/passwd')).resolves.toBeNull();
    expect(isAllowedByRobots).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not crawl a robots-denied URL', async () => {
    vi.mocked(isAllowedByRobots).mockResolvedValue(false);
    const invoke = vi.fn();
    await expect(new Crawl4aiPageFetcher({ invoke } as unknown as ExecutionBroker).fetch('https://acme.example/')).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails closed without a broker and warns only once', async () => {
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetcher = new Crawl4aiPageFetcher();

    await expect(fetcher.fetch('https://acme.example/a')).resolves.toBeNull();
    await expect(fetcher.fetch('https://acme.example/b')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('treats broker failure, robots-blocked output, and short HTML as misses', async () => {
    vi.mocked(isAllowedByRobots).mockRejectedValue(new Error('robots unavailable'));
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('crawl unavailable'))
      .mockResolvedValueOnce({ data: { html: 'x'.repeat(300), robotsBlocked: true } })
      .mockResolvedValueOnce({ data: { html: 'short' } });
    const fetcher = new Crawl4aiPageFetcher({ invoke } as unknown as ExecutionBroker);

    await expect(fetcher.fetch('https://acme.example/fail')).resolves.toBeNull();
    await expect(fetcher.fetch('https://acme.example/robots')).resolves.toBeNull();
    await expect(fetcher.fetch('https://acme.example/short')).resolves.toBeNull();
  });

  it('returns a bounded successful page through the platform broker context', async () => {
    vi.mocked(isAllowedByRobots).mockResolvedValue(true);
    const invoke = vi.fn().mockResolvedValue({ data: { html: 'x'.repeat(200) } });
    const fetcher = new Crawl4aiPageFetcher({ invoke } as unknown as ExecutionBroker);

    await expect(fetcher.fetch('https://acme.example/page')).resolves.toEqual({
      url: 'https://acme.example/page',
      html: 'x'.repeat(200),
    });
    expect(invoke).toHaveBeenCalledWith(
      'crawl4ai.render',
      { url: 'https://acme.example/page' },
      { workspaceId: PLATFORM_WORKSPACE, correlationId: 'intent-sweep' },
    );
  });
});
