const PDF_PATH_RE = /\.pdf(?:$|\/)/iu;
const PDF_QUERY_RE = /\.pdf$/iu;
const PDF_CONTENT_TYPE_RE = /^\s*application\/(?:x-)?pdf(?:\s*;|$)/iu;

/**
 * Returns true when the URL pathname or query parameter clearly points to a PDF document.
 * PDFs must never be sent to headless Chromium (`crawl4ai.render` / `crawl4ai.fetch` `/md`),
 * which causes 502 errors and stalls the shared rate-limit semaphore.
 */
export function isPdfDocumentUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const decodedPath = (() => {
      try {
        return decodeURIComponent(parsed.pathname);
      } catch {
        return parsed.pathname;
      }
    })();
    if (PDF_PATH_RE.test(decodedPath)) return true;
    return [...parsed.searchParams.values()].some((value) =>
      PDF_QUERY_RE.test(value.trim()),
    );
  } catch {
    return /\.pdf(?:[?#].*)?$/iu.test(trimmed);
  }
}

/** Returns true when a Content-Type header value declares a PDF media type. */
export function isPdfMediaType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && PDF_CONTENT_TYPE_RE.test(contentType);
}

/** Returns true when response headers declare a PDF Content-Type. */
export function isPdfContentType(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type' && isPdfMediaType(value)) {
      return true;
    }
  }
  return false;
}

/** Returns true when the raw body starts with the standard `%PDF-` magic header. */
export function isPdfMagicBytes(body: Buffer | undefined): boolean {
  return Boolean(body && body.byteLength >= 5 && body.subarray(0, 5).toString('ascii') === '%PDF-');
}

/** Derives a safe `.pdf` filename from a URL for Docling conversion requests. */
export function pdfFilenameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const segment = decodeURIComponent(parsed.pathname).split('/').filter(Boolean).pop() ?? '';
    const cleaned = segment.replace(/[^A-Za-z0-9._-]+/gu, '_').slice(0, 120);
    if (cleaned && /\.pdf$/iu.test(cleaned)) return cleaned;
    if (cleaned) return `${cleaned}.pdf`;
  } catch {
    // Fallback to a stable filename for non-standard URLs.
  }
  return 'document.pdf';
}
