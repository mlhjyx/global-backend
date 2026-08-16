import { afterEach, describe, expect, it, vi } from 'vitest';
import { searxSearchPaged } from './searxng';

describe('SearXNG physical-request authorization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops before the next page when the bound Provider is disabled between requests', async () => {
    let enabled = true;
    const fetchMock = vi.fn(async () => {
      enabled = false;
      return new Response(JSON.stringify({
        results: [{ url: 'https://example.com/', title: 'Example' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi.fn(async () => {
      if (!enabled) throw new Error('provider_disabled');
    });
    const onRequestStarted = vi.fn();

    await expect(
      searxSearchPaged({ q: 'industrial supplier' }, 2, 1_000, {
        beforeRequest,
        onRequestStarted,
      }),
    ).rejects.toThrow('provider_disabled');

    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(onRequestStarted).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
