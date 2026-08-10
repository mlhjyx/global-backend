import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverByArea } from './openstreetmap';
import { queryAlgoliaExhibitors } from './trade-fair-algolia';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('adapter internal physical-wire authorization', () => {
  it('rechecks before an OSM fallback endpoint after the first endpoint fails', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ elements: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('suppression_action_gate'));

    await expect(
      discoverByArea(
        { areaName: 'Bavaria', tagFilters: [{ k: 'industrial' }], limit: 10 },
        beforeRequest,
      ),
    ).resolves.toEqual([]);

    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rechecks before every Algolia page and stops after suppression is committed', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          hits: [{ objectID: 'one', companyName: 'One GmbH' }],
          nbPages: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const beforeRequest = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('suppression_action_gate'));

    await expect(
      queryAlgoliaExhibitors(
        {
          appId: 'APP',
          apiKey: 'public-key',
          indexName: 'exhibitors',
          eventEditionId: 'edition',
        },
        1_500,
        beforeRequest,
      ),
    ).rejects.toThrow(/suppression_action_gate/);

    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
