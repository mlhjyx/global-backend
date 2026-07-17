/**
 * SiteSpec —— 独立站生成/渲染的顶层契约（[04-sitespec-contract.md] 的**代码事实源**）。
 *
 * 背景（DQ-1）：此前 API 生产端（`apps/api/src/site-builder/demo-spec.ts` 的
 * `MaterializedDemoDoc`）与渲染器消费端（`apps/site-renderer/src/lib/spec.ts` 的
 * `MaterializedSpec`）各手写一份同一信封、互不引用，已在**静默漂移**：
 *   - `site.theme.tokenOverrides`：消费端有、生产端无；
 *   - `pages[].puck.root.props`：生产端必填、消费端可选；
 *   - `assets` 值形状：生产端 `Record<string, never>`（永远空）、消费端 `{ kind, hash }`。
 * 本文件按 04 契约**调和为唯一真值**（取兼容超集），两端 `import type` 之，漂移在编译期即报错。
 *
 * 后续（DQ-1 follow-up，不在本次）：运行时校验（04 §7 三重门）以 Zod schema 叠加于此，
 * 渲染器 `loadSpec` 处 `parse` 把生产端违约变成响亮构建错误。`DesignBrief`（设计智能层）
 * 代码尚无消费者，随该层落地时再补，此处不预造（YAGNI）。
 */

/** 当前 SiteSpec 版本（semver，见 04 §8）。 */
export const SITE_SPEC_VERSION = '1.0.0';

/** API-facing SiteSpec identifiers are bounded strings, not database UUIDs. */
export const SITE_SPEC_IDENTIFIER_PATTERN_SOURCE =
  '[A-Za-z0-9][A-Za-z0-9._:-]{0,127}';

/** Runtime presets that are implemented by the renderer today. */
export const SITE_SPEC_STYLE_PRESETS = [
  'modern-industrial',
  'precision-light',
] as const;
export type SiteSpecStylePreset = (typeof SITE_SPEC_STYLE_PRESETS)[number];

/** Puck 兼容组件块：`{ type, props: { id?, ... } }`（04 §2）。 */
export interface PuckBlock {
  type: string;
  props: Record<string, unknown>;
}

/**
 * 单页 Puck Data（04 §2）：`content` + `root`。
 * `root.props` 取**可选**（调和生产端必填 / 消费端可选；老 spec 无 root.props 仍可渲染）。
 */
export interface PuckData {
  content: PuckBlock[];
  root: { props?: Record<string, unknown> };
}

/** 资产引用（04 §4）：assetId → `{ kind, hash }`。 */
export interface AssetRef {
  kind: string;
  hash: string;
}

/** 单页。 */
export interface SitePage {
  id: string;
  path: string;
  puck: PuckData;
  seo: { titleKey: string; descriptionKey: string };
}

/** SiteSpec 顶层信封（04 §1）——组装 agent 产出 ↔ 渲染器消费 的唯一契约。 */
export interface SiteSpec {
  specVersion: string;
  site: {
    defaultLocale: string;
    locales: string[];
    /** `tokenOverrides` 可选：生产端可不发，消费端主题覆写时读取（04 §6）。 */
    theme: { preset: string; tokenOverrides?: Record<string, string> };
    nav: { labelKey: string; pageId: string }[];
    seoGlobal: { siteName: string };
  };
  pages: SitePage[];
  /** assetId → 引用；生产端可为空对象（尚无资产），消费端按需读取。 */
  assets: Record<string, AssetRef>;
  /** locale → (textKey → 文案)（04 §3 结构/内容分离）。 */
  copyBundles: Record<string, Record<string, string>>;
}
