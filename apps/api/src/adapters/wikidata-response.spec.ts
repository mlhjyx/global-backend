import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_PUBLIC_HTTP_RESPONSE_MAX_BYTES } from '../platform-authority/platform-execution-contract';
import { discoverCompaniesByIndustry, runSparql } from './wikidata';

const QUERY = 'SELECT ?company WHERE { ?company wdt:P31 wd:Q4830453 } LIMIT 1';
function respond(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe('Wikidata SPARQL response boundary', () => {
  it('accepts a well-formed empty result', async () => {
    respond(new Response(JSON.stringify({ head: { vars: [] }, results: { bindings: [] } })));
    await expect(runSparql(QUERY)).resolves.toEqual([]);
  });

  it.each([null, {}, [], { results: null }, { results: {} },
    { results: { bindings: {} } }, { results: { bindings: [null] } },
    { results: { bindings: [[]] } }, { results: { bindings: ['invalid'] } },
  ])('rejects schema drift instead of reporting no companies: %j', async (body) => {
    respond(new Response(JSON.stringify(body)));
    await expect(discoverCompaniesByIndustry({ industryQids: ['Q123'] }))
      .rejects.toThrow('wikidata_sparql_schema_invalid');
  });

  it.each(['{', new Uint8Array([0xc3, 0x28])])('rejects malformed JSON or UTF-8 with a stable error', async (body) => {
    respond(new Response(body));
    await expect(runSparql(QUERY)).rejects.toThrow('wikidata_sparql_json_invalid');
  });

  it('rejects a declared oversized response before reading it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-length': String(PLATFORM_PUBLIC_HTTP_RESPONSE_MAX_BYTES + 1) },
    });
    const fetchMock = respond(response);
    await expect(runSparql(QUERY)).rejects.toThrow('wikidata_response_too_large');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('counts actual streamed bytes and cancels an oversized body without retrying', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(PLATFORM_PUBLIC_HTTP_RESPONSE_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    }));
    const fetchMock = respond(response);
    await expect(runSparql(QUERY)).rejects.toThrow('wikidata_response_too_large');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not read or expose an HTTP error body', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { status: 503 });
    respond(response);
    await expect(runSparql(QUERY)).rejects.toThrow('wikidata 503');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('honors the physical request gate before fetch', async () => {
    const fetchMock = respond(new Response('{}'));
    const denied = new Error('physical request denied');
    await expect(runSparql(QUERY, 1000, async () => { throw denied; })).rejects.toBe(denied);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['pending', 'rejecting'])('preserves the HTTP error when cancellation is %s', async (mode) => {
    const cancel = vi.fn(() => mode === 'pending'
      ? new Promise<void>(() => {})
      : Promise.reject(new Error('cleanup failed')));
    respond(new Response(new ReadableStream({ cancel }), { status: 503 }));
    await expect(runSparql(QUERY, 10)).rejects.toThrow('wikidata 503');
    expect(cancel).toHaveBeenCalledTimes(1);
  }, 1000);
});
