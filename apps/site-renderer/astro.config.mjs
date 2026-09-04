import { defineConfig } from "astro/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cacheRoot = process.env.RENDERER_CACHE_ROOT;
if (!cacheRoot || !path.isAbsolute(cacheRoot)) {
  throw new Error("RENDERER_CACHE_ROOT_REQUIRED");
}
const rendererRoot = path.dirname(fileURLToPath(import.meta.url));
const fixedSourceRoot = path.join(rendererRoot, "src");
const sourceRoot =
  process.env.RENDERER_SOURCE_ROOT ?? path.join(cacheRoot, "src");
if (
  process.env.RENDERER_SOURCE_ROOT &&
  (!path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== fixedSourceRoot)
) {
  throw new Error("RENDERER_SOURCE_ROOT_INVALID");
}
const devDependencyRoot = process.env.RENDERER_DEV_DEPENDENCY_ROOT;
if (devDependencyRoot && !path.isAbsolute(devDependencyRoot)) {
  throw new Error("RENDERER_DEV_DEPENDENCY_ROOT_INVALID");
}

// 渲染目标由环境驱动：SITESPEC_PATH=物化 SiteSpec JSON；OUT_DIR=产物目录。
// demo v0 activity 以子进程调用（apps/api temporal），构建容器化随 M1（06 §5）。
export default defineConfig({
  // Both Astro and Vite have independent dependency caches. Keep the source
  // tree immutable while Astro's generated `.astro` modules and both cache
  // layers live in this build's private, short-lived workspace.
  root: cacheRoot,
  srcDir: sourceRoot,
  cacheDir: path.join(cacheRoot, "astro"),
  vite: {
    cacheDir: path.join(cacheRoot, "vite"),
    server: {
      fs: {
        allow: [
          cacheRoot,
          sourceRoot,
          rendererRoot,
          ...(devDependencyRoot ? [devDependencyRoot] : []),
        ],
      },
    },
  },
  outDir: process.env.OUT_DIR ?? "./dist",
  // M1-e-B passes a one-shot, permission-restricted overlay. The renderer
  // never receives object-store credentials or reads tenant/catalog sources.
  publicDir: process.env.PUBLIC_ASSET_DIR ?? path.join(rendererRoot, "public"),
  // 浏览器证据必须只包含站点输出，不能被 Astro 开发工具栏固定浮层污染。
  devToolbar: { enabled: false },
  // 子路径预览（M0 本地 /preview/{slug}/）必须设 base，否则 /_astro/*.css 根路径 404；
  // 子域预览/发布（05 §1）BASE_PATH 不设=根路径。站内手写链接一律过 lib/links.withBase()。
  base: process.env.BASE_PATH ?? "/",
  trailingSlash: "ignore",
});
