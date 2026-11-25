const PDF_PATH_RE = /\.pdf$/iu;
const PDF_CONTENT_TYPE_RE = /^\s*application\/(?:x-)?pdf(?:\s*;|$)/iu;

/**
 * Returns true when the URL pathname clearly points to a PDF document.
 * PDFs must never be sent to headless Chromium (`crawl4ai.render`), which
 * causes 502 errors and stalls the shared 30-second rate-limit semaphore.
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
    return PDF_PATH_RE.test(decodedPath);
  } catch {
    return /\.pdf(?:[?#].*)?$/iu.test(trimmed);
  }
}

/** Returns true when response headers declare a PDF Content-Type. */
export function isPdfContentType(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!headers) return false;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-type' && typeof value === 'string') {
      return PDF_CONTENT_TYPE_RE.test(value);
    }
  }
  return false;
}
