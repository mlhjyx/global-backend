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

  it('keeps values exactly at the contract bounds', async () => {
    const url2048 = `https://bound.example/${'u'.repeat(2048 - 'https://bound.example/'.length)}`;
    searx.searxSearchPaged.mockResolvedValueOnce([
      { url: url2048, title: 'T'.repeat(2000) },
      { url: `${url2048}u`, title: 'one past the url bound' },
      { url: 'https://title.example/', title: 'T'.repeat(2001) },
    ]);

    const result = await searxngSearchTool.execute({ q: 'Pumpen', language: 'de' }, CTX);

    expect(result.data.results).toEqual([
      { url: url2048, title: 'T'.repeat(2000) },
      { url: 'https://title.example/', title: 'T'.repeat(2000) },
    ]);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('searxng-search/v1', result)).not.toThrow();
  });

  it('makes provider text durable instead of failing the whole page', async () => {
    // The projection rejects text that is not NFC, holds NUL or a lone surrogate; one such
    // title used to fail the page, leave the operation RESERVED and end the run.
    searx.searxSearchPaged.mockResolvedValueOnce([
      { url: 'https://nfd.example/', title: 'Müller Pumpen' },
      { url: 'https://ohm.example/', title: 'Widerstand 10 kΩ' },
      { url: 'https://nul.example/', title: 'Pumpen\u0000Handel' },
      { url: 'https://lone.example/', title: 'Pumpen \uD800 Handel' },
      { url: 'https://pair.example/', title: `${'T'.repeat(1999)}\u{1F600}` },
      { url: 'https://nfc.example/', title: 'Müller' },
      { url: 'https://nfd-url.example/Müller', title: 'a URL is dropped, never rewritten' },
      { url: 'https://nul-url.example/\u0000', title: 'NUL in the URL' },
      { url: 'https://lone-url.example/\uDC00', title: 'lone surrogate in the URL' },
    ]);

    const result = await searxngSearchTool.execute({ q: 'Pumpen', language: 'de' }, CTX);

    expect(result.data.results).toEqual([
      { url: 'https://nfd.example/', title: 'Müller Pumpen' },
      { url: 'https://ohm.example/', title: 'Widerstand 10 kΩ' },
      { url: 'https://nul.example/', title: 'PumpenHandel' },
      { url: 'https://lone.example/', title: 'Pumpen � Handel' },
      { url: 'https://pair.example/', title: 'T'.repeat(1999) },
      { url: 'https://nfc.example/', title: 'Müller' },
    ]);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('searxng-search/v1', result)).not.toThrow();
  });

  it('drops profile pages of individual people before taking the first 20', async () => {
    // 2026-10-09 xin: a role query returned de.linkedin.com/in/<name> and xing.com/profile/<Name>
    // hits whose URL and title name a person; this company-level tool must not return or persist them.
    const profiles = [
      'https://de.linkedin.com/in/max-muster-123',
      'https://www.linkedin.com/pub/max-muster/1/2/3',
      'https://linkedin.com/in/erika',
      'https://www.xing.com/profile/Max_Muster5',
      'https://WWW.XING.COM/profile/Erika_Muster/cv',
    ].map((url) => ({ url, title: 'Max Muster – Geschäftsführer – Pumpen GmbH' }));
    const companyPages = [
      { url: 'https://www.linkedin.com/company/pumpen-gmbh', title: 'Pumpen GmbH | LinkedIn' },
      { url: 'https://www.xing.com/pages/pumpen-gmbh', title: 'Pumpen GmbH | XING' },
    ];
    const sites = Array.from({ length: 20 }, (_, i) => ({ url: `https://pumpen-${i}.example/`, title: `Pumpen ${i} GmbH` }));
    searx.searxSearchPaged.mockResolvedValueOnce([...profiles, ...companyPages, ...sites]);

    const result = await searxngSearchTool.execute({ q: 'Geschäftsführer Pumpen', language: 'de' }, CTX);

    expect(result.data.results).toEqual([...companyPages, ...sites.slice(0, 18)]);
    expect(JSON.stringify(result)).not.toMatch(/Max Muster|Erika/u);
  });
});
