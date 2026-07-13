import { defineConfig } from 'astro/config';

// 渲染目标由环境驱动：SITESPEC_PATH=物化 SiteSpec JSON；OUT_DIR=产物目录。
// demo v0 activity 以子进程调用（apps/api temporal），构建容器化随 M1（06 §5）。
export default defineConfig({
  outDir: process.env.OUT_DIR ?? './dist',
  // 预览走指针式路径/子域（05 §1），产物内部一律相对链接
  trailingSlash: 'ignore',
});
