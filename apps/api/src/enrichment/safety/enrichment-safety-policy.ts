import {
  CONTACT_EMAIL_VERIFICATION_SCHEMAS,
  type ContactEmailVerificationProvider,
} from "../../durable-results/contact-email-verification-projections";
import type { TypedProjectionSchema } from "../../durable-results/durable-result-strategy";
import type { ControlledEnrichmentProvider } from "../../tools/contact-enrichment-safety-tools";
import {
  parseEnrichmentContactApplyDecision,
  type EnrichmentContactApplyDecision,
} from "./enrichment-domain-commit";
import type { QuotedEnrichmentSlot } from "./enrichment-safety.contract";

/**
 * Single source of truth for controlled contact-enrichment safety policy.
 *
 * Consolidates previously split-brain constants and predicates shared across:
 *  - `enrichment-call-plan.ts` (slot validation)
 *  - `enrichment-result-reader.ts` (typed projection & artifact schema lookup)
 *  - `enrichment-domain-commit.ts` (active original-step coherence)
 *  - `contact-enrichment-safety.composition.ts` (preflight gating, SQL guards,
 *    snapshot decision lookup, and head-status aggregation)
 *  - `runtime/config-drift-diagnostics.ts` (startup four-way drift diagnostics)
 */
export const CONTROLLED_ENRICHMENT_FINDERS = Object.freeze([
  "hunter",
  "prospeo",
] as const);

export type ControlledEnrichmentFinder =
  (typeof CONTROLLED_ENRICHMENT_FINDERS)[number];

export const CONTROLLED_ENRICHMENT_VERIFIERS = Object.freeze([
  "millionverifier",
  "emailable",
  "zerobounce",
] as const);

export type ControlledEnrichmentVerifier =
  (typeof CONTROLLED_ENRICHMENT_VERIFIERS)[number];

export const CONTROLLED_ENRICHMENT_PROVIDERS: readonly ControlledEnrichmentProvider[] =
  Object.freeze([
    ...CONTROLLED_ENRICHMENT_FINDERS,
    ...CONTROLLED_ENRICHMENT_VERIFIERS,
  ]);

const FINDER_SET: ReadonlySet<string> = new Set(CONTROLLED_ENRICHMENT_FINDERS);
const VERIFIER_SET: ReadonlySet<string> = new Set(
  CONTROLLED_ENRICHMENT_VERIFIERS,
);
const PROVIDER_SET: ReadonlySet<string> = new Set(
  CONTROLLED_ENRICHMENT_PROVIDERS,
);

export function isControlledEnrichmentFinder(
  provider: string,
): provider is ControlledEnrichmentFinder {
  return FINDER_SET.has(provider);
}

export function isControlledEnrichmentVerifier(
  provider: string,
): provider is ControlledEnrichmentVerifier {
  return VERIFIER_SET.has(provider);
}

export function isControlledEnrichmentVerifierOrSmtp(
  provider: string,
): boolean {
  return provider === "smtp_self" || VERIFIER_SET.has(provider);
}

export function isControlledEnrichmentProvider(
  provider: string,
): provider is ControlledEnrichmentProvider {
  return PROVIDER_SET.has(provider);
}

export function controlledFinderResultSchema(
  provider: ControlledEnrichmentFinder,
): `contact-email-find-${ControlledEnrichmentFinder}/v1` {
  return `contact-email-find-${provider}/v1`;
}

const FINDER_SCHEMA_SET: ReadonlySet<string> = new Set(
  CONTROLLED_ENRICHMENT_FINDERS.map(controlledFinderResultSchema),
);

export function isControlledFinderResultSchema(
  schema: string | null | undefined,
): boolean {
  return typeof schema === "string" && FINDER_SCHEMA_SET.has(schema);
}

export function controlledVerificationResultSchema(
  phase: "VERIFY" | "SMTP",
  provider: string,
): TypedProjectionSchema | null {
  if (phase === "SMTP") return "smtp-probe-verdict/v1";
  if (!isControlledEnrichmentVerifier(provider)) return null;
  return CONTACT_EMAIL_VERIFICATION_SCHEMAS[
    provider as ContactEmailVerificationProvider
  ];
}

