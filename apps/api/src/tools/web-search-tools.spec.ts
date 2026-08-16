import { describe, expect, it, vi } from 'vitest';
import type { PublicHttpResponse } from '../adapters/guarded-http';
import {
  SearchBackendUnavailableError,
  createBraveSearchTool,
  createSerperSearchTool,
} from './web-search-tools';
import { ToolRegistry } from './tool-registry';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { BudgetLedger } from './budget';
import { RateLimiter } from './rate-limiter';
import { readToolFailureCost } from './tool-contract';

const response = (body: unknown): PublicHttpResponse => ({
  status: 200,
  ok: true,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
  text: JSON.stringify(body),
  finalUrl: 'https://search.invalid/',
});

describe('governed public_web search backends', () => {
  it('Serper fails before wire when its key is absent', async () => {
    const request = vi.fn();
    const tool = createSerperSearchTool({ readCredential: () => undefined, request });

    await expect(tool.execute({ q: 'industrial pumps' }, { workspaceId: 'w' }))
      .rejects.toBeInstanceOf(SearchBackendUnavailableError);
    expect(request).not.toHaveBeenCalled();
  });

  it('ToolBroker fails closed before wire when Provider or SourcePolicy is unavailable', async () => {
    const request = vi.fn();
    const registry = new ToolRegistry();
    registry.register(createSerperSearchTool({ readCredential: () => 'configured', request }));
    const broker = new ToolBroker({
      registry,
      budget: new BudgetLedger(),
      limiter: new RateLimiter(),
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => null,
      traceRecorder: () => undefined,
    });

    await expect(broker.invoke(
      'serper.search',
      { q: 'industrial pumps' },
      { workspaceId: 'w', taskContractId: 'discovery.extract_company', purpose: 'discovery' },
    )).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(request).not.toHaveBeenCalled();
  });

  it('marks a paid failure as estimated unknown only after the physical request starts', async () => {
    const request = vi.fn(async (_url, _options, dependencies) => {
      dependencies?.onRequestStarted?.();
      throw new Error('connection reset after request write');
    });
    const registry = new ToolRegistry();
    registry.register(createSerperSearchTool({ readCredential: () => 'configured', request }));
    const budget = new BudgetLedger();
    budget.open('run-1', 1);
    const broker = new ToolBroker({
      registry,
      budget,
      limiter: new RateLimiter(),
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
      traceRecorder: () => undefined,
    });

    const error = await broker.invoke(
      'serper.search',
      { q: 'industrial pumps' },
      {
        workspaceId: 'w',
        runId: 'run-1',
        taskContractId: 'discovery.extract_company',
        purpose: 'discovery',
      },
    ).then(() => null, (caught: unknown) => caught);

    expect(readToolFailureCost(error)).toEqual({ costCents: 1, basis: 'estimated_unknown' });
    expect(budget.remainingCents('run-1')).toBe(0);
  });

  it('Serper uses a fixed endpoint, bounded payload, write-only key header, and wire reauthorization', async () => {
    const request = vi.fn(async () => response({
      organic: [{ title: 'Acme', link: 'https://acme.example/about', snippet: 'Pump maker' }],
    }));
    const authorizeExternalAction = vi.fn(async () => true);
    const reauthorizeProviderStatus = vi.fn(async () => undefined);
    const reauthorizeSourcePolicy = vi.fn(async () => undefined);
    const tool = createSerperSearchTool({ readCredential: () => 'secret-serper', request });

    const result = await tool.execute(
      { q: ' industrial pumps ', count: 999, country: 'DE', language: 'EN' },
      { workspaceId: 'w', authorizeExternalAction, reauthorizeProviderStatus, reauthorizeSourcePolicy },
    );

    expect(request).toHaveBeenCalledOnce();
    const [url, options, dependencies] = request.mock.calls[0]!;
    expect(url).toBe('https://google.serper.dev/search');
    expect(options.method).toBe('POST');
    expect(options.headers['X-API-KEY']).toBe('secret-serper');
    expect(JSON.parse(String(options.body))).toEqual({ q: 'industrial pumps', num: 20, gl: 'de', hl: 'en' });
    await dependencies.beforeRequest();
    expect(reauthorizeProviderStatus).toHaveBeenCalledOnce();
    expect(reauthorizeSourcePolicy).toHaveBeenCalledOnce();
    expect(dependencies.authorizeExternalAction).toBe(authorizeExternalAction);
    expect(result.data.results).toEqual([
      { title: 'Acme', url: 'https://acme.example/about', content: 'Pump maker', engine: 'serper' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-serper');
  });

  it('Brave uses a fixed endpoint and normalizes only bounded web results', async () => {
    const request = vi.fn(async () => response({
      web: { results: Array.from({ length: 30 }, (_, index) => ({
        title: `Company ${index}`,
        url: `https://company-${index}.example/`,
        description: `Description ${index}`,
      })) },
    }));
    const tool = createBraveSearchTool({ readCredential: () => 'secret-brave', request });

    const result = await tool.execute(
      { q: 'valves', count: 20, country: 'US', language: 'en' },
      { workspaceId: 'w' },
    );

    const [url, options] = request.mock.calls[0]!;
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(parsed.searchParams.get('q')).toBe('valves');
    expect(parsed.searchParams.get('count')).toBe('20');
    expect(options.headers['X-Subscription-Token']).toBe('secret-brave');
    expect(result.data.results).toHaveLength(20);
    expect(result.data.results[0]).toEqual({
      title: 'Company 0',
      url: 'https://company-0.example/',
      content: 'Description 0',
      engine: 'brave',
    });
  });

  it('rejects empty/oversized queries and malformed upstream payloads', async () => {
    const request = vi.fn(async () => response({ organic: 'not-an-array' }));
    const tool = createSerperSearchTool({ readCredential: () => 'configured', request });

    await expect(tool.execute({ q: '   ' }, { workspaceId: 'w' })).rejects.toThrow(/query/i);
    await expect(tool.execute({ q: 'x'.repeat(401) }, { workspaceId: 'w' })).rejects.toThrow(/query/i);
    await expect(tool.execute({ q: Array.from({ length: 51 }, () => 'x').join(' ') }, { workspaceId: 'w' }))
      .rejects.toThrow(/query/i);
    await expect(tool.execute({ q: 'valid query', count: Number.NaN }, { workspaceId: 'w' }))
      .rejects.toThrow(/count/i);
    await expect(tool.execute({ q: 'valid query' }, { workspaceId: 'w' })).rejects.toThrow(/payload/i);
  });

  it('durable replay retains only public origins, never query/snippet/title', () => {
    const tool = createBraveSearchTool({ readCredential: () => 'configured', request: vi.fn() });
    const replay = tool.durableReplayResult?.({
      data: { results: [{
        title: 'Jane Smith CEO',
        url: 'https://sales:secret@acme.example/people/jane?email=jane@example.com',
        content: 'jane@example.com',
        engine: 'brave',
      }] },
      costCents: 1,
    });

    expect(replay).toEqual({
      data: { results: [{ url: 'https://acme.example/' }] },
      costCents: 1,
    });
    expect(JSON.stringify(replay)).not.toMatch(/Jane|secret|email|brave/i);
  });
});
