import {
  buildStaticLocalePaths,
  absoluteSiteHref,
  loadSpec,
  localePagePathHref,
} from "../lib/spec";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function GET(): Response {
  const spec = loadSpec();
  const urls = buildStaticLocalePaths(spec).map(({ pageId, locale }) => {
    const page = spec.pages.find((candidate) => candidate.id === pageId);
    if (!page) throw new Error(`SITEMAP_PAGE_MISSING: ${pageId}`);
    return absoluteSiteHref(
      localePagePathHref(page.path, locale, spec.site.defaultLocale),
    );
  });
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map((url) => `<url><loc>${escapeXml(url)}</loc></url>`).join("") +
    "</urlset>";
  return new Response(body, {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}
