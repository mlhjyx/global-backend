import { describe, expect, it, vi } from 'vitest';

const searx = vi.hoisted(() => ({ searxSearchPaged: vi.fn() }));
vi.mock('../adapters/searxng', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/searxng')>()),
  searxSearchPaged: searx.searxSearchPaged,
}));

import { searxngSearchTool } from './builtin-tools';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import type { ToolContext } from './tool-contract';

/** A SearXNG JSON result as it really arrives: engine metadata and a snippet besides url/title. */
function rawResult(i: number): Record<string, unknown> {
  return {
    url: `https://pumpen-${i}.example/produkte`,
    title: `Pumpen ${i} GmbH – Großhandel`,
    content: 'Ihr Ansprechpartner: Max Muster, max.muster@pumpen.example',
    engine: 'bing',
    engines: ['bing', 'duckduckgo'],
    positions: [i + 1],
    score: 1.5,
    template: 'default.html',
    category: 'general',
    publishedDate: null,
  };
}

const CTX = {} as ToolContext;

describe('searxng.search output fits its durable contract (searxng-search/v1)', () => {
  it('keeps only url and title, at most 20, so a real SearXNG page projects', async () => {
    // 2026-10-09 xin: every SearXNG page for the run's queries had 35-45 results with
    // 20+ engine fields each, so the closed searxng-search/v1 projection threw and
    // every public_web discovery query failed with BUDGET_OPERATION_REPLAY_UNAVAILABLE.
    searx.searxSearchPaged.mockResolvedValueOnce(Array.from({ length: 43 }, (_, i) => rawResult(i)));

    const result = await searxngSearchTool.execute({ q: 'Industriepumpen Großhandel', language: 'de' }, CTX);

    expect(result.data.results).toHaveLength(20);
    expect(result.data.results[0]).toEqual({
      url: 'https://pumpen-0.example/produkte',
      title: 'Pumpen 0 GmbH – Großhandel',
    });
    expect(JSON.stringify(result)).not.toMatch(/Max Muster|max\.muster@|engines|score/u);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('searxng-search/v1', result)).not.toThrow();
  });

  it('skips results without a usable url and bounds titles to the contract', async () => {
    searx.searxSearchPaged.mockResolvedValueOnce([
      { title: 'no url at all' },
      { url: `https://long.example/${'x'.repeat(2100)}`, title: 'url beyond the contract' },
      { url: 'https://untitled.example/' },
      { url: 'https://long-title.example/', title: 'T'.repeat(2500) },
    ]);

    const result = await searxngSearchTool.execute({ q: 'Pumpen', language: 'de' }, CTX);

    expect(result.data.results).toEqual([
      { url: 'https://untitled.example/' },
      { url: 'https://long-title.example/', title: 'T'.repeat(2000) },
    ]);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('searxng-search/v1', result)).not.toThrow();
  });
});
