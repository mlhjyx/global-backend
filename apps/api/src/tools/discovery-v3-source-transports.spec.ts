import { request } from 'node:https';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import { crawl4aiFetchTool, osmOverpassTool, searxngSearchTool } from './builtin-tools';
import {
  companiesHouseSearchTool,
  httpGetTool,
  openCorporatesSearchTool,
  tedSearchTool,
  tradeFairAlgoliaTool,
} from './source-tools';
import type { Tool, ToolContext, ToolResult } from './tool-contract';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: vi.fn() }));
vi.mock('node:http', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:http')>()), request: vi.fn() }));

type DiscoveryContext = ToolContext & Required<Pick<ToolContext, 'dispatchDiscoveryV3Wire'>>;
type Send = (options: RequestOptions, body: unknown) => void;

function invokeNative<I, O>(tool: Tool<I, O>, input: I, ctx: DiscoveryContext): Promise<ToolResult<O>> {
  return tool.executeDiscoveryV3 ? tool.executeDiscoveryV3(input, ctx) : tool.execute(input, ctx);
}

function stubHttps(args: {
  body?: unknown;
  rawBody?: (path: string) => string;
  status?: number;
  headers?: Record<string, string> | ((path: string) => Record<string, string>);
  onSend: Send;
}, transport: typeof request = request): void {
  vi.mocked(transport).mockImplementation((options: RequestOptions, onResponse: (response: IncomingMessage) => void) => {
    const client = new EventEmitter() as ClientRequest;
    client.end = ((body?: Buffer) => {
      args.onSend(options, body ? body.toString('utf8') : undefined);
      const raw = args.rawBody?.(options.path ?? '') ?? JSON.stringify(args.body ?? {});
      const response = Object.assign(Readable.from([Buffer.from(raw)]), {
        headers: typeof args.headers === 'function' ? args.headers(options.path ?? '') : args.headers ?? {},
        statusCode: args.status ?? 200,
      }) as IncomingMessage;
      onResponse(response);
      return client;
    }) as ClientRequest['end'];
    return client;
  });
}

const osmInput = { areaName: 'Berlin', tagFilters: [{ k: 'craft', v: 'blacksmith' }], limit: 10 };
const tedInput = { kind: 'award' as const, params: { cpvCodes: ['421*'], maxRecords: 2 } };
const chInput = { op: 'search' as const, query: 'Example Pumps', limit: 5 };
const corporateInput = { query: 'Example Pumps', countryCode: 'DE', limit: 5 };
const algoliaInput = { fairSlug: 'euroblech-2026', page: 2, limit: 3 };

const transports = [
  {
    host: 'overpass-api.de', method: 'POST', path: '/api/interpreter',
    run: (ctx: DiscoveryContext) => invokeNative(osmOverpassTool, osmInput, ctx),
    response: { elements: [{ type: 'node', id: 1, lat: 52, lon: 13, tags: { name: 'Example GmbH', craft: 'blacksmith' } }] },
    expected: { places: [{ name: 'Example GmbH' }] },
  },
  {
    host: 'api.ted.europa.eu', method: 'POST', path: '/v3/notices/search',
    run: (ctx: DiscoveryContext) => invokeNative(tedSearchTool, tedInput, ctx),
    response: { notices: [{ 'publication-number': '100-2026' }], iterationNextToken: 'next-page' },
    expected: { awards: [{ publicationNumber: '100-2026' }] },
  },
  {
    host: 'api.company-information.service.gov.uk', method: 'GET', path: '/search/companies?q=Example+Pumps&items_per_page=5',
    run: (ctx: DiscoveryContext) => invokeNative(companiesHouseSearchTool, chInput, ctx),
    response: { items: [{ title: 'Example Pumps Ltd', company_number: '01234567', company_status: 'active', address_snippet: 'fixture street' }] },
    expected: { companies: [{ title: 'Example Pumps Ltd', companyNumber: '01234567' }] },
  },
  {
    host: 'api.opencorporates.com', method: 'GET', path: '/v0.4/companies/search?q=Example+Pumps&jurisdiction_code=de&per_page=5&api_token=fixture',
    run: (ctx: DiscoveryContext) => invokeNative(openCorporatesSearchTool, corporateInput, ctx),
    response: { results: { companies: [{ company: { name: 'Example Pumps GmbH', company_number: 'HRB1234', jurisdiction_code: 'de' } }] } },
    expected: { companies: [{ name: 'Example Pumps GmbH', companyNumber: 'HRB1234' }] },
  },
  {
    host: 'xd0u5m6y4r-dsn.algolia.net', method: 'POST', path: /^\/1\/indexes\/evt-.+\/query$/,
    run: (ctx: DiscoveryContext) => invokeNative(tradeFairAlgoliaTool, algoliaInput, ctx),
    response: {
      hits: [{ objectID: '123', companyName: 'Example Expo Ltd', email: 'person@example.invalid', phone: '0000', exhibitorDescription: 'contact name' }],
      nbPages: 8,
    },
    expected: { exhibitors: [{ externalId: '123', companyName: 'Example Expo Ltd', products: [] }] },
  },
];

describe('native discovery source wires', () => {
  const controller = new AbortController();
  const legacyFetch = vi.fn(async () => { throw new Error('legacy fetch attempted'); });
  let events: string[];

  beforeEach(() => {
    events = [];
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'fixture');
    vi.stubEnv('OPENCORPORATES_API_TOKEN', 'fixture');
    vi.stubEnv('HTTP_FIRST_MIN_CHARS', '200');
    vi.stubGlobal('fetch', legacyFetch);
    vi.mocked(request).mockReset();
    vi.mocked(httpRequest).mockReset();
    // Never resolve an external host. Enough to exercise guarded HTTP's pinning boundary.
    vi.mocked(lookup).mockReset().mockImplementation(async () => {
      events.push('dns');
      return [{ address: '93.184.216.34', family: 4 }];
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    legacyFetch.mockClear();
  });

  function context(): DiscoveryContext {
    return {
      workspaceId: 'test', purpose: 'discovery',
      async checkDiscoveryV3Robots(_target, prepare) {
        const read = await prepare();
        events.push('fence:robots');
        const result = await read(controller.signal);
        events.push('read:robots');
        return result;
      },
      async dispatchDiscoveryV3Wire(send) {
        events.push('fence');
        const result = await send(controller.signal);
        events.push('read');
        return result;
      },
    };
  }

  it.each(transports)('$host sends exactly one pinned request inside the fence', async (test) => {
    const onSend = vi.fn<Send>((options) => {
      expect(options.hostname).toBe(test.host);
      expect(options.method).toBe(test.method);
      expect(options.signal).toBe(controller.signal);
      if (typeof test.path === 'string') expect(options.path).toBe(test.path);
      else expect(options.path).toMatch(test.path);
      events.push('wire');
    });
    stubHttps({ body: test.response, onSend });

    const result = await test.run(context());

    expect(result.data).toMatchObject(test.expected);
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
    expect(onSend).toHaveBeenCalledOnce();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('does not send a request when the fence denies it', async () => {
    await expect(invokeNative(osmOverpassTool, osmInput, {
      ...context(),
      async dispatchDiscoveryV3Wire() {
        events.push('fence');
        throw new Error('fixture fence denied');
      },
    })).rejects.toThrow('fixture fence denied');
    expect(events).toEqual(['dns', 'fence']);
    expect(request).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('rejects another DNS destination before consuming a wire', async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    await expect(invokeNative(openCorporatesSearchTool, corporateInput, context())).rejects.toMatchObject({
      name: 'EgressBlockedError', code: 'non_global_address',
    });
    expect(events).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('does not retry a failed native request or switch Overpass mirrors', async () => {
    stubHttps({ status: 503, onSend: () => { events.push('wire'); } });
    await expect(invokeNative(osmOverpassTool, osmInput, context())).rejects.toThrow('503');
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
    expect(request).toHaveBeenCalledOnce();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('does not follow a redirect containing an authenticated request', async () => {
    stubHttps({
      status: 302, headers: { location: 'https://mirror.example.invalid/follow' },
      onSend: () => { events.push('wire'); },
    });
    await expect(invokeNative(openCorporatesSearchTool, corporateInput, context())).rejects.toMatchObject({
      name: 'EgressBlockedError', code: 'too_many_redirects',
    });
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
    expect(request).toHaveBeenCalledOnce();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('rejects a response above the native JSON byte bound', async () => {
    stubHttps({ headers: { 'content-length': '5000001' }, onSend: () => { events.push('wire'); } });
    await expect(invokeNative(companiesHouseSearchTool, chInput, context())).rejects.toMatchObject({
      name: 'EgressBlockedError', code: 'response_too_large',
    });
    expect(events).toEqual(['dns', 'fence', 'wire']);
  });

  it('blocks an officers request from the native company-search arm', async () => {
    await expect(invokeNative(companiesHouseSearchTool, { op: 'officers', companyNumber: '01234567' }, context())).rejects.toThrow();
    expect(events).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('uses the native TED field allowlist in a first-page search', async () => {
    const onSend = vi.fn<Send>();
    stubHttps({ body: { notices: [], iterationNextToken: 'next-page' }, onSend });
    await invokeNative(tedSearchTool, tedInput, context());
    const body = JSON.parse(String(onSend.mock.calls[0]?.[1]));
    expect(body).toMatchObject({ limit: 2, paginationMode: 'ITERATION' });
    expect(body.fields).toContain('winner-name');
    expect(body.fields).not.toContain('winner-email');
    expect(body).not.toHaveProperty('iterationNextToken');
  });

  it('requests only company fields from a specific Algolia page and omits raw contact fields', async () => {
    const onSend = vi.fn<Send>();
    stubHttps({
      body: { hits: [{ objectID: '123', companyName: 'Example Expo Ltd', email: 'private', phone: 'private', exhibitorDescription: 'private' }], nbPages: 8 },
      onSend,
    });
    const result = await invokeNative(tradeFairAlgoliaTool, algoliaInput, context());
    const body = JSON.parse(String(onSend.mock.calls[0]?.[1]));
    const pageParams = new URLSearchParams(body.params);
    expect(pageParams.get('page')).toBe('2');
    expect(pageParams.get('hitsPerPage')).toBe('3');
    expect(pageParams.get('attributesToRetrieve')).toContain('companyName');
    expect(pageParams.get('attributesToRetrieve')).not.toMatch(/email|phone|description/i);
    expect(result.data).toEqual({
      exhibitors: [{ externalId: '123', companyName: 'Example Expo Ltd', products: [] }],
      pagination: { fairSlug: 'euroblech-2026', page: 2, hasNextPage: true },
    });
    const projections = registerCatalogResultProjections(new TypedProjectionRegistry());
    expect(projections.restore(projections.project('tradefair-algolia/v1', result))).toEqual(result);
    expect(() => projections.project('tradefair-algolia/v1', {
      ...result,
      data: { ...result.data, exhibitors: [{ ...result.data.exhibitors[0], email: 'fixture@example.invalid' }] },
    })).toThrow('TYPED_PROJECTION_INVALID');
  });

  it('searches one SearXNG page through the internal service fence and keeps only search evidence', async () => {
    vi.stubEnv('SEARXNG_URL', 'http://searx-fixture.internal:8081');
    vi.mocked(lookup).mockImplementationOnce(async () => {
      events.push('dns');
      return [{ address: '127.0.0.1', family: 4 }];
    });
    const onSend = vi.fn<Send>((options) => {
      expect(options.hostname).toBe('searx-fixture.internal');
      expect(options.signal).toBe(controller.signal);
      expect(new URL(options.path!, 'http://fixture.invalid').searchParams.get('pageno')).toBe('2');
      events.push('wire');
    });
    stubHttps({
      onSend,
      body: { results: [{ url: 'https://example.invalid/', title: 'Example Pumps', content: 'raw provider snippet' }] },
    }, httpRequest);

    const result = await invokeNative(searxngSearchTool, { q: 'industrial pumps', page: 2 }, context());

    expect(result.data).toEqual({ results: [{ url: 'https://example.invalid/', title: 'Example Pumps' }] });
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
    expect(onSend).toHaveBeenCalledOnce();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('starts no SearXNG send when the caller requests hidden pagination', async () => {
    await expect(invokeNative(searxngSearchTool, { q: 'industrial pumps', pages: 2 }, context())).rejects.toThrow('SEARXNG_NATIVE_PAGE_REQUIRED');
    expect(events).toEqual([]);
    expect(httpRequest).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('uses a single pinned request for native http.get HEAD', async () => {
    const onSend = vi.fn<Send>((options, body) => {
      expect(options.hostname).toBe('head-fixture.invalid');
      expect(options.method).toBe('HEAD');
      expect(options.signal).toBe(controller.signal);
      expect(body).toBeUndefined();
      events.push('wire');
    });
    stubHttps({ onSend });
    const result = await invokeNative(httpGetTool, { url: 'https://head-fixture.invalid/careers', method: 'HEAD' }, context());
    expect(result.data).toMatchObject({ status: 200, text: '', finalUrl: 'https://head-fixture.invalid/careers' });
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
  });

  it('does not follow redirects in the native generic HTTP arm', async () => {
    stubHttps({ status: 302, headers: { location: '/second' }, onSend: () => { events.push('wire'); } });
    await expect(invokeNative(httpGetTool, { url: 'https://redirect-fixture.invalid/first' }, context())).rejects.toMatchObject({
      name: 'EgressBlockedError', code: 'too_many_redirects',
    });
    expect(events).toEqual(['dns', 'fence', 'wire', 'read']);
    expect(request).toHaveBeenCalledOnce();
  });

  it('checks robots before the single native page request and reuses HTTP-first extraction', async () => {
    const text = 'Official specifications and global distributor addresses for the manufacturer. '.repeat(8);
    const rawBody = (path: string) => path === '/robots.txt'
      ? 'User-agent: *\nDisallow: /members\n'
      : `<!doctype html><html><head><title>Fixture Pumps</title></head><body><article><h1>Fixture Pumps</h1><p>${text}</p></article></body></html>`;
    stubHttps({
      rawBody, headers: (path) => ({ 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' }),
      onSend(options) {
        events.push(`wire:${options.path}`);
        expect(options.signal).toBe(controller.signal);
      },
    });

    const result = await invokeNative(crawl4aiFetchTool, { url: 'https://crawl-fixture.invalid/catalog' }, context());

    expect(result.data.text).toContain('Official specifications');
    expect(result.data.contentHash).toHaveLength(24);
    expect(events).toEqual(['dns', 'fence:robots', 'wire:/robots.txt', 'read:robots', 'dns', 'fence', 'wire:/catalog', 'read']);
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('never reserves or renders a page blocked by robots', async () => {
    stubHttps({ rawBody: () => 'User-agent: *\nDisallow: /members\n', headers: { 'content-type': 'text/plain' }, onSend: (options) => events.push(`wire:${options.path}`) });
    const result = await invokeNative(crawl4aiFetchTool, { url: 'https://blocked-crawl-fixture.invalid/members' }, context());
    expect(result).toMatchObject({ data: { text: '' }, degraded: true, costCents: 0 });
    expect(events).toEqual(['dns', 'fence:robots', 'wire:/robots.txt', 'read:robots']);
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it('returns a thin-page result without an untracked crawl renderer fallback', async () => {
    stubHttps({
      rawBody: (path) => path === '/robots.txt' ? 'User-agent: *\n' : '<html><body><p>Thin page</p></body></html>',
      headers: (path) => ({ 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html; charset=utf-8' }),
      onSend: (options) => events.push(`wire:${options.path}`),
    });
    const result = await invokeNative(crawl4aiFetchTool, { url: 'https://thin-crawl-fixture.invalid/catalog' }, context());
    expect(result).toMatchObject({ data: { text: '' }, degraded: true, costCents: 0 });
    expect(events).toEqual(['dns', 'fence:robots', 'wire:/robots.txt', 'read:robots', 'dns', 'fence', 'wire:/catalog', 'read']);
    expect(legacyFetch).not.toHaveBeenCalled();
  });
});
