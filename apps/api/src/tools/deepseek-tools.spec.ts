import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeepSeekFetchResponse,
  DeepSeekSearchResponse,
  deepSeekToolFetch,
  deepSeekToolSearch,
} from '../adapters/deepseek-tools';
import {
  createDeepSeekFetchTool,
  createDeepSeekSearchTool,
  DEEPSEEK_FETCH_MAX_CONTENT_CHARS,
  deepseekFetchTool,
  deepseekSearchTool,
} from './deepseek-tools';
import {
  registerCatalogResultProjections,
  CATALOG_RESULT_PROJECTION_SCHEMAS,
} from '../durable-results/catalog-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import {
  ExternalToolActionDeniedError,
  type ToolContext,
  type ToolResult,
} from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { registerBuiltinTools } from './builtin-tools';

const CTX = {} as ToolContext;

function projectionRegistry(): TypedProjectionRegistry {
  return registerCatalogResultProjections(new TypedProjectionRegistry());
}

type SearchDeps = Parameters<typeof deepSeekToolSearch>[1];
type FetchDeps = Parameters<typeof deepSeekToolFetch>[1];

/** Captures the exact input/deps the tool hands to the adapter; runs the wire fence like the real one. */
function searchAdapterFake(response: DeepSeekSearchResponse) {
  const calls: Array<{ input: { query: string; count: number }; deps: SearchDeps }> = [];
  const fn = (async (input: { query: string; count: number }, deps: SearchDeps = {}) => {
    calls.push({ input, deps });
    await deps.beforeRequest?.();
    return response;
  }) as typeof deepSeekToolSearch;
  return { fn, calls };
}

function fetchAdapterFake(response: DeepSeekFetchResponse) {
  const calls: Array<{ input: { url: string }; deps: FetchDeps }> = [];
  const fn = (async (input: { url: string }, deps: FetchDeps = {}) => {
    calls.push({ input, deps });
    await deps.beforeRequest?.();
    return response;
  }) as typeof deepSeekToolFetch;
  return { fn, calls };
}

beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-deepseek-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('deepseek.search tool', () => {
  it('keeps only durable url/title hits, drops person profiles and fits the projection', async () => {
    const url2048 = `https://bound.example/${'u'.repeat(2048 - 'https://bound.example/'.length)}`;
    const fake = searchAdapterFake({
      billed: true,
      hits: [
        { url: 'https://pumpen-schmid.example/produkte', title: 'Pumpen Schmid GmbH' },
        { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann' },
        { url: 'https://xing.com/profile/Max_Mustermann', title: 'Max Mustermann' },
        { url: `https://too-long.example/${'x'.repeat(2100)}` },
        { url: 'https://nul.example/\u0000' },
        { url: 'https://untitled.example/' },
        { url: 'https://long-title.example/', title: 'T'.repeat(2500) },
        { url: url2048, title: 'T'.repeat(2000) },
        ...Array.from({ length: 20 }, (_, index) => ({
          url: `https://filler-${index}.example/`,
        })),
      ],
    });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });

    const result = await tool.execute({ query: ' Industriepumpen Händler ', count: 50 }, CTX);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.input).toEqual({ query: 'Industriepumpen Händler', count: 20 });
    expect(result.costCents).toBe(1);
    expect(result.data.results).toHaveLength(20);
    expect(result.data.results.slice(0, 4)).toEqual([
      { url: 'https://pumpen-schmid.example/produkte', title: 'Pumpen Schmid GmbH' },
      { url: 'https://untitled.example/' },
      { url: 'https://long-title.example/', title: 'T'.repeat(2000) },
      { url: url2048, title: 'T'.repeat(2000) },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/linkedin|xing|Max Mustermann|nul\.example/u);
    expect(() =>
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['deepseek.search'], result),
    ).not.toThrow();
  });

  it('defaults to the provider count of 10 and reports an unbilled empty answer', async () => {
    const fake = searchAdapterFake({ hits: [], billed: false });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });

    const result = await tool.execute({ query: 'Pumpen' }, CTX);

    expect(fake.calls[0]!.input).toEqual({ query: 'Pumpen', count: 10 });
    expect(result).toEqual({ data: { results: [] }, costCents: 0 });
  });

  it('validates model-provided input before any wire', async () => {
    const fake = searchAdapterFake({ hits: [], billed: false });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });

    await expect(tool.execute({ query: ' ' }, CTX)).rejects.toThrow('DEEPSEEK_SEARCH_INPUT_INVALID');
    await expect(tool.execute({ query: 'x'.repeat(129) }, CTX)).rejects.toThrow(
      'DEEPSEEK_SEARCH_INPUT_INVALID',
    );
    await expect(tool.execute({ query: 'Pumpen', count: 0 }, CTX)).rejects.toThrow(
      'DEEPSEEK_SEARCH_INPUT_INVALID',
    );
    await expect(tool.execute({ query: 'Pumpen', count: 51 }, CTX)).rejects.toThrow(
      'DEEPSEEK_SEARCH_INPUT_INVALID',
    );
    await expect(
      tool.execute({ query: 'Pumpen', needContent: true as never }, CTX),
    ).rejects.toThrow('DEEPSEEK_SEARCH_CONTENT_NOT_PERMITTED');
    expect(fake.calls).toHaveLength(0);
  });

  it('degrades to an empty unbilled answer when the key is not configured', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const fake = searchAdapterFake({ hits: [{ url: 'https://never.example/' }], billed: true });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });

    const result = await tool.execute({ query: 'Pumpen' }, CTX);

    expect(result).toEqual({ data: { results: [] }, costCents: 0, degraded: true });
    expect(fake.calls).toHaveLength(0);
    expect(await tool.healthCheck()).toEqual({
      healthy: false,
      detail: 'DEEPSEEK_API_KEY not configured',
    });
  });

  it('rechecks the suppression gate before the physical wire and fails closed', async () => {
    const fake = searchAdapterFake({ hits: [{ url: 'https://ok.example/' }], billed: true });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });
    const authorizeExternalAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      tool.execute({ query: 'Pumpen' }, { authorizeExternalAction } as ToolContext),
    ).rejects.toThrow(ExternalToolActionDeniedError);
    expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
  });

  it('calls beforePhysicalWire immediately before sending', async () => {
    const events: string[] = [];
    const fake = searchAdapterFake({ hits: [{ url: 'https://ok.example/' }], billed: true });
    const tool = createDeepSeekSearchTool({ deepSeekSearch: fake.fn });

    await tool.execute(
      { query: 'Pumpen' },
      { beforePhysicalWire: async () => { events.push('wire'); } } as ToolContext,
    );
    expect(events).toEqual(['wire']);
  });

  it('drops paths and titles from a paid replay', () => {
    const replay = deepseekSearchTool.durableReplayResult?.({
      data: {
        results: [{
          url: 'https://news.example/people/jane-smith?author=Jane+Smith',
          title: 'Jane Smith appointed CEO',
        }],
      },
      costCents: 1,
    } as ToolResult<{ results: never[] }>);

    expect(replay).toEqual({
      data: { results: [{ url: 'https://news.example/' }] },
      costCents: 1,
    });
  });

  it('derives a stable idempotency key from the normalized input', () => {
    expect(deepseekSearchTool.idempotencyKey({ query: 'Pumpen', count: 10 })).toBe(
      deepseekSearchTool.idempotencyKey({ query: 'Pumpen', count: 10 }),
    );
    expect(deepseekSearchTool.idempotencyKey({ query: 'Pumpen', count: 10 })).not.toBe(
      deepseekSearchTool.idempotencyKey({ query: 'Pumpen', count: 20 }),
    );
  });
});

