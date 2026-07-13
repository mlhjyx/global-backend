/**
 * 预览地址构造（05 §1：正式形态 {slug}.preview.<平台域>；平台域未定前
 * 用本地预览服务的路径式雏形，模式经 env 可切，前端无需改代码）。
 * 仅站点有可看产物（ready/published）时返回地址。
 */

const DEFAULT_PATTERN = 'http://localhost:3000/preview/{slug}/';

const PREVIEWABLE_STATUSES: ReadonlySet<string> = new Set(['ready', 'published']);

export function previewUrlFor(site: { slug: string; status: string }): string | null {
  if (!PREVIEWABLE_STATUSES.has(site.status)) return null;
  const pattern = process.env.PREVIEW_URL_PATTERN ?? DEFAULT_PATTERN;
  return pattern.replace('{slug}', site.slug);
}
