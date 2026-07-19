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