describe('deepseek.fetch tool', () => {
  function fetchTool(options: {
    response: DeepSeekFetchResponse;
    robotsAllowed?: boolean;
  }) {
    const fake = fetchAdapterFake(options.response);
    const robots = vi.fn(async () => options.robotsAllowed ?? true);
    const tool = createDeepSeekFetchTool({
      deepSeekFetch: fake.fn,
      isAllowedByRobots: robots as never,
    });
    return { tool, fake, robots };
  }

  it('returns bounded, durable page text and settles one cent only when billed', async () => {
    const content = `${'\u0000'.repeat(3)}${'Pumpen Schmid GmbH Impressum. '.repeat(2000)}\uD800tail`;
    const { tool, fake } = fetchTool({
      response: { title: 'T'.repeat(2500), content, billed: true },
    });

    const result = await tool.execute({ url: 'https://pumpen-schmid.example/impressum' }, CTX);

    expect(fake.calls[0]!.input).toEqual({ url: 'https://pumpen-schmid.example/impressum' });
    expect(result.costCents).toBe(1);
    expect(result.data.url).toBe('https://pumpen-schmid.example/impressum');
    expect(result.data.title).toBe('T'.repeat(2000));
    expect(result.data.content.length).toBeLessThanOrEqual(DEEPSEEK_FETCH_MAX_CONTENT_CHARS);
    expect(result.data.content).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(result.data.content).not.toContain(String.fromCharCode(0));
    expect(() =>
      projectionRegistry().project(CATALOG_RESULT_PROJECTION_SCHEMAS['deepseek.fetch'], result),
    ).not.toThrow();
  });

  it('settles nothing for an empty page and omits an empty title', async () => {
    const { tool } = fetchTool({ response: { content: '  ', billed: false } });

    const result = await tool.execute({ url: 'https://pumpen-schmid.example/leer' }, CTX);

    expect(result).toEqual({
      data: { url: 'https://pumpen-schmid.example/leer', content: '  ' },
      costCents: 0,
    });
  });

  it('abandons a robots-disallowed page without paying', async () => {
    const { tool, fake, robots } = fetchTool({
      response: { content: 'should never be fetched', billed: true },
      robotsAllowed: false,
    });

    const result = await tool.execute({ url: 'https://pumpen-schmid.example/privat' }, CTX);

    expect(robots).toHaveBeenCalledOnce();
    expect(fake.calls).toHaveLength(0);
    expect(result).toEqual({
      data: { url: 'https://pumpen-schmid.example/privat', content: '' },
      costCents: 0,
    });
  });

  it('rejects unusable target URLs before any wire', async () => {
    const { tool, fake, robots } = fetchTool({ response: { content: 'x', billed: true } });

    for (const url of [
      'file:///etc/passwd',
      'ftp://pumpen-schmid.example/',
      'https://user:secret@pumpen-schmid.example/',
      `https://pumpen-schmid.example/${'x'.repeat(2100)}`,
      'not a url',
    ]) {
      await expect(tool.execute({ url }, CTX)).rejects.toThrow('DEEPSEEK_FETCH_URL_INVALID');
    }
    expect(robots).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('fails closed on a suppression denial before the robots probe', async () => {
    const { tool, fake, robots } = fetchTool({ response: { content: 'x', billed: true } });

    await expect(
      tool.execute(
        { url: 'https://pumpen-schmid.example/' },
        { authorizeExternalAction: async () => false } as ToolContext,
      ),
    ).rejects.toThrow(ExternalToolActionDeniedError);
    expect(robots).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('degrades to an empty page when the key is not configured', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const { tool, fake, robots } = fetchTool({ response: { content: 'x', billed: true } });

    const result = await tool.execute({ url: 'https://pumpen-schmid.example/' }, CTX);

    expect(result).toEqual({
      data: { url: 'https://pumpen-schmid.example/', content: '' },
      costCents: 0,
      degraded: true,
    });
    expect(robots).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('surfaces provider failures instead of pretending an empty page', async () => {
    const failing = (async () => {
      throw new Error('DEEPSEEK_BALANCE_INSUFFICIENT');
    }) as typeof deepSeekToolFetch;
    const tool = createDeepSeekFetchTool({
      deepSeekFetch: failing,
      isAllowedByRobots: (async () => true) as never,
    });

    await expect(
      tool.execute({ url: 'https://pumpen-schmid.example/' }, CTX),
    ).rejects.toThrow('DEEPSEEK_BALANCE_INSUFFICIENT');
  });

  it('invokes beforePhysicalWire for the robots probe and the fetch wire', async () => {
    const events: string[] = [];
    const tool = createDeepSeekFetchTool({
      deepSeekFetch: (async (_input, deps = {}) => {
        await deps.beforeRequest?.();
        events.push('fetch-wire');
        return { content: '# ok', billed: true };
      }) as typeof deepSeekToolFetch,
      isAllowedByRobots: (async (_url: string, deps: {
        beforePhysicalWire?: () => Promise<void>;
      }) => {
        await deps.beforePhysicalWire?.();
        events.push('robots-wire');
        return true;
      }) as never,
    });

    await tool.execute(
      { url: 'https://pumpen-schmid.example/' },
      { beforePhysicalWire: async () => { events.push('wire'); } } as ToolContext,
    );
    expect(events).toEqual(['wire', 'robots-wire', 'wire', 'fetch-wire']);
  });
});

describe('deepseek tool registration', () => {
  it('registers both tools through the builtin registry', () => {
    const registry = registerBuiltinTools(new ToolRegistry());

    expect(registry.get('deepseek.search')).toBe(deepseekSearchTool);
    expect(registry.get('deepseek.fetch')).toBe(deepseekFetchTool);
  });
});
