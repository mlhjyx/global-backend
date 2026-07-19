import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { SiteSpec } from '@global/contracts';
import { withBase } from './links';

const contracts = createRequire(import.meta.url)('@global/contracts') as typeof import('@global/contracts');
const { resolveSiteCopyBundle, resolveSiteLocale } = contracts;

/**
 * 物化 SiteSpec（04 契约顶层信封 + per-locale CopyBundle）。
 * DQ-1：类型真值在 `@global/contracts`；保留 `MaterializedSpec` 别名以不惊动 .astro 引用。
 * 运行时校验（04 §7 三重门）将在 `loadSpec` 处以 Zod 叠加（DQ-1 follow-up）。
 */
export type MaterializedSpec = SiteSpec;

let cached: MaterializedSpec | null = null;

export function loadSpec(): MaterializedSpec {
  if (cached) return cached;
  const path = process.env.SITESPEC_PATH;
  if (!path) throw new Error('SITESPEC_PATH not set');
  cached = JSON.parse(readFileSync(path, 'utf8')) as MaterializedSpec;
  return cached;
}

/** textKey → 文案；缺 key 输出可见标记（QA 期一眼看出，绝不静默空串）。 */
export function makeT(spec: MaterializedSpec, locale: string): (key: string) => string {
  const bundle = resolveSiteCopyBundle(spec, locale);
  return (key: string) => {
    const value = bundle[key];
    if (value === undefined) throw new Error(`COPY_SLOT_MISSING: ${locale}/${key}`);
    return value;
  };
}

export function pagePathToSlug(path: string): string | undefined {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  return cleaned === '' ? undefined : cleaned;
}

export function siteLocaleDirection(locale: string): 'ltr' | 'rtl' {
  const definition = resolveSiteLocale(locale);
  if (!definition) throw new Error(`COPY_LOCALE_UNSUPPORTED: ${locale}`);
  return definition.direction;
}

export function localePageHref(
  pageId: string,
  locale: string,
  defaultLocale: string,
): string {
  const page = pageId === 'home' ? '' : `/${pageId}`;
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return withBase(`${prefix}${page}` || '/');
}

export function buildStaticLocalePaths(spec: MaterializedSpec): Array<{
  slug: string | undefined;
  pageId: string;
  locale: string;
}> {
  return spec.site.locales.flatMap((locale) => {
    if (!resolveSiteLocale(locale)) {
      throw new Error(`COPY_LOCALE_UNSUPPORTED: ${locale}`);
    }
    // Resolve eagerly so an advertised locale without a bundle fails the build.
    resolveSiteCopyBundle(spec, locale);
    return spec.pages.map((page) => {
      const pageSlug = pagePathToSlug(page.path);
      const slug =
        locale === spec.site.defaultLocale
          ? pageSlug
          : [locale, pageSlug].filter(Boolean).join('/');
      return { slug: slug || undefined, pageId: page.id, locale };
    });
  });
}
