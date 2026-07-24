import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { SiteSpec } from '@global/contracts';
import { withBase } from './links';

const contracts = createRequire(import.meta.url)(
  '@global/contracts',
) as typeof import('@global/contracts');
const { resolveSiteCopyBundle, resolveSiteLocale, validateSiteSpec } =
  contracts;

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
  cached = validateSiteSpec(JSON.parse(readFileSync(path, 'utf8')));
  return cached;
}

export function siteOrigin(): string {
  const raw = process.env.SITE_ORIGIN;
  if (!raw) throw new Error('SITE_ORIGIN not set');
  const parsed = new URL(raw);
  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (
    parsed.origin !== raw ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
  ) {
    throw new Error('SITE_ORIGIN_INVALID');
  }
  return parsed.origin;
}

export function absoluteSiteHref(pathname: string): string {
  return new URL(pathname, siteOrigin()).href;
}

/** textKey → 文案；缺 key 输出可见标记（QA 期一眼看出，绝不静默空串）。 */
export function makeT(
  spec: MaterializedSpec,
  locale: string,
): (key: string) => string {
  const bundle = resolveSiteCopyBundle(spec, locale);
  return (key: string) => {
    const value = bundle[key];
    if (value === undefined)
      throw new Error(`COPY_SLOT_MISSING: ${locale}/${key}`);
    return value;
  };
}

/**
 * 可选 slot 安全探测：缺 key（COPY_SLOT_MISSING）返回空串（UI 按空值隐藏）；
 * 其他异常一律 rethrow -- 不吞 CopyBundle/完整性错误，避免破坏 fail-closed。
 */
export function safeOptionalSlot(
  t: (key: string) => string,
  key: string,
): string {
  try {
    return t(key);
  } catch (e) {
    if (e instanceof Error && /^COPY_SLOT_MISSING/.test(e.message)) return '';
    throw e;
  }
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

/**
 * Links in qualified blocks are resolved from the declared page path rather
 * than assuming a page id is also its URL slug.  Keep `localePageHref` above
 * for legacy blocks that still use the id-based compatibility contract.
 */
export function localePagePathHref(
  pagePath: string,
  locale: string,
  defaultLocale: string,
): string {
  const slug = pagePathToSlug(pagePath);
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return withBase([prefix, slug].filter(Boolean).join('/') || '/');
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
