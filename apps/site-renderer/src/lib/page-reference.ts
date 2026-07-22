import { localePageHref, localePagePathHref } from './spec';

/**
 * Qualified components resolve a page id through the SiteSpec path map.  The
 * Legacy standalone previews may omit the map entirely. Once a renderer has
 * supplied it, an unknown page id is an authoring error rather than a route
 * that may accidentally look valid.
 */
export function localeQualifiedPageHref(
  pageId: string,
  pagePathById: Record<string, string>,
  locale: string,
  defaultLocale: string,
): string {
  if (Object.keys(pagePathById).length === 0) {
    return localePageHref(pageId, locale, defaultLocale);
  }
  const path = pagePathById[pageId];
  if (!path) throw new Error(`PAGE_REFERENCE_UNKNOWN: ${pageId}`);
  return localePagePathHref(path, locale, defaultLocale);
}
