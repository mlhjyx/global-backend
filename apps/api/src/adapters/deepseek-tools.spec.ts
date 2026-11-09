import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deepSeekToolFetch,
  deepSeekToolSearch,
  resolveDeepSeekApiKey,
} from './deepseek-tools';

const KEY = 'test-deepseek-key';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fetchMock(...responses: (() => Response | Promise<Response>)[]) {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) mock.mockImplementationOnce(async () => response());
  return mock;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DeepSeek Search & Fetch adapter', () => {
  it('posts a bounded search request and keeps only url/title hits', async () => {
    const mock = fetchMock(() => jsonResponse({
      results: [
        {
          url: 'https://pumpen-schmid.example/produkte',
          title: 'Pumpen Schmid GmbH',
          summary: 'Ansprechpartner: Max Muster',
          snippet: 'max.muster@pumpen-schmid.example',
          site_name: 'pumpen-schmid.example',
          rerank_score: 2.4,
          authority: 3,
        },
        { url: 'https://ohne-titel.example/' },
        { title: 'kein url' },
        { url: '' },
      ],
    }));
    const beforeRequest = vi.fn(async () => undefined);

    const response = await deepSeekToolSearch(
      { query: 'Industriepumpen Händler', count: 20 },
      { fetchImpl: mock, apiKey: KEY, baseUrl: 'https://api.deepseek.com', beforeRequest },
    );

    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'Industriepumpen Händler',
      count: 20,
      need_content: false,
    });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(response).toEqual({
      hits: [
        { url: 'https://pumpen-schmid.example/produkte', title: 'Pumpen Schmid GmbH' },
        { url: 'https://ohne-titel.example/' },
      ],
      billed: true,
    });
    expect(JSON.stringify(response)).not.toMatch(/Max Muster|max\.muster|summary|snippet|rerank/u);
  });

  it('reports an empty result set as unbilled', async () => {
    const mock = fetchMock(() => jsonResponse({ results: [] }));

    const response = await deepSeekToolSearch(
      { query: 'nichts', count: 10 },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    );

    expect(response).toEqual({ hits: [], billed: false });
  });

  it('retries 429 with backoff and succeeds once the provider recovers', async () => {
    const mock = fetchMock(
      () => jsonResponse({ error: { message: 'rate limited' } }, 429),
      () => jsonResponse({ results: [{ url: 'https://ok.example/' }] }),
    );
    const sleeps: number[] = [];

    const response = await deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: mock, apiKey: KEY, sleep: async (ms) => { sleeps.push(ms); } },
    );

    expect(mock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]);
    expect(response.hits).toEqual([{ url: 'https://ok.example/' }]);
  });

  it('gives up after bounded retries on a persistent 429', async () => {
    const mock = fetchMock(
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
      () => jsonResponse({ results: [{ url: 'https://never.example/' }] }),
    );

    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_SEARCH_RATE_LIMITED');
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 402 balance failure', async () => {
    const mock = fetchMock(() => jsonResponse({ error: { message: 'insufficient balance' } }, 402));

    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_BALANCE_INSUFFICIENT');
    expect(mock).toHaveBeenCalledOnce();
  });

  it('maps auth and upstream failures to stable codes', async () => {
    const unauthorized = fetchMock(() => jsonResponse({}, 401));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: unauthorized, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_API_KEY_REJECTED');

    const upstream = fetchMock(() => jsonResponse({}, 503), () => jsonResponse({}, 503), () => jsonResponse({}, 503));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: upstream, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_UPSTREAM_UNAVAILABLE');
  });

  it('rejects oversized, malformed and non-array responses before any payload use', async () => {
    const oversized = fetchMock(() => jsonResponse({}, 200, { 'content-length': '2000001' }));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: oversized, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_SEARCH_RESPONSE_TOO_LARGE');

    const malformed = fetchMock(() => new Response('not json', { status: 200 }));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: malformed, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_SEARCH_RESPONSE_INVALID');

    const notArray = fetchMock(() => jsonResponse({ results: {} }));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: notArray, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_SEARCH_RESPONSE_INVALID');
  });

  it('retries a network error before giving up', async () => {
    const mock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ results: [{ url: 'https://recovered.example/' }] }));

    const response = await deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    );
    expect(response.hits).toEqual([{ url: 'https://recovered.example/' }]);

    const failing = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: failing, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_SEARCH_NETWORK_ERROR');
    expect(failing).toHaveBeenCalledTimes(3);
  });

  it('fetches a page and reports empty content as unbilled', async () => {
    const mock = fetchMock(
      () => jsonResponse({ title: 'Impressum', content: '# Impressum\nPumpen Schmid GmbH' }),
      () => jsonResponse({ title: '', content: '   ' }),
    );

    const page = await deepSeekToolFetch(
      { url: 'https://pumpen-schmid.example/impressum' },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    );
    expect(page).toEqual({
      title: 'Impressum',
      content: '# Impressum\nPumpen Schmid GmbH',
      billed: true,
    });
    const [, init] = mock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://pumpen-schmid.example/impressum' });

    const empty = await deepSeekToolFetch(
      { url: 'https://pumpen-schmid.example/leer' },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    );
    expect(empty).toEqual({ content: '   ', billed: false });
  });

  it('rejects a fetch response without string content', async () => {
    const mock = fetchMock(() => jsonResponse({ title: 'x', content: null }));
    await expect(deepSeekToolFetch(
      { url: 'https://example.org/' },
      { fetchImpl: mock, apiKey: KEY, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_FETCH_RESPONSE_INVALID');
  });

  it('refuses to run without a configured key and resolves a trimmed env key', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    expect(resolveDeepSeekApiKey()).toBeUndefined();
    const mock = fetchMock(() => jsonResponse({ results: [] }));

    await expect(deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      { fetchImpl: mock, sleep: async () => undefined },
    )).rejects.toThrow('DEEPSEEK_API_KEY_NOT_CONFIGURED');
    expect(mock).not.toHaveBeenCalled();

    vi.stubEnv('DEEPSEEK_API_KEY', '  env-key  ');
    expect(resolveDeepSeekApiKey()).toBe('env-key');
  });

  it('calls the beforeRequest hook immediately before every physical attempt', async () => {
    const events: string[] = [];
    let attempt = 0;
    const fetchImpl = (async () => {
      events.push('fetch');
      attempt += 1;
      return attempt === 1
        ? new Response('{}', { status: 503 })
        : jsonResponse({ results: [{ url: 'https://ok.example/' }] });
    }) as typeof fetch;

    await deepSeekToolSearch(
      { query: 'Pumpen', count: 5 },
      {
        fetchImpl,
        apiKey: KEY,
        sleep: async () => { events.push('sleep'); },
        beforeRequest: async () => { events.push('beforeRequest'); },
      },
    );
    expect(events).toEqual(['beforeRequest', 'fetch', 'sleep', 'beforeRequest', 'fetch']);
  });
});