export function isSupportedControlledEnrichmentSlot(
  slot: Pick<QuotedEnrichmentSlot, "phase" | "provider" | "toolId">,
): boolean {
  if (slot.phase === "FINDER") {
    return (
      isControlledEnrichmentFinder(slot.provider) &&
      slot.toolId === `contact_email.find.${slot.provider}`
    );
  }
  if (slot.phase === "SMTP") {
    return slot.provider === "smtp_self" && slot.toolId === "smtp.rcpt_probe";
  }
  return (
    slot.phase === "VERIFY" &&
    isControlledEnrichmentVerifier(slot.provider) &&
    slot.toolId === `contact_email.verify.${slot.provider}`
  );
}

/** Shared closed snapshot reader for a single contact's committed apply decision. */
export function findCommittedContactDecision(
  snapshot: unknown,
  contactId: string,
): EnrichmentContactApplyDecision | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const contacts = (snapshot as { contacts?: unknown }).contacts;
  if (!Array.isArray(contacts)) return null;
  const found = contacts.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      (entry as { contactId?: unknown }).contactId === contactId,
  );
  return found === undefined ? null : parseEnrichmentContactApplyDecision(found);
}

/** Shared step-fact coherence and original-ticket lifecycle predicates. */
export interface OriginalEnrichmentStepFact {
  readonly operationId: string | null;
  readonly status: string | null;
  readonly dispatchPhase: string;
  readonly domainState: string;
}

export function isTerminalEnrichmentDispatchPhase(phase: string): boolean {
  return phase === "SETTLED" || phase === "SETTLED_WAITING_APPLY";
}

export function isClosedOriginalEnrichmentStep(fact: {
  readonly status: string | null;
  readonly dispatchPhase: string;
  readonly domainState: string;
}): boolean {
  return (
    fact.status === "SETTLED" &&
    isTerminalEnrichmentDispatchPhase(fact.dispatchPhase) &&
    fact.domainState === "APPLIED"
  );
}

export function isReadyOriginalEnrichmentStep(fact: {
  readonly status: string | null;
  readonly dispatchPhase: string;
}): boolean {
  return (
    fact.status === "SETTLED" && fact.dispatchPhase === "SETTLED_WAITING_APPLY"
  );
}

export function isActiveOriginalEnrichmentFact(
  fact: OriginalEnrichmentStepFact,
): boolean {
  return (
    fact.operationId !== null &&
    fact.status !== "RELEASED" &&
    !isClosedOriginalEnrichmentStep(fact)
  );
}

export function areOriginalStepFactsCoherent(
  facts: readonly OriginalEnrichmentStepFact[],
): boolean {
  return !facts.some(isActiveOriginalEnrichmentFact);
}

export interface EnrichmentHeadStepFact {
  readonly contact_id: string | null;
  readonly dispatch_phase: string;
  readonly domain_state: string;
  readonly operation_id: string | null;
  readonly operation_status: string | null;
}

/**
 * Single source of truth for execution head status aggregation across
 * `persist`, `finishAttempt`, and `savePending`.
 */
export function aggregateEnrichmentHeadStatus(
  parsed: readonly EnrichmentContactApplyDecision[],
  facts: readonly EnrichmentHeadStepFact[],
  remaining: number,
  targetCount: number,
  pendingSignal = false,
): "COMPLETED" | "APPLY_PENDING" | "RUNNING" {
  const activePaid = facts.some((fact) =>
    isActiveOriginalEnrichmentFact({
      operationId: fact.operation_id,
      status: fact.operation_status,
      dispatchPhase: fact.dispatch_phase,
      domainState: fact.domain_state,
    }),
  );
  const releasedWithoutObligation = (fact: EnrichmentHeadStepFact) =>
    fact.dispatch_phase === "RELEASED" &&
    (fact.operation_id === null || fact.operation_status === "RELEASED");
  const genuinePending =
    parsed.some((entry) => entry.status === "SAVE_PENDING") ||
    activePaid ||
    facts.some(
      (fact) =>
        fact.domain_state === "SAVE_PENDING" &&
        !releasedWithoutObligation(fact),
    );
  const closed =
    parsed.length === targetCount &&
    parsed.every(
      (entry) => entry.status === "APPLIED" || entry.status === "REPLAYED",
    ) &&
    !activePaid &&
    !pendingSignal;
  if (closed) return "COMPLETED";
  if (genuinePending || pendingSignal) return "APPLY_PENDING";
  if (remaining > 0) return "RUNNING";
  return parsed.length === targetCount ? "APPLY_PENDING" : "RUNNING";
}
