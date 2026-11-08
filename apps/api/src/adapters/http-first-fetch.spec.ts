import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { fetchPageHttpFirst, type HttpFirstCachePort } from './http-first-fetch';

const LONG_PARAGRAPH =
  'We manufacture and distribute centrifugal pumps for industrial applications across Europe, serving OEM partners and municipal utilities. '.repeat(4);

const ARTICLE_HTML = `<!doctype html><html><head><title>Acme Pumps GmbH</title></head><body>
<nav><a href="/">home</a></nav>
<article><h1>Acme Pumps GmbH</h1><p>${LONG_PARAGRAPH}</p><p>Located in Dortmund, Germany.</p></article>
<footer>footer junk</footer></body></html>`;

describe('fetchPageHttpFirst', () => {
  it('extracts readable markdown from a server-rendered page without any browser fetch', async () => {
    const fetchHtml = vi.fn(async () => ({
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(ARTICLE_HTML),
    }));
    const page = await fetchPageHttpFirst('https://acme.example/', { fetchHtml });
    expect(fetchHtml).toHaveBeenCalledOnce();
    expect(page).not.toBeNull();
    expect(page!.title).toContain('Acme Pumps');
    expect(page!.markdown).toContain('centrifugal pumps');
    expect(page!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null for thin pages so the caller falls back to rendering', async () => {
    const thinHtml =
      '<html><body><div id="app"></div><script src="/bundle.js"></script></body></html>';
    const page = await fetchPageHttpFirst('https://spa.example/', {
      fetchHtml: async () => ({ contentType: 'text/html', body: Buffer.from(thinHtml) }),
    });
    expect(page).toBeNull();
  });

  it('returns null for non-HTML content types (PDF and other binaries)', async () => {
    const page = await fetchPageHttpFirst('https://acme.example/catalog.pdf', {
      fetchHtml: async () => ({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.7') }),
    });
    expect(page).toBeNull();
  });

  it('returns null when the guarded fetch itself fails', async () => {
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => {
        throw new Error('EGRESS_BLOCKED');
      },
    });
    expect(page).toBeNull();
  });

  it('honours an explicit minimum readable length', async () => {
    const shortHtml = `<html><body><article><p>${'x'.repeat(60)}</p></article></body></html>`;
    const fetchHtml = async () => ({ contentType: 'text/html', body: Buffer.from(shortHtml) });
    expect(
      await fetchPageHttpFirst('https://acme.example/', { fetchHtml, minChars: 10 }),
    ).not.toBeNull();
    expect(
      await fetchPageHttpFirst('https://acme.example/', { fetchHtml, minChars: 10_000 }),
    ).toBeNull();
  });
});

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function cachedPage(overrides: Partial<{
  markdown: string;
  contentHash: string;
  etag: string | null;
  lastModified: string | null;
}> = {}) {
  return {
    markdown: 'cached markdown: centrifugal pumps for industrial applications. '.repeat(4),
    contentHash: 'b'.repeat(64),
    etag: '"v1-etag"',
    lastModified: 'Mon, 03 Nov 2026 08:00:00 GMT',
    ...overrides,
  };
}

function stubPort(overrides: Partial<{
  get: HttpFirstCachePort['get'];
  put: HttpFirstCachePort['put'];
}> = {}): HttpFirstCachePort {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    ...overrides,
  } as HttpFirstCachePort;
}

