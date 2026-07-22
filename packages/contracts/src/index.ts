/**
 * Shared, versioned contracts consumed across apps/packages:
 *   - OpenAPI-generated request/response types (REST surface, PRD 11.12)
 *   - AsyncAPI event envelopes + domain event payloads (PRD 11.10 / 11.11)
 *   - JSON Schemas for AI Task input/output (PRD 9.4 / 9.6)
 *
 * The domain layer depends only on these contracts — never on a provider
 * SDK or a provider's raw JSON (ADR-017). Populated contracts-first in P1+.
 */
export const CONTRACTS_PACKAGE = "@global/contracts";

/**
 * Site Builder 契约（DQ-1）：SiteSpec 顶层信封 + Puck 兼容页面形状。
 * API 生产端与渲染器消费端的唯一类型真值，取代两处手写重复接口。
 */
export * from "./site-builder/site-spec";
export * from "./site-builder/media-foundation";
export * from "./site-builder/evidence";
export * from "./site-builder/model-policy";
export * from "./site-builder/copy-bundle";
export * from "./site-builder/locales";
export * from "./site-builder/inquiry";
export * from "./site-builder/design-source";
export * from "./site-builder/design-observation";
export * from "./site-builder/design-dna";
export * from "./site-builder/template-family";
export * from "./site-builder/design-brief";
export * from "./site-builder/design-evaluation";
export * from "./site-builder/design-catalog";
export * from "./site-builder/component-qualification";

// Astro/Vite consumes this CommonJS package at build time and cannot reliably
// statically discover names hidden behind TypeScript's __exportStar helper.
export {
  resolveSiteCopyBundle,
  copyBundleToLegacyStrings,
} from "./site-builder/copy-bundle";
export { resolveSiteLocale } from "./site-builder/locales";
export { validateBlock, COMPONENT_SCHEMAS } from "./site-builder/component-schema";
export {
  M1_E_A_COMPONENT_QUALIFICATIONS,
  SITE_SPEC_TRANSITIONAL_RELEASE_COMPONENT_TYPES,
  assertReleaseComponentEligible,
  assertReleaseQualificationRegistryIntegrity,
  getComponentReleaseReadiness,
  validateComponentQualification,
} from "./site-builder/component-qualification";
