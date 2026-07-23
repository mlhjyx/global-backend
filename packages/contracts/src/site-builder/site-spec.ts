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

/** Published SiteSpec versions. Demo v0 is permanently pinned to v1. */
export const SITE_SPEC_V1_VERSION = "1.0.0" as const;
export const SITE_SPEC_V1_1_VERSION = "1.1.0" as const;
/** Latest version emitted by the controlled assembler. */
export const SITE_SPEC_VERSION = SITE_SPEC_V1_1_VERSION;

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
  "HeroBanner",
  "StatsBand",
  "ProductGrid",
  "AboutBlock",
  "CertWall",
  "ProcessTimeline",
  "FaqAccordion",
  "CtaBanner",
  "InquiryForm",
  "MapLocation",
  "HeroFull",
  "AreaMarquee",
  "ServicesGrid",
  "TrustSplit",
  "ProcessSteps",
  "PricingTable",
  "Testimonials",
  "AreaGallery",
  "FaqSplit",
  "CtaCenter",
  "EditorialHero",
  "ProjectsGrid",
  "ServicesDark",
  "StatsCountup",
  "MaterialsLibrary",
  "LogoMarquee",
  "SplitAbout",
  "WarmHero",
  "ServiceRows",
  "DishesShowcase",
  "PhotoGallery",
  "MediaCta",
  "FarmhouseHero",
  "ValueStrip",
  "FeaturedSpotlight",
  "StoryChapters",
  "CollectionCards",
  "DispatchHero",
  "LedgerStats",
  "ServicesEditorial",
  "DispatchTimeline",
  "CrewGrid",
  "CoverageMap",
  "AxiomHero",
  "ChapterShowcase",
  "ColorwayPicker",
  "SaaSHero",
  "FeatureCards",
  "PricingTiers",
  "ArticleGrid",
  "IndustrialHero",
  "ProductShowcaseAlt",
  "TechSystems",
  "MinimalHero",
  "StatementBlock",
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
  "AreaMarquee",
  "AreaGallery",
  "DishesShowcase",
  "EditorialHero",
  "CollectionCards",
  "ChapterShowcase",
  "FarmhouseHero",
  "FeaturedSpotlight",
  "LedgerStats",
  "CertWall",
  "CtaBanner",
  "CtaCenter",
  "FeatureCards",
  "FaqAccordion",
  "FaqSplit",
  "HeroBanner",
  "InquiryForm",
  "MapLocation",
  "MaterialsLibrary",
  "LogoMarquee",
  "MediaCta",
  "ProcessTimeline",
  "PricingTable",
  "PricingTiers",
  "ProcessSteps",
  "ProductGrid",
  "ProductShowcaseAlt",
  "ProjectsGrid",
  "PhotoGallery",
  "ServicesGrid",
  "ServicesDark",
  "ServiceRows",
  "SplitAbout",
  "StatsBand",
  "StatsCountup",
  "StatementBlock",
  "StoryChapters",
  "TechSystems",
  "Testimonials",
  "TrustSplit",
  "ValueStrip",
  "WarmHero",
  "DispatchHero",
  "ServicesEditorial",
  "DispatchTimeline",
  "CrewGrid",
  "CoverageMap",
  "HeroFull",
  "AxiomHero",
  "ColorwayPicker",
  "SaaSHero",
  "IndustrialHero",
  "MinimalHero",
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

/** SiteSpec 1.0 asset reference (kept for immutable v1 releases). */
export interface AssetRefV1 {
  kind: string;
  hash: string;
}

/** @deprecated Use AssetRefV1 or AssetRefV1_1 for version-aware code. */
export type AssetRef = AssetRefV1;

export interface TenantAssetRefV1_1 {
  source: "tenant";
  assetId: string;
  kind: string;
  contentHash: string;
  variantId: string;
  variantHash: string;
  mimeType: string;
}

export interface CatalogAssetRefV1_1 {
  source: "catalog";
  packId: string;
  packVersion: string;
  catalogAssetId: string;
  sha256: string;
  mimeType: string;
}

export type AssetRefV1_1 = TenantAssetRefV1_1 | CatalogAssetRefV1_1;

/** 单页。 */
export interface SitePage {
  id: string;
  path: string;
  puck: PuckData;
  seo: { titleKey: string; descriptionKey: string };
}

interface SiteSpecSiteCommon {
  defaultLocale: string;
  locales: string[];
  /** `tokenOverrides` remains a renderer-owned, bounded compatibility seam. */
  theme: {
    preset: SiteSpecStylePreset;
    tokenOverrides?: Record<string, string>;
  };
  nav: { labelKey: string; pageId: string }[];
  seoGlobal: { siteName: string };
  /** Exact HTTPS host allowlist enforced against rendered HTML/CSS/JS. */
  outboundDomains?: string[];
}

interface SiteSpecCommon {
  pages: SitePage[];
  /** locale → (textKey → 文案)（04 §3 结构/内容分离）。 */
  copyBundles: Record<string, Record<string, string>>;
  /** M1-d authoritative immutable documents; legacy copyBundles is a one-cycle projection. */
  copyBundleSet?: CopyBundleSetV1;
}

/** Immutable legacy contract used by Demo v0 and ReleaseManifest v1. */
export interface SiteSpecV1 extends SiteSpecCommon {
  specVersion: typeof SITE_SPEC_V1_VERSION;
  site: SiteSpecSiteCommon;
  assets: Record<string, AssetRefV1>;
}

/** Controlled-assembly contract. All design/runtime identities are frozen. */
export interface SiteSpecV1_1 extends SiteSpecCommon {
  specVersion: typeof SITE_SPEC_V1_1_VERSION;
  componentLibraryVersion: string;
  rendererVersion: string;
  site: {
    archetype: string;
    familyId: string;
    dirByLocale: Record<string, "ltr" | "rtl">;
  } & SiteSpecSiteCommon;
  /** Logical reference id → immutable tenant/catalog source. */
  assets: Record<string, AssetRefV1_1>;
}

/** Explicit version union. Consumers must narrow on `specVersion`. */
export type SiteSpec = SiteSpecV1 | SiteSpecV1_1;
