import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOCLING_PDF_PARSER_VERSION,
  extractPdfMarkdownWithDocling,
  PdfNotRenderableError,
} from './docling-pdf-fetch';
import { fetchPageHttpFirst } from './http-first-fetch';
import {
  isPdfDocumentUrl,
  isPdfMagicBytes,
  isPdfMediaType,
  pdfFilenameFromUrl,
} from './pdf-url-guard';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DOCLING_PDF_FETCH;
  delete process.env.DOCLING_URL;
  delete process.env.DOCLING_BACKEND;
});

describe('PDF detection and Docling conversion adapter', () => {
  it('detects PDF URLs, media types, magic bytes, and derives safe filenames', () => {
    expect(
      isPdfDocumentUrl(
        'https://solartage.example/downloads/Ausstellerverzeichnis-Solartage-2026.pdf',
      ),
    ).toBe(true);
    expect(
      isPdfDocumentUrl('https://expo.example/download?file=exhibitors-2026.pdf'),
    ).toBe(true);
    expect(isPdfDocumentUrl('https://www.intersolar.de/exhibitorlist')).toBe(
      false,
    );
    expect(isPdfMediaType('application/pdf; charset=binary')).toBe(true);
    expect(isPdfMediaType('text/html; charset=utf-8')).toBe(false);
    expect(isPdfMagicBytes(Buffer.from('%PDF-1.7\n...'))).toBe(true);
    expect(isPdfMagicBytes(Buffer.from('<!doctype html>'))).toBe(false);
    expect(
      pdfFilenameFromUrl(
        'https://solartage.example/downloads/Ausstellerverzeichnis-Solartage-2026.pdf',
      ),
    ).toBe('Ausstellerverzeichnis-Solartage-2026.pdf');
  });

  it('posts base64 PDF with 1-15 page cap to Docling and returns markdown', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          document: {
            md_content: '# Ausstellerverzeichnis 2026\n| Firma | Website |\n| Solar GmbH | https://solar.example |',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const md = await extractPdfMarkdownWithDocling(
      {
        url: 'https://solartage.example/Ausstellerverzeichnis-Solartage-2026.pdf',
        filename: 'Ausstellerverzeichnis-Solartage-2026.pdf',
        bytes: Buffer.from('%PDF-1.7 test'),
        workspaceId: 'ws-pv-1',
      },
      { DOCLING_URL: 'http://docling.test:5001' },
    );

    expect(md).toContain('Solar GmbH');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('http://docling.test:5001/v1/convert/source');
    const body = JSON.parse(String(init.body));
    expect(body.options).toEqual({ to_formats: ['md'], page_range: [1, 15] });
    expect(body.sources[0].filename).toBe('Ausstellerverzeichnis-Solartage-2026.pdf');
  });

  it('returns null cleanly when DOCLING_PDF_FETCH=off or Docling fails', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      extractPdfMarkdownWithDocling(
        {
          url: 'https://solartage.example/list.pdf',
          filename: 'list.pdf',
          bytes: Buffer.from('%PDF-1.7'),
        },
        { DOCLING_PDF_FETCH: 'off' },
      ),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      extractPdfMarkdownWithDocling(
        {
          url: 'https://solartage.example/list.pdf',
          filename: 'list.pdf',
          bytes: Buffer.from('%PDF-1.7'),
        },
        { DOCLING_URL: 'http://docling.test:5001' },
      ),
    ).resolves.toBeNull();
  });

  it('routes application/pdf responses inside fetchPageHttpFirst to extractPdf and throws PdfNotRenderableError when unavailable', async () => {
    const pdfResponse = {
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.7 exhibitor list'),
      finalUrl: 'https://expo.example/download?id=2026',
    };

    const parsed = await fetchPageHttpFirst('https://expo.example/download?id=2026', {
      fetchHtml: async () => pdfResponse,
      extractPdf: async () => '# Exhibitors\n- NordSolar GmbH (https://nordsolar.example)',
      workspaceId: 'ws-pv-1',
    });
    expect(parsed).toMatchObject({
      parserVersion: DOCLING_PDF_PARSER_VERSION,
      markdown: expect.stringContaining('NordSolar GmbH'),
    });

    await expect(
      fetchPageHttpFirst('https://expo.example/download?id=2026', {
        fetchHtml: async () => pdfResponse,
        extractPdf: async () => null,
      }),
    ).rejects.toBeInstanceOf(PdfNotRenderableError);
  });
});
