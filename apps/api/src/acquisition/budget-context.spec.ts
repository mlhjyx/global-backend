import { describe, expect, it, vi } from 'vitest';
import { TradeFairSourceAdapter } from './adapters/trade-fair.source';
import { MapYourShowSourceAdapter } from './adapters/mapyourshow.source';

const context = {
  workspaceId: 'platform',
  runId: 'acquisition:source-1',
  correlationId: 'acquisition:source-1',
};

describe('acquisition adapters — durable budget context', () => {
  it('threads the opened acquisition account into tradefair broker calls', async () => {
    const invoke = vi.fn(async () => ({ data: { exhibitors: [] }, costCents: 0 }));
    const adapter = new TradeFairSourceAdapter({ invoke } as never);

    await adapter.fetch(
      { algolia: { appId: 'app', apiKey: 'key', indexName: 'idx', eventEditionId: 'event' } },
      25,
      context,
    );

    expect(invoke).toHaveBeenCalledWith('tradefair.algolia', expect.anything(), context);
  });

  it('threads the opened acquisition account into MapYourShow broker calls', async () => {
    const invoke = vi.fn(async () => ({ data: { hits: [] }, costCents: 0 }));
    const adapter = new MapYourShowSourceAdapter({ invoke } as never);

    await adapter.fetch({ host: 'show.mapyourshow.com' }, 25, context);

    expect(invoke).toHaveBeenCalledWith('mapyourshow.fetch', expect.anything(), context);
  });
});
