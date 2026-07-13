/**
 * 站内链接 base 前缀（astro.config base 只管构建资产，手写 href 要自己拼）。
 * 子路径预览 BASE_URL=/preview/{slug}/；子域/发布 BASE_URL=/。
 */
export function withBase(path: string): string {
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const joined = `${base}${suffix}`;
  return joined === '' ? '/' : joined;
}

export function pageHref(pageId: string): string {
  return withBase(pageId === 'home' ? '/' : `/${pageId}`);
}
