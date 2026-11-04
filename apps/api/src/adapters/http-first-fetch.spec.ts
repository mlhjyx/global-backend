import { describe, expect, it, vi } from 'vitest';
import { fetchPageHttpFirst } from './http-first-fetch';

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
