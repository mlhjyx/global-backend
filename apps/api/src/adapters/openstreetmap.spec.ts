import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverByArea } from './openstreetmap';

afterEach(() => vi.unstubAllGlobals());

describe('OpenStreetMap Overpass adapter', () => {
  it('merges fulfilled tag queries, deduplicates identities and drops malformed elements', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const decoded = decodeURIComponent(init.body);
      if (decoded.includes('industrial')) throw new Error('one tag unavailable');
      return {
        ok: true,
        json: async () => ({
          elements: [
            {
              type: 'node',
              id: 1,
              lat: 1,
              lon: 2,
              tags: {
                name: 'Pump GmbH',
                website: 'https://pump.example',
                'addr:city': 'Berlin',
                'addr:country': 'DE',
              },
            },
            { type: 'way', id: 2, center: { lat: 3, lon: 4 }, tags: { name: 'Valve AG' } },
            { type: 'node', id: 3, lat: 1, lon: 2, tags: {} },
            { type: 'node', id: 4, tags: { name: 'No coordinates' } },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await discoverByArea({
      areaName: 'Germany',
      tagFilters: [{ k: 'craft', v: 'metal_construction' }, { k: 'industrial' }],
      limit: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ osmId: 'node/1', name: 'Pump GmbH', city: 'Berlin' });
    expect(rows[1]).toMatchObject({ osmId: 'way/2', latitude: 3, longitude: 4 });
  });

  it('falls through non-2xx and thrown endpoints before succeeding with contact website', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 504 })
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          elements: [
            {
              type: 'relation',
              id: 9,
              center: { lat: 5, lon: 6 },
              tags: { name: 'Nine', 'contact:website': 'https://nine.example' },
            },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      discoverByArea({ areaName: 'Germany', tagFilters: [{ k: 'industrial' }] }),
    ).resolves.toEqual([
      expect.objectContaining({ osmId: 'relation/9', website: 'https://nine.example' }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns an empty set for no tags and for all failed tag queries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unavailable'); }));
    await expect(discoverByArea({ areaName: 'Germany', tagFilters: [] })).resolves.toEqual([]);
    await expect(
      discoverByArea({ areaName: 'Germany', tagFilters: [{ k: 'industrial' }] }),
    ).resolves.toEqual([]);
  });
});
