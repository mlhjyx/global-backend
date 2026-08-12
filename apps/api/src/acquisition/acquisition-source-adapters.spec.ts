import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../tools/tool-contract';
import { PLATFORM_WORKSPACE } from '../discovery/provider-contract';
import { FAIR_SOURCE_CATALOG, zeroCodeCandidates } from './fair-source-catalog';
import { MapYourShowSourceAdapter } from './adapters/mapyourshow.source';
import { TradeFairSourceAdapter } from './adapters/trade-fair.source';

describe('acquisition fair source catalog', () => {
  it('returns only the candidates served by existing adapters', () => {
    const candidates = zeroCodeCandidates();

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.status === 'algolia' || candidate.status === 'mapyourshow')).toBe(true);
    expect(candidates).not.toBe(FAIR_SOURCE_CATALOG);
  });
});

describe('TradeFairSourceAdapter', () => {
  const config = {
    algolia: { appId: 'app', apiKey: 'search-only', indexName: 'fair', eventEditionId: 'edition' },
    fairSlug: 'fair-2026',
  };

  it('rejects incomplete configuration and a missing broker before egress', async () => {
    await expect(new TradeFairSourceAdapter().fetch({ algolia: {} })).rejects.toThrow('missing algolia');
    await expect(new TradeFairSourceAdapter().fetch(config)).rejects.toThrow('broker unavailable');
  });

  it('maps broker exhibitors into acquisition entities with source provenance', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        exhibitors: [
          {
            externalId: 'ex-1',
            companyName: 'Acme GmbH',
            website: 'https://acme.example',
            country: 'DE',
            email: 'sales@acme.example',
            phone: '+49 1',
            stand: 'A1',
            products: ['Pumps'],
            hiring: true,
            description: 'Industrial pumps',
          },
        ],
      },
    });

    await expect(new TradeFairSourceAdapter({ invoke } as unknown as ExecutionBroker).fetch(config, 25)).resolves.toEqual([
      {
        externalId: 'ex-1',
        name: 'Acme GmbH',
        website: 'https://acme.example',
        country: 'DE',
        fields: {
          email: 'sales@acme.example',
          phone: '+49 1',
          stand: 'A1',
          products: ['Pumps'],
          hiring: true,
          description: 'Industrial pumps',
          source_fair: 'fair-2026',
          source_kind: 'trade_fair_exhibitor',
        },
      },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      'tradefair.algolia',
      { cfg: config.algolia, limit: 25 },
      { workspaceId: PLATFORM_WORKSPACE, correlationId: 'acquisition-sweep' },
    );
  });
});

describe('MapYourShowSourceAdapter', () => {
  it('rejects untrusted hosts and a missing broker before egress', async () => {
    const adapter = new MapYourShowSourceAdapter();
    await expect(adapter.fetch({ host: 'mapyourshow.com.attacker.example' })).rejects.toThrow('needs host');
    await expect(adapter.fetch({ host: 'show.mapyourshow.com' })).rejects.toThrow('broker unavailable');
  });

  it('normalizes, deduplicates, and bounds mapped hits', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        hits: [
          { fields: { exhid_l: ' one ', exhname_t: ' Acme ', boothsdisplay_la: ['A1'], hallid_la: ['H1'], exhdesc_t: 'Pumps' } },
          { fields: { exhid_l: 'one', exhname_t: 'Duplicate' } },
          { fields: { exhid_l: '', exhname_t: 'Missing ID' } },
          { fields: { exhid_l: 'two', exhname_t: 'Second' } },
        ],
      },
    });
    const adapter = new MapYourShowSourceAdapter({ invoke } as unknown as ExecutionBroker);

    await expect(adapter.fetch({ host: 'show.mapyourshow.com', sourceKey: 'show-2026' }, 1)).resolves.toEqual([
      {
        externalId: 'one',
        name: 'Acme',
        fields: {
          stand: 'A1',
          hall: 'H1',
          description: 'Pumps',
          source_fair: 'show-2026',
          source_kind: 'trade_fair_exhibitor_mys',
        },
      },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      'mapyourshow.fetch',
      { host: 'show.mapyourshow.com', limit: 1 },
      { workspaceId: PLATFORM_WORKSPACE, correlationId: 'acquisition-sweep' },
    );
  });
});
