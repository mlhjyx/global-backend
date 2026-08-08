import { describe, expect, it, vi } from 'vitest';
import { MapYourShowSourceAdapter } from './mapyourshow.source';
import { TradeFairSourceAdapter } from './trade-fair.source';

function broker(data: unknown) {
  return { invoke: vi.fn(async () => ({ data, costCents: 0 })) };
}

describe('monitored trade-fair source adapters', () => {
  it.each([
    [{}, 'needs host'],
    [{ host: 'example.com' }, 'needs host'],
  ])('rejects invalid MapYourShow configuration %#', async (config, message) => {
    await expect(new MapYourShowSourceAdapter().fetch(config)).rejects.toThrow(message);
  });

  it('fails closed when MapYourShow has no broker', async () => {
    await expect(
      new MapYourShowSourceAdapter().fetch({ host: 'pump.mapyourshow.com' }),
    ).rejects.toThrow('broker unavailable');
  });

  it('normalizes, deduplicates and bounds MapYourShow hits', async () => {
    const execution = broker({
      hits: [
        {
          fields: {
            exhid_l: ' 1 ',
            exhname_t: ' Pump GmbH ',
            boothsdisplay_la: ['A1'],
            hallid_la: ['Hall 2'],
            exhdesc_t: 'Industrial pumps',
          },
        },
        { fields: { exhid_l: '1', exhname_t: 'Duplicate' } },
        { fields: { exhid_l: '', exhname_t: 'Missing id' } },
        { fields: { exhid_l: '2', exhname_t: '' } },
        { fields: { exhid_l: '3', exhname_t: 'Valve AG' } },
      ],
    });
    const adapter = new MapYourShowSourceAdapter(execution as never);

    const rows = await adapter.fetch(
      { host: 'pump.mapyourshow.com', sourceKey: 'pump-2026' },
      1,
    );

    expect(rows).toEqual([
      expect.objectContaining({
        externalId: '1',
        name: 'Pump GmbH',
        fields: expect.objectContaining({
          stand: 'A1',
          hall: 'Hall 2',
          source_fair: 'pump-2026',
        }),
      }),
    ]);
    expect(execution.invoke).toHaveBeenCalledWith(
      'mapyourshow.fetch',
      { host: 'pump.mapyourshow.com', limit: 1 },
      expect.objectContaining({ correlationId: 'acquisition-sweep' }),
    );
  });

  it('uses host prefix as the MapYourShow fair fallback and tolerates absent fields', async () => {
    const execution = broker({ hits: [{ fields: { exhid_l: '9', exhname_t: 'Nine' } }] });
    const rows = await new MapYourShowSourceAdapter(execution as never).fetch({
      host: 'nine.mapyourshow.com',
    });
    expect(rows[0]?.fields).toMatchObject({ source_fair: 'nine' });
  });

  it.each([
    {},
    { algolia: {} },
    { algolia: { appId: 'a', apiKey: 'k', indexName: 'i' } },
  ])('rejects incomplete Algolia configuration %#', async (config) => {
    await expect(new TradeFairSourceAdapter().fetch(config)).rejects.toThrow(
      'missing algolia',
    );
  });

  it('fails closed when Algolia source has no broker', async () => {
    await expect(
      new TradeFairSourceAdapter().fetch({
        algolia: { appId: 'a', apiKey: 'k', indexName: 'i', eventEditionId: 'e' },
      }),
    ).rejects.toThrow('broker unavailable');
  });

  it('maps monitored Algolia exhibitors without inventing missing facts', async () => {
    const execution = broker({
      exhibitors: [
        {
          externalId: 'ex-1',
          companyName: 'Pump GmbH',
          website: 'https://pump.example',
          country: 'DE',
          email: 'sales@pump.example',
          products: ['pump'],
        },
      ],
    });
    const config = {
      fairSlug: 'pump-fair',
      algolia: { appId: 'a', apiKey: 'k', indexName: 'i', eventEditionId: 'e' },
    };

    const rows = await new TradeFairSourceAdapter(execution as never).fetch(config, 7);

    expect(rows).toEqual([
      expect.objectContaining({
        externalId: 'ex-1',
        name: 'Pump GmbH',
        country: 'DE',
        fields: expect.objectContaining({
          products: ['pump'],
          source_fair: 'pump-fair',
          source_kind: 'trade_fair_exhibitor',
        }),
      }),
    ]);
    expect(execution.invoke).toHaveBeenCalledWith(
      'tradefair.algolia',
      { cfg: config.algolia, limit: 7 },
      expect.objectContaining({ correlationId: 'acquisition-sweep' }),
    );
  });
});
