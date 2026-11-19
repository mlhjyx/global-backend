import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Wikidata API client rate feedback', () => {
  it('identifies the same bot with a real project contact URL', async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ search: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('./wikidata');
    await api.wikidataSearchEntity('Fixture company');
    const headers = fetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('GlobalDiscoveryBot/1.0');
    expect(headers['User-Agent']).toContain('https://github.com/mlhjyx/global-backend');
  });

  it('honors Retry-After before a different request without retrying the failed physical call', async () => {
    let now = 1_800_000_000_000;vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('too many', { status: 429, headers: { 'Retry-After': '60' } }))
      .mockResolvedValue(new Response(JSON.stringify({ search: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const beforeRequest = vi.fn(async () => undefined);
    const api = await import('./wikidata');
    await expect(api.wikidataSearchEntity('Alpha fixture', 7, beforeRequest)).rejects.toThrow();
    now += 30_000;
    await expect(api.wikidataSearchEntity('Beta fixture', 7, beforeRequest)).rejects.toThrow('WIKIDATA_RATE_LIMITED_COOLDOWN');
    expect(fetch).toHaveBeenCalledOnce();expect(beforeRequest).toHaveBeenCalledOnce();
    now += 31_000;
    await api.wikidataSearchEntity('Gamma fixture', 7, beforeRequest);
    expect(fetch).toHaveBeenCalledTimes(2);expect(beforeRequest).toHaveBeenCalledTimes(2);
  });

  it('uses at least five seconds of cooling when no Retry-After was supplied', async () => {
    let now = 1_800_000_000_000;vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn().mockResolvedValueOnce(new Response('too many', { status: 429 }))
      .mockResolvedValue(new Response(JSON.stringify({ entities: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('./wikidata');
    await expect(api.wikidataGetEntities(['Q1'])).rejects.toThrow();
    now += 4_000;
    await expect(api.wikidataGetEntities(['Q2'])).rejects.toThrow('WIKIDATA_RATE_LIMITED_COOLDOWN');
    expect(fetch).toHaveBeenCalledOnce();
    now += 1_100;
    await api.wikidataGetEntities(['Q3']);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('releases only the new cooldown operation through the real Broker and preserves the request already sent', async () => {
    const fetch = vi.fn(async () => new Response('limited', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetch);
    const { wikidataEntityTool } = await import('../tools/source-tools');
    const { ToolBroker } = await import('../tools/tool-broker');
    const { ToolRegistry } = await import('../tools/tool-registry');
    const { RateLimiter } = await import('../tools/rate-limiter');
    const registry = new ToolRegistry(); registry.register(wikidataEntityTool);
    const reservations: unknown[] = [];
    const release = vi.fn(async () => ({ chargedMicrousd: 0n, observedMicrousd: 0n, capVariance: false, replay: false }));
    const reserve = vi.fn(async (request: Record<string, unknown>) => {
      const reservation = { ...request, operationId: `fixture-${reservations.length}`, replay: false };
      reservations.push(reservation); return reservation;
    });
    const broker = new ToolBroker({ registry, limiter: new RateLimiter(),
      budgetStore: { reserve, release } as never, sourcePolicyReader: async () => ({ suspended: false }) });
    const authorizeExternalAction = vi.fn(async () => true);
    const beforePhysicalWire = vi.fn(async () => undefined);
    const ctx = { workspaceId: 'fixture-workspace', runId: 'fixture-run', purpose: 'enrichment',
      authorizeExternalAction, beforePhysicalWire };
    await expect(broker.invoke(wikidataEntityTool.id, { op: 'search', name: 'Alpha fixture' }, ctx)).rejects.toThrow('WIKIDATA_RATE_LIMITED');
    await expect(broker.invoke(wikidataEntityTool.id, { op: 'get', qids: ['Q1'] }, ctx)).rejects.toThrow('WIKIDATA_RATE_LIMITED_COOLDOWN');
    expect(fetch).toHaveBeenCalledOnce();
    expect(authorizeExternalAction).toHaveBeenCalledTimes(3);
    expect(beforePhysicalWire).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledExactlyOnceWith(reservations[1]);
    expect(release).not.toHaveBeenCalledWith(reservations[0]);
  });

  it.each(['Wed, 18 Nov 2026 12:01:00 GMT', 'invalid', '9'.repeat(400)])('bounds malformed retry feedback and supports HTTP dates: %s', async (header) => {
    let now = Date.parse('Wed, 18 Nov 2026 12:00:00 GMT'); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi.fn().mockResolvedValueOnce(new Response('limited', { status: 429, headers: { 'Retry-After': header } }))
      .mockResolvedValue(new Response(JSON.stringify({ search: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('./wikidata');
    await expect(api.wikidataSearchEntity('fixture one')).rejects.toThrow('WIKIDATA_RATE_LIMITED');
    now += header.startsWith('Wed') ? 61_000 : 5_100;
    await api.wikidataSearchEntity('fixture two'); expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['search', 'get'] as const)('observes a concurrent 429 after %s authorization before declaring its physical wire', async (op) => {
    const fetch = vi.fn(async () => new Response('limited', { status: 429, headers: { 'Retry-After': '60' } }));
    vi.stubGlobal('fetch', fetch);
    const api = await import('./wikidata');
    let authorize!: () => void;
    const waiting = new Promise<void>((resolve) => { authorize = resolve; });
    const beforePhysicalWire = vi.fn(async () => undefined);
    const pending = op === 'search'
      ? api.wikidataSearchEntity('pending fixture', 7, () => waiting, beforePhysicalWire)
      : api.wikidataGetEntities(['Q1'], undefined, () => waiting, beforePhysicalWire);
    await expect(api.wikidataSearchEntity('other fixture')).rejects.toThrow('WIKIDATA_RATE_LIMITED');
    const rejection = expect(pending).rejects.toThrow('WIKIDATA_RATE_LIMITED_COOLDOWN');
    authorize(); await rejection;
    expect(fetch).toHaveBeenCalledOnce(); expect(beforePhysicalWire).not.toHaveBeenCalled();
  });

});
