import { readFileSync } from 'node:fs';

/** 物化 SiteSpec（04 契约顶层信封 + per-locale CopyBundle）。 */
export interface MaterializedSpec {
  specVersion: string;
  site: {
    defaultLocale: string;
    locales: string[];
    theme: { preset: string; tokenOverrides?: Record<string, string> };
    nav: { labelKey: string; pageId: string }[];
    seoGlobal: { siteName: string };
  };
  pages: {
    id: string;
    path: string;
    puck: { content: { type: string; props: Record<string, unknown> }[]; root: { props?: Record<string, unknown> } };
    seo: { titleKey: string; descriptionKey: string };
  }[];
  assets: Record<string, { kind: string; hash: string }>;
  copyBundles: Record<string, Record<string, string>>;
}

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
  const bundle = spec.copyBundles[locale] ?? {};
  return (key: string) => bundle[key] ?? `⟦${key}⟧`;
}

export function pagePathToSlug(path: string): string | undefined {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  return cleaned === '' ? undefined : cleaned;
}
