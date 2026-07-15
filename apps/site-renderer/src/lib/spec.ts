import { readFileSync } from 'node:fs';
import type { SiteSpec } from '@global/contracts';

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
  const bundle = spec.copyBundles[locale] ?? {};
  return (key: string) => bundle[key] ?? `⟦${key}⟧`;
}

export function pagePathToSlug(path: string): string | undefined {
  const cleaned = path.replace(/^\/+|\/+$/g, '');
  return cleaned === '' ? undefined : cleaned;
}
