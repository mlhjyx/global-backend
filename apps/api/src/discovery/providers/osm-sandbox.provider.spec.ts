import { describe, expect, it, vi } from 'vitest';
import { OsmDiscoveryProvider } from './osm.provider';
import { SandboxDiscoveryProvider } from './sandbox.provider';

const ctx = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  runId: 'run-1',
  correlationId: 'corr-1',
};

describe('OSM discovery provider', () => {
  it('fails closed without a broker or without resolved tags/area', async () => {
    const query = { sourceClass: 'industry_data', filters: {}, keywords: [], limit: 20 };
    await expect(new OsmDiscoveryProvider().discoverCompanies(query as never, ctx)).resolves.toEqual({
      records: [],
      costCents: 0,
    });

    const invoke = vi.fn();
    await expect(
      new OsmDiscoveryProvider({ broker: { invoke } as never }).discoverCompanies(query as never, ctx),
    ).resolves.toEqual({ records: [], costCents: 0 });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('prefers resolved taxonomy tags and maps bounded public company facts', async () => {
    const invoke = vi.fn(async () => ({
      data: {
        places: [
          {
            osmId: 'node/1',
            name: 'Pump GmbH',
            website: 'https://www.pump.example/path',
            countryCode: 'DE',
            city: 'Berlin',
            latitude: 1,
            longitude: 2,
            tags: { industrial: 'pump' },
          },
          {
            osmId: 'way/2',
            name: 'Bad Website',
            website: 'not a url %',
            latitude: 3,
            longitude: 4,
            tags: {},
          },
        ],
      },
    }));
    const provider = new OsmDiscoveryProvider({ broker: { invoke } as never });
    const result = await provider.discoverCompanies(
      {
        sourceClass: 'industry_data',
        filters: { _osmTags: [{ k: 'industrial', v: 'pump' }], area_name: 'Germany' },
        keywords: [],
        limit: 200,
      } as never,
      ctx,
    );

    expect(invoke).toHaveBeenCalledWith(
      'osm.overpass',
      { areaName: 'Deutschland', tagFilters: [{ k: 'industrial', v: 'pump' }], limit: 80 },
      expect.objectContaining({ purpose: 'discovery' }),
    );
    expect(result.records).toEqual([
      expect.objectContaining({ externalId: 'osm:node/1', domain: 'pump.example', country: 'DE' }),
      expect.objectContaining({ externalId: 'osm:way/2', domain: undefined }),
    ]);
  });

  it('uses built-in vocab and degrades broker failures to an empty result', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('policy denied');
    });
    const result = await new OsmDiscoveryProvider({ broker: { invoke } as never }).discoverCompanies(
      {
        sourceClass: 'industry_data',
        filters: { industry: 'manufacturing', country: 'DE' },
        keywords: [],
        limit: 10,
      } as never,
      ctx,
    );
    expect(result).toEqual({ records: [], costCents: 0 });
  });
});

describe('deterministic sandbox provider', () => {
  it('generates a bounded, repeatable and explicitly synthetic company set', async () => {
    const provider = new SandboxDiscoveryProvider();
    const query = {
      sourceClass: 'trade_data',
      filters: {
        countries: ['DE', 'FR'],
        industries: 'industrial pumps',
        certifications: ['ISO 9001'],
      },
      keywords: ['pump'],
      limit: 30,
    } as never;
    const first = await provider.discoverCompanies(query, ctx);
    const second = await provider.discoverCompanies(query, ctx);

    expect(first).toEqual(second);
    expect(first.records).toHaveLength(25);
    expect(first.records.every((row) => row.domain?.endsWith('.sandbox.example.com'))).toBe(true);
    expect(first.records.every((row) => row.attributes.sandbox === true)).toBe(true);
  });

  it('uses fallbacks for absent filters and emits contacts with and without email', async () => {
    const provider = new SandboxDiscoveryProvider();
    const result = await provider.discoverCompanies(
      { sourceClass: 'industry_data', filters: {}, limit: 1 } as never,
      ctx,
    );
    expect(result.records[0]).toMatchObject({ country: 'DE', industry: 'manufacturing' });

    const withDomain = await provider.discoverContacts(
      { name: 'Pump', domain: 'pump.example' },
      ctx,
    );
    const withoutDomain = await provider.discoverContacts({ name: 'Pump' }, ctx);
    expect(withDomain.contacts.every((row) => row.email?.endsWith('@pump.example'))).toBe(true);
    expect(withoutDomain.contacts.every((row) => row.email === undefined)).toBe(true);
  });

  it('returns all three deterministic email verdict classes', async () => {
    const provider = new SandboxDiscoveryProvider();
    const seen = new Set<string>();
    for (let i = 0; i < 1000 && seen.size < 3; i += 1) {
      seen.add((await provider.verifyEmail(`user-${i}@sandbox.example.com`)).status);
    }
    expect([...seen].sort()).toEqual(['INVALID', 'RISKY', 'VALID']);
  });
});
