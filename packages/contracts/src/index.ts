/**
 * Shared, versioned contracts consumed across apps/packages:
 *   - OpenAPI-generated request/response types (REST surface, PRD 11.12)
 *   - AsyncAPI event envelopes + domain event payloads (PRD 11.10 / 11.11)
 *   - JSON Schemas for AI Task input/output (PRD 9.4 / 9.6)
 *
 * The domain layer depends only on these contracts — never on a provider
 * SDK or a provider's raw JSON (ADR-017). Populated contracts-first in P1+.
 */
export const CONTRACTS_PACKAGE = '@global/contracts';
