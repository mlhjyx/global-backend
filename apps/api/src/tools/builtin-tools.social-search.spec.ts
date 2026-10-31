import { describe, expect, it, vi } from 'vitest';

const searx = vi.hoisted(() => ({ searxSearchPaged: vi.fn() }));
vi.mock('../adapters/searxng', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/searxng')>()),
  searxSearchPaged: searx.searxSearchPaged,
}));

import { socialSearchTool } from './builtin-tools';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import type { ToolContext } from './tool-contract';

/** A SearXNG JSON result as it really arrives: engine metadata and a snippet besides url/title. */
function rawResult(url: string, title?: string): Record<string, unknown> {
  return {
    url,
    ...(title === undefined ? {} : { title }),
    content: 'Ihr Ansprechpartner: Max Muster, max.muster@pumpen.example',
    engine: 'bing',
    engines: ['bing', 'duckduckgo'],
    positions: [1],
    score: 1.5,
    category: 'general',
  };
}

const CTX = {} as ToolContext;

describe('social.search keeps only public person-profile pages (personalData tool)', () => {
  it('keeps LinkedIn /in+/pub and Xing /profile results, drops company pages and other sites', async () => {
    searx.searxSearchPaged.mockResolvedValueOnce([
      rawResult('https://de.linkedin.com/in/max-mustermann-123', 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn'),
      rawResult('https://www.linkedin.com/pub/erika-musterfrau/12/345/678', 'Erika Musterfrau | LinkedIn'),
      rawResult('https://www.xing.com/profile/Max_Mustermann', 'Max Mustermann - Einkaufsleiter - Pumpen Schmid | XING'),
      rawResult('https://www.linkedin.com/company/pumpen-schmid', 'Pumpen Schmid GmbH | LinkedIn'),
      rawResult('https://pumpen-schmid.de/team', 'Team – Pumpen Schmid'),
      rawResult('not a url'),
    ]);

    const result = await socialSearchTool.execute({ q: 'site:linkedin.com/in "Pumpen Schmid"', language: 'de' }, CTX);

    expect(result.data.results.map((item) => item.url)).toEqual([
      'https://de.linkedin.com/in/max-mustermann-123',
      'https://www.linkedin.com/pub/erika-musterfrau/12/345/678',
      'https://www.xing.com/profile/Max_Mustermann',
    ]);
    expect(result.data.results[0]!.title).toContain('Einkaufsleiter');
    // 摘要/引擎元数据不出工具（工具声明 personalData:true，但只保留 URL+标题）。
    expect(JSON.stringify(result)).not.toMatch(/max\.muster@|engines|score/u);
    expect(socialSearchTool.compliance.personalData).toBe(true);
  });

  it('projects and restores through social-search/v1 (PERSONAL_DATA typed projection)', async () => {
    searx.searxSearchPaged.mockResolvedValueOnce([
      rawResult('https://www.xing.com/profile/Max_Mustermann', 'Max Mustermann - Einkaufsleiter - Pumpen Schmid | XING'),
    ]);

    const result = await socialSearchTool.execute({ q: 'site:xing.com/profile "Pumpen Schmid"', language: 'de' }, CTX);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    const projected = registry.project('social-search/v1', result) as unknown as {
      data: { data: { results: Array<{ url: string; title?: string }> }; costCents: number };
    };
    expect(projected.data.data.results[0]).toMatchObject({
      url: 'https://www.xing.com/profile/Max_Mustermann',
      title: expect.stringContaining('Einkaufsleiter'),
    });
    expect(registry.restore(JSON.parse(JSON.stringify(projected)))).toMatchObject({
      data: {
        results: [
          {
            url: 'https://www.xing.com/profile/Max_Mustermann',
            title: expect.stringContaining('Einkaufsleiter'),
          },
        ],
      },
    });
  });

  it('bounds url length and title and drops results beyond the contract', async () => {
    searx.searxSearchPaged.mockResolvedValueOnce([
      rawResult(`https://www.linkedin.com/in/${'x'.repeat(2100)}`, 'url beyond the contract'),
      rawResult('https://www.linkedin.com/in/untitled-person'),
      rawResult('https://www.linkedin.com/in/long-title', 'T'.repeat(2500)),
    ]);

    const result = await socialSearchTool.execute({ q: 'site:linkedin.com/in "Pumpen"', language: 'de' }, CTX);

    expect(result.data.results.map((item) => item.url)).toEqual([
      'https://www.linkedin.com/in/untitled-person',
      'https://www.linkedin.com/in/long-title',
    ]);
    expect(result.data.results[0]!.title).toBeUndefined();
    expect(result.data.results[1]!.title).toHaveLength(2000);
    const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(() => registry.project('social-search/v1', result)).not.toThrow();
  });
});
