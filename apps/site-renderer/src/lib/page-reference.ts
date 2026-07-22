import { localePageHref, localePagePathHref } from './spec';

/**
 * Qualified components resolve a page id through the SiteSpec path map.  The
 * id fallback preserves preview compatibility for legacy component callers;
 * release validation rejects unknown targets before publication.
 */
export function localeQualifiedPageHref(
  pageId: string,
  pagePathById: Record<string, string>,
  locale: string,
  defaultLocale: string,
): string {
  const path = pagePathById[pageId];
  return path
    ? localePagePathHref(path, locale, defaultLocale)
    : localePageHref(pageId, locale, defaultLocale);
}
