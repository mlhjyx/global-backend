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
 * #165 已叠加组件 props 的运行时 Zod 子门；完整 SiteSpec 信封、引用、语义与兼容门
 * 仍由 M1-e 增量完成。`DesignBrief`（设计智能层）代码尚无消费者，随该层落地时再补。
 */

import type { CopyBundleSetV1 } from "./copy-bundle";

/** 当前 SiteSpec 版本（semver，见 04 §8）。 */
export const SITE_SPEC_VERSION = "1.0.0";

/** API-facing SiteSpec identifiers are bounded strings, not database UUIDs. */
export const SITE_SPEC_IDENTIFIER_PATTERN_SOURCE =
  "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";

/** Runtime presets that are implemented by the renderer today. */
export const SITE_SPEC_STYLE_PRESETS = [
  "modern-industrial",
  "precision-light",
  "local-trust",
  "editorial-press",
  "warm-kitchen",
  "farmhouse",
  "dispatch",
  "precision-instrument",
  "saas-cream",
  "industrial-power",
  "biotech-minimal",
] as const;
export type SiteSpecStylePreset = (typeof SITE_SPEC_STYLE_PRESETS)[number];

/**
 * 封闭组件库 v1 = 55 型（与 `apps/site-renderer/src/components/Section.astro` 的 registry
 * keys 同一份真值）。运行时 fail-closed：未知 type 由 Section 抛错，不静默返回 null。
 * `Section.spec.ts` 断言 registry keys 与本数组完全相等。
 */
export const SITE_SPEC_COMPONENT_TYPES = [
  "HeroBanner", "StatsBand", "ProductGrid", "AboutBlock", "CertWall",
  "ProcessTimeline", "FaqAccordion", "CtaBanner", "InquiryForm", "MapLocation",
  "HeroFull", "AreaMarquee", "ServicesGrid", "TrustSplit", "ProcessSteps",
  "PricingTable", "Testimonials", "AreaGallery", "FaqSplit", "CtaCenter",
  "EditorialHero", "ProjectsGrid", "ServicesDark", "StatsCountup", "MaterialsLibrary",
  "LogoMarquee", "SplitAbout", "WarmHero", "ServiceRows", "DishesShowcase",
  "PhotoGallery", "MediaCta", "FarmhouseHero", "ValueStrip", "FeaturedSpotlight",
  "StoryChapters", "CollectionCards", "DispatchHero", "LedgerStats", "ServicesEditorial",
  "DispatchTimeline", "CrewGrid", "CoverageMap", "AxiomHero", "ChapterShowcase",
  "ColorwayPicker", "SaaSHero", "FeatureCards", "PricingTiers", "ArticleGrid",
  "IndustrialHero", "ProductShowcaseAlt", "TechSystems", "MinimalHero", "StatementBlock",
] as const;
export type SiteSpecComponentType = (typeof SITE_SPEC_COMPONENT_TYPES)[number];

/**
 * Components that may enter an immutable R1 Release before M1-e-A finishes.
 * The full 55-type registry is available to the development gallery, but new
 * distilled components are promoted here only after their seven-part contract
 * (schema, variants, budgets, a11y, reduced motion, fixtures, visual regression)
 * is complete.
 */
export const SITE_SPEC_RELEASE_COMPONENT_TYPES = [
  "AboutBlock",
  "ArticleGrid",
  "LedgerStats",
  "CertWall",
  "CtaBanner",
  "FeatureCards",
  "FaqAccordion",
  "HeroBanner",
  "InquiryForm",
  "MapLocation",
  "LogoMarquee",
  "ProcessTimeline",
  "PricingTable",
  "PricingTiers",
  "ProcessSteps",
  "ProductGrid",
  "ServicesGrid",
  "StatsBand",
  "StatsCountup",
  "StatementBlock",
  "TechSystems",
  "Testimonials",
  "TrustSplit",
  "ValueStrip",
] as const satisfies readonly SiteSpecComponentType[];
export type SiteSpecReleaseComponentType =
  (typeof SITE_SPEC_RELEASE_COMPONENT_TYPES)[number];

/** Puck 兼容组件块：`{ type, props: { id?, ... } }`（04 §2）。type 封闭为 SiteSpecComponentType。 */
export interface PuckBlock {
  type: SiteSpecComponentType;
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
    theme: { preset: SiteSpecStylePreset; tokenOverrides?: Record<string, string> };
    nav: { labelKey: string; pageId: string }[];
    seoGlobal: { siteName: string };
    /** Exact HTTPS host allowlist enforced against rendered HTML/CSS/JS. */
    outboundDomains?: string[];
  };
  pages: SitePage[];
  /** assetId → 引用；生产端可为空对象（尚无资产），消费端按需读取。 */
  assets: Record<string, AssetRef>;
  /** locale → (textKey → 文案)（04 §3 结构/内容分离）。 */
  copyBundles: Record<string, Record<string, string>>;
  /** M1-d authoritative immutable documents; legacy copyBundles is a one-cycle projection. */
  copyBundleSet?: CopyBundleSetV1;
}
