import { defineConfig } from 'astro/config';

// 渲染目标由环境驱动：SITESPEC_PATH=物化 SiteSpec JSON；OUT_DIR=产物目录。
// demo v0 activity 以子进程调用（apps/api temporal），构建容器化随 M1（06 §5）。
export default defineConfig({
  outDir: process.env.OUT_DIR ?? './dist',
  // M1-e-B passes a one-shot, permission-restricted overlay. The renderer
  // never receives object-store credentials or reads tenant/catalog sources.
  publicDir: process.env.PUBLIC_ASSET_DIR ?? './public',
  // 浏览器证据必须只包含站点输出，不能被 Astro 开发工具栏固定浮层污染。
  devToolbar: { enabled: false },
  // 子路径预览（M0 本地 /preview/{slug}/）必须设 base，否则 /_astro/*.css 根路径 404；
  // 子域预览/发布（05 §1）BASE_PATH 不设=根路径。站内手写链接一律过 lib/links.withBase()。
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'ignore',
});
