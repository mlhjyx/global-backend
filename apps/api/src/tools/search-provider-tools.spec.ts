import { describe, expect, it, vi } from 'vitest';
import {
  CATALOG_RESULT_PROJECTION_SCHEMAS,
  registerCatalogResultProjections,
} from '../durable-results/catalog-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import {
  braveSearchTool,
  createBraveSearchTool,
  createExaSearchTool,
  createGooglePlacesSearchTool,
  createSerperSearchTool,
  createSocialExaPeopleTool,
  createSocialSerperSearchTool,
  exaSearchTool,
  googlePlacesSearchTool,
  serperSearchTool,
  socialExaPeopleTool,
  socialSerperSearchTool,
} from './search-provider-tools';
import { registerBuiltinTools } from './builtin-tools';
import { ToolRegistry } from './tool-registry';
import type { ToolContext } from './tool-contract';

function projectionRegistry(): TypedProjectionRegistry {
  return registerCatalogResultProjections(new TypedProjectionRegistry());
}

describe('L0 search provider tools (serper.search / exa.search / google_places.search)', () => {
  it('degrades cleanly to costCents=0 when API keys are absent', async () => {
    const ctx: ToolContext = { workspaceId: 'ws', purpose: 'discovery' };
    const serper = createSerperSearchTool({
      serperSearch: vi.fn(),
      resolveApiKey: () => undefined,
    });
    const exa = createExaSearchTool({
      exaSearch: vi.fn(),
      exaFindSimilar: vi.fn(),
      resolveApiKey: () => undefined,
    });
    const places = createGooglePlacesSearchTool({
      googlePlacesSearchText: vi.fn(),
      resolveApiKey: () => undefined,
    });

    expect(await serper.execute({ query: 'solar EPC Germany' }, ctx)).toEqual({
      data: { results: [] },
      costCents: 0,
      degraded: true,
    });
    expect(await exa.execute({ query: 'HJT solar distributors' }, ctx)).toEqual({
      data: { results: [] },
      costCents: 0,
      degraded: true,
    });
    expect(await places.execute({ textQuery: 'solar wholesaler Milan' }, ctx)).toEqual({
      data: { places: [] },
      costCents: 0,
      degraded: true,
    });
  });

  it('serper.search strips personal profile URLs, invokes beforePhysicalWire, and projects validly', async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    const tool = createSerperSearchTool({
      resolveApiKey: () => 'serper-key',
      serperSearch: vi.fn(async (_input, deps) => {
        await deps?.beforeRequest?.();
        return {
          billed: true,
          hits: [
            { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann' },
            { url: 'https://solar-partner.de/about', title: 'Solar Partner GmbH' },
          ],
        };
      }),
    });

    const result = await tool.execute(
      { query: 'Photovoltaik Großhandel', gl: 'de', hl: 'de' },
      { workspaceId: 'ws', purpose: 'discovery', beforePhysicalWire },
    );

    expect(beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      data: { results: [{ url: 'https://solar-partner.de/about', title: 'Solar Partner GmbH' }] },
      costCents: 1,
    });
    const projected = projectionRegistry().project(
      CATALOG_RESULT_PROJECTION_SCHEMAS['serper.search'],
      result,
    );
    expect(projected.data).toEqual(result);
    expect(tool.durableReplayResult?.(result)).toEqual({
      data: { results: [{ url: 'https://solar-partner.de/' }] },
      costCents: 1,
    });
  });

  it('exa.search supports find_similar mode and projects validly', async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    const exaFindSimilar = vi.fn(async (_input, deps) => {
      await deps?.beforeRequest?.();
      return {
        billed: true,
        hits: [{ url: 'https://eu-solar-wholesale.nl/', title: 'EU Solar Wholesale B.V.' }],
      };
    });
    const tool = createExaSearchTool({
      resolveApiKey: () => 'exa-key',
      exaSearch: vi.fn(),
      exaFindSimilar,
    });

    const result = await tool.execute(
      { mode: 'find_similar', similarUrl: 'https://krannich-solar.com/', numResults: 5 },
      { workspaceId: 'ws', purpose: 'discovery', beforePhysicalWire },
    );

    expect(beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(exaFindSimilar).toHaveBeenCalledTimes(1);
    expect(result.data.results).toEqual([
      { url: 'https://eu-solar-wholesale.nl/', title: 'EU Solar Wholesale B.V.' },
    ]);
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['exa.search'], result).data,
    ).toEqual(result);
  });

  it('google_places.search obeys D4 §3.2.3 by retaining only placeId on durable replay', async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    const tool = createGooglePlacesSearchTool({
      resolveApiKey: () => 'maps-key',
      googlePlacesSearchText: vi.fn(async (_input, deps) => {
        await deps?.beforeRequest?.();
        return {
          billed: true,
          places: [
            {
              placeId: 'ChIJ_abc_123',
              name: 'Fotovoltaico Italia S.r.l.',
              websiteUri: 'https://fotovoltaico-italia.it/',
              countryCode: 'IT',
            },
          ],
        };
      }),
    });

    const result = await tool.execute(
      { textQuery: 'fotovoltaico grossista Milano', regionCode: 'IT', languageCode: 'it' },
      { workspaceId: 'ws', purpose: 'discovery', beforePhysicalWire },
    );

    expect(beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(result.costCents).toBe(4);
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['google_places.search'], result).data,
    ).toEqual(result);
    expect(tool.durableReplayResult?.(result)).toEqual({
      data: { places: [{ placeId: 'ChIJ_abc_123' }] },
      costCents: 4,
    });
  });

  it('brave.search degrades cleanly when key absent, strips LinkedIn /in/, and projects validly', async () => {
    const ctx: ToolContext = { workspaceId: 'ws', purpose: 'discovery' };
    const unconfigured = createBraveSearchTool({
      braveSearch: vi.fn(),
      resolveApiKey: () => undefined,
    });
    expect(await unconfigured.execute({ query: 'HJT solar EPC' }, ctx)).toEqual({
      data: { results: [] },
      costCents: 0,
      degraded: true,
    });

    const beforePhysicalWire = vi.fn(async () => undefined);
    const configured = createBraveSearchTool({
      resolveApiKey: () => 'brave-key',
      braveSearch: vi.fn(async (_input, deps) => {
        await deps?.beforeRequest?.();
        return {
          billed: true,
          hits: [
            { url: 'https://www.linkedin.com/in/mario-rossi', title: 'Mario Rossi' },
            { url: 'https://coesaenergy.it/fotovoltaico', title: 'Coesa Energy S.r.l.' },
          ],
        };
      }),
    });
    const res = await configured.execute(
      { query: 'fotovoltaico EPC Italia', country: 'IT', searchLang: 'it' },
      { workspaceId: 'ws', purpose: 'discovery', beforePhysicalWire },
    );
    expect(beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      data: { results: [{ url: 'https://coesaenergy.it/fotovoltaico', title: 'Coesa Energy S.r.l.' }] },
      costCents: 1,
    });
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['brave.search'], res).data,
    ).toEqual(res);
  });

  it('social.search_serper & social.search_exa_people keep only person profile URLs, preserve full replay, and degrade cleanly', async () => {
    const ctx: ToolContext = { workspaceId: 'ws', purpose: 'discovery' };
    const noKeySerper = createSocialSerperSearchTool({
      serperSearch: vi.fn(),
      resolveApiKey: () => undefined,
    });
    const noKeyExa = createSocialExaPeopleTool({
      exaSearch: vi.fn(),
      resolveApiKey: () => undefined,
    });
    expect(await noKeySerper.execute({ query: 'site:linkedin.com/in "Coenergia"' }, ctx)).toEqual({
      data: { results: [] },
      costCents: 0,
      degraded: true,
    });
    expect(await noKeyExa.execute({ query: 'Coenergia Responsabile Acquisti' }, ctx)).toEqual({
      data: { results: [] },
      costCents: 0,
      degraded: true,
    });

    const beforePhysicalWire = vi.fn(async () => undefined);
    const serper = createSocialSerperSearchTool({
      resolveApiKey: () => 'serper-key',
      serperSearch: vi.fn(async (_input, deps) => {
        await deps?.beforeRequest?.();
        return {
          billed: true,
          hits: [
            { url: 'https://it.linkedin.com/in/marco-rossi', title: 'Marco Rossi - Responsabile Acquisti - Coenergia Srl' },
            { url: 'https://www.linkedin.com/company/coenergia', title: 'Coenergia Srl | LinkedIn' },
            { url: 'https://www.linkedin.com/posts/coenergia_pv-123', title: 'Coenergia post' },
            { url: 'https://www.xing.com/profile/Max_Mustermann', title: 'Max Mustermann - Einkauf - Coenergia' },
          ],
        };
      }),
    });
    const serperRes = await serper.execute(
      { query: 'site:linkedin.com/in "Coenergia"', gl: 'it', num: 10 },
      { workspaceId: 'ws', purpose: 'enrichment', beforePhysicalWire },
    );
    expect(beforePhysicalWire).toHaveBeenCalledTimes(1);
    expect(serperRes).toEqual({
      data: {
        results: [
          { url: 'https://it.linkedin.com/in/marco-rossi', title: 'Marco Rossi - Responsabile Acquisti - Coenergia Srl' },
          { url: 'https://www.xing.com/profile/Max_Mustermann', title: 'Max Mustermann - Einkauf - Coenergia' },
        ],
      },
      costCents: 1,
    });
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['social.search_serper'], serperRes).data,
    ).toEqual(serperRes);
    expect(serper.durableReplayResult?.(serperRes)).toEqual(serperRes);

    const exaSearchMock = vi.fn(async (input, deps) => {
      expect(input.category).toBe('people');
      await deps?.beforeRequest?.();
      return {
        billed: true,
        hits: [
          { url: 'https://www.linkedin.com/in/elena-conti', title: 'Elena Conti - Direttore Tecnico - ReFeel EPC' },
          { url: 'https://www.linkedin.com/posts/refeel_solar', title: 'Post' },
        ],
      };
    });
    const exa = createSocialExaPeopleTool({
      resolveApiKey: () => 'exa-key',
      exaSearch: exaSearchMock,
    });
    const exaRes = await exa.execute(
      { query: 'ReFeel EPC Direttore Tecnico', numResults: 10 },
      { workspaceId: 'ws', purpose: 'enrichment', beforePhysicalWire },
    );
    expect(beforePhysicalWire).toHaveBeenCalledTimes(2);
    expect(exaRes).toEqual({
      data: {
        results: [
          { url: 'https://www.linkedin.com/in/elena-conti', title: 'Elena Conti - Direttore Tecnico - ReFeel EPC' },
        ],
      },
      costCents: 1,
    });
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['social.search_exa_people'], exaRes).data,
    ).toEqual(exaRes);
    expect(exa.durableReplayResult?.(exaRes)).toEqual(exaRes);
  });

  it('registers all six search provider tools through registerBuiltinTools', () => {
    const registry = registerBuiltinTools(new ToolRegistry());
    expect(registry.get('serper.search')).toBe(serperSearchTool);
    expect(registry.get('brave.search')).toBe(braveSearchTool);
    expect(registry.get('exa.search')).toBe(exaSearchTool);
    expect(registry.get('google_places.search')).toBe(googlePlacesSearchTool);
    expect(registry.get('social.search_serper')).toBe(socialSerperSearchTool);
    expect(registry.get('social.search_exa_people')).toBe(socialExaPeopleTool);
  });

  it('social tools retain redacted <=240-char snippet & <=3 highlights while keeping non-social tools snippet-free', async () => {
    const serperSocial = createSocialSerperSearchTool({
      resolveApiKey: () => 'serper-key',
      serperSearch: vi.fn(async (input) => {
        expect(input.includeSnippet).toBe(true);
        return {
          billed: true,
          hits: [
            {
              url: 'https://it.linkedin.com/in/kieran-nolan-bbb26167',
              title: 'Kieran Nolan | LinkedIn',
              snippet: `Purchasing Manager at Tavia Energy (2020-2026). Contact contact@taviaenergy.example or +39 030 1234567. ${'x'.repeat(300)}`,
            },
          ],
        };
      }),
    });

    const serperRes = await serperSocial.execute(
      { query: 'site:linkedin.com/in "Tavia Energy"' },
      { workspaceId: 'ws', purpose: 'enrichment' },
    );
    const serperItem = serperRes.data.results[0];
    expect(serperItem.snippet).toBeDefined();
    expect(serperItem.snippet!.length).toBeLessThanOrEqual(240);
    expect(serperItem.snippet).toContain('2020-2026');
    expect(serperItem.snippet).not.toContain('contact@taviaenergy.example');
    expect(serperItem.snippet).not.toContain('1234567');
    expect(serperItem.snippet).toContain('[redacted]');
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['social.search_serper'], serperRes).data,
    ).toEqual(serperRes);
    expect(serperSocial.durableReplayResult?.(serperRes)).toEqual(serperRes);

    const exaSocial = createSocialExaPeopleTool({
      resolveApiKey: () => 'exa-key',
      exaSearch: vi.fn(async (input) => {
        expect(input.category).toBe('people');
        return {
          billed: true,
          hits: [
            {
              url: 'https://it.linkedin.com/in/miralevinnovacrest',
              title: 'Mira Levin | LinkedIn',
              snippet: 'Head of Sales at Novacrest S.r.l.',
              highlights: [
                'Reach me at mira@novacrest.example or (02) 555-1234',
                `Highlight 2 ${'y'.repeat(260)}`,
                'Highlight 3',
                'Highlight 4 should be dropped',
              ],
            },
          ],
        };
      }),
    });
    const exaRes = await exaSocial.execute(
      { query: 'Novacrest S.r.l.' },
      { workspaceId: 'ws', purpose: 'enrichment' },
    );
    const exaItem = exaRes.data.results[0];
    expect(exaItem.highlights).toHaveLength(3);
    expect(exaItem.highlights![0]).not.toContain('mira@novacrest.example');
    expect(exaItem.highlights![0]).not.toContain('555-1234');
    expect(exaItem.highlights![1].length).toBeLessThanOrEqual(240);
    expect(
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['social.search_exa_people'], exaRes).data,
    ).toEqual(exaRes);
    expect(exaSocial.durableReplayResult?.(exaRes)).toEqual(exaRes);
  });

  it('retains role context while removing formatted contact details and unnecessary URL parts', async () => {
    const profile = {
      url: 'https://www.linkedin.com/in/lexi-novel?invite=direct%40example.test#details',
      title: 'Lexi Novel - Director at Sunforge - 030 1234 5678',
      snippet: 'Procurement at Sunforge (2020-2026). Tel: 030 / 123 45 67 ext. 42. Write to buyer&#64;example.test.',
      highlights: [
        'Operations at Sunforge. WhatsApp +39 (0) 2 1234 5678. Mail lexi [at] example [dot] test.',
      ],
    };
    const tool = createSocialSerperSearchTool({
      resolveApiKey: () => 'test-serper-key',
      serperSearch: async () => ({ billed: true, hits: [profile] }),
    });
    const result = await tool.execute({ query: 'Sunforge' }, { workspaceId: 'ws', purpose: 'enrichment' });
    const hit = result.data.results[0];
    expect(hit?.url).toBe('https://www.linkedin.com/in/lexi-novel');
    expect(hit?.title).toContain('Director at Sunforge');
    expect(hit?.snippet).toContain('Procurement at Sunforge (2020-2026)');
    expect(hit?.highlights?.[0]).toContain('Operations at Sunforge');
    expect(JSON.stringify(hit)).not.toMatch(/1234|123 45 67|ext\. 42|buyer|\[at\]|invite=/u);
    expect(tool.durableReplayResult?.(result)).toEqual(result);
  });

  it('revalidates paid-ledger URL/title readback and keeps ordinary older typed projections recoverable', () => {
    const registry = projectionRegistry();
    const schema = CATALOG_RESULT_PROJECTION_SCHEMAS['social.search_serper'];
    const legacy = {
      data: { results: [{ url: 'https://www.linkedin.com/in/lexi-novel', title: 'Lexi Novel - Director at Sunforge' }] },
      costCents: 1,
    };
    const projection = registry.project(schema, legacy);
    expect(registry.restore(projection)).toEqual(legacy);
    expect(registry.project(schema, registry.restore(projection)).digest).toBe(projection.digest);
    expect(socialSerperSearchTool.durableReplayResult?.(legacy)).toEqual(legacy);
    expect(socialSerperSearchTool.durableReplayResult?.({
      ...legacy,
      data: {
        results: [
          { url: 'https://user:password@www.linkedin.com/in/lexi-novel', title: 'Invalid entry' },
          { url: 'https://www.linkedin.com/in/lexi-novel?email=private%40example.test', title: 'Lexi Novel - Director at Sunforge' },
        ],
      },
    })).toEqual(legacy);
  });
});
