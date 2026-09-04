import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverByArea } from './openstreetmap';
import { queryAlgoliaExhibitors } from './trade-fair-algolia';
import { ExternalToolActionDeniedError } from '../tools/tool-contract';

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
      .mockRejectedValueOnce(new ExternalToolActionDeniedError());

    await expect(
      discoverByArea(
        { areaName: 'Bavaria', tagFilters: [{ k: 'industrial' }], limit: 10 },
        beforeRequest),
    ).rejects.toThrow(/suppression_action_gate/);

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

  it('bounds one 10,000-item Algolia source to ten physical pages and fences every page', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      if (fetchMock.mock.calls.length > 10) {
        throw new Error('unbounded Algolia page fan-out');
      }
      return new Response(JSON.stringify({
        hits: [{ objectID: 'same', companyName: 'Same GmbH' }],
        nbPages: 999,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const authorize = vi.fn(async () => undefined);
    const beforePhysicalWire = vi.fn(async () => undefined);

    await expect(queryAlgoliaExhibitors(
      {
        appId: 'APP', apiKey: 'public-key', indexName: 'exhibitors',
        eventEditionId: 'edition',
      },
      10_000,
      authorize,
      beforePhysicalWire,
    )).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(authorize).toHaveBeenCalledTimes(10);
    expect(beforePhysicalWire).toHaveBeenCalledTimes(10);
  });

  it('rejects an oversized Algolia page before parsing JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ hits: [], nbPages: 1 }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': '5000001',
        },
      },
    )));

    await expect(queryAlgoliaExhibitors({
      appId: 'APP', apiKey: 'public-key', indexName: 'exhibitors',
      eventEditionId: 'edition',
    })).rejects.toThrow('ALGOLIA_RESPONSE_TOO_LARGE');
  });

  it('rejects an Algolia page that exceeds the requested per-page item bound', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      hits: Array.from({ length: 1_001 }, (_unused, index) => ({
        objectID: String(index), companyName: `Company ${index}`,
      })),
      nbPages: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } })));

    await expect(queryAlgoliaExhibitors({
      appId: 'APP', apiKey: 'public-key', indexName: 'exhibitors',
      eventEditionId: 'edition',
    }, 10_000)).rejects.toThrow('ALGOLIA_RESPONSE_ITEM_BOUND_EXCEEDED');
  });
});
