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
  exaSearchTool,
  googlePlacesSearchTool,
  serperSearchTool,
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

  it('registers all four tools through registerBuiltinTools', () => {
    const registry = registerBuiltinTools(new ToolRegistry());
    expect(registry.get('serper.search')).toBe(serperSearchTool);
    expect(registry.get('brave.search')).toBe(braveSearchTool);
    expect(registry.get('exa.search')).toBe(exaSearchTool);
    expect(registry.get('google_places.search')).toBe(googlePlacesSearchTool);
  });
});