describe('fetchPageHttpFirst cache (PR-B)', () => {
  it('sends conditional headers and reuses cached markdown on 304 without parsing the body again', async () => {
    const entry = cachedPage();
    const port = stubPort({ get: vi.fn(async () => entry) });
    const fetchHtml = vi.fn(async () => ({
      status: 304,
      contentType: null,
      body: Buffer.alloc(0),
    }));

    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml,
      cache: { workspaceId: WORKSPACE_ID, port },
    });

    expect(fetchHtml).toHaveBeenCalledWith('https://acme.example/', {
      ifNoneMatch: '"v1-etag"',
      ifModifiedSince: 'Mon, 03 Nov 2026 08:00:00 GMT',
    });
    expect(page).toEqual({
      markdown: entry.markdown,
      title: null,
      contentHash: entry.contentHash,
      fromCache: 'conditional-304',
    });
    expect(port.put).not.toHaveBeenCalled();
  });

  it('stores a freshly extracted page with its validators on 200', async () => {
    const port = stubPort();
    const fetchHtml = vi.fn(async () => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: Buffer.from(ARTICLE_HTML),
      etag: '"fresh"',
      lastModified: 'Tue, 04 Nov 2026 09:00:00 GMT',
    }));

    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml,
      cache: { workspaceId: WORKSPACE_ID, port },
    });

    expect(page).not.toBeNull();
    expect(fetchHtml).toHaveBeenCalledWith('https://acme.example/', undefined);
    expect(port.put).toHaveBeenCalledWith(WORKSPACE_ID, 'https://acme.example/', {
      markdown: expect.stringContaining('centrifugal pumps'),
      contentHash: page!.contentHash,
      etag: '"fresh"',
      lastModified: 'Tue, 04 Nov 2026 09:00:00 GMT',
    });
  });

  it('truncates oversized markdown before caching and hashes the stored text', async () => {
    const port = stubPort();
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(ARTICLE_HTML),
      }),
      cache: { workspaceId: WORKSPACE_ID, port },
      cacheMaxChars: 60,
    });

    expect(page).not.toBeNull();
    const written = (port.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as {
      markdown: string;
      contentHash: string;
    };
    const stored = page!.markdown.slice(0, 60);
    expect(written.markdown).toBe(stored);
    expect(written.contentHash).toBe(
      createHash('sha256').update(stored, 'utf8').digest('hex'),
    );
    expect(written.contentHash).not.toBe(page!.contentHash);
  });

  it('does not send conditional headers when the cached entry has no validators', async () => {
    const port = stubPort({
      get: vi.fn(async () => cachedPage({ etag: null, lastModified: null })),
    });
    const fetchHtml = vi.fn(async () => ({
      status: 200,
      contentType: 'text/html',
      body: Buffer.from(ARTICLE_HTML),
    }));

    await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml,
      cache: { workspaceId: WORKSPACE_ID, port },
    });

    expect(fetchHtml).toHaveBeenCalledWith('https://acme.example/', undefined);
  });

  it('falls back to rendering when a 304 arrives without a cached row to reuse', async () => {
    const port = stubPort();
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => ({ status: 304, contentType: null, body: Buffer.alloc(0) }),
      cache: { workspaceId: WORKSPACE_ID, port },
    });
    expect(page).toBeNull();
  });

  it('still extracts the page when the cache read throws', async () => {
    const port = stubPort({
      get: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(ARTICLE_HTML),
      }),
      cache: { workspaceId: WORKSPACE_ID, port },
    });
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain('centrifugal pumps');
  });

  it('still returns the page when the cache write throws', async () => {
    const port = stubPort({
      put: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(ARTICLE_HTML),
      }),
      cache: { workspaceId: WORKSPACE_ID, port },
    });
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain('centrifugal pumps');
  });

  it('does not consult the cache when no cache is configured', async () => {
    const page = await fetchPageHttpFirst('https://acme.example/', {
      fetchHtml: async () => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(ARTICLE_HTML),
      }),
    });
    expect(page).not.toBeNull();
    expect(page!.fromCache).toBeUndefined();
  });

  it('emits the structured [http-cache] state line for misses and 304 hits', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const missPort = stubPort();
      await fetchPageHttpFirst('https://acme.example/log-miss', {
        fetchHtml: async () => ({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(ARTICLE_HTML),
        }),
        cache: { workspaceId: WORKSPACE_ID, port: missPort },
      });
      const hitPort = stubPort({ get: vi.fn(async () => cachedPage()) });
      await fetchPageHttpFirst('https://acme.example/log-hit', {
        fetchHtml: async () => ({ status: 304, contentType: null, body: Buffer.alloc(0) }),
        cache: { workspaceId: WORKSPACE_ID, port: hitPort },
      });

      const lines = logSpy.mock.calls.map((call) => String(call[0]));
      expect(lines).toContain('[http-cache] state=miss url=https://acme.example/log-miss');
      expect(lines).toContain(
        '[http-cache] state=conditional-304 url=https://acme.example/log-hit',
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
