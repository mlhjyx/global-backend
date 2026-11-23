import { createHash } from "node:crypto";
import { assertPiiKeyConfigured } from "../../compliance/pii-crypto";
import { genericArtifactStorageConfig } from "../../durable-results/artifact/generic-operation-artifact.storage-config";
import { GenericOperationArtifactService } from "../../durable-results/artifact/generic-operation-artifact.service";
import { GenericOperationArtifactRepository } from "../../durable-results/artifact/generic-operation-artifact.repository";
import { sharedGenericOperationArtifactStore } from "../../durable-results/artifact/generic-operation-artifact.runtime";
import { contactEmailFindMaterializer } from "../../durable-results/artifact/materializers/contact-email-find.materializer";
import type { BudgetStore } from "../../tools/budget-store";
import type { ContactEnrichmentSafetyToolDeps, ControlledEnrichmentWireInput } from "../../tools/contact-enrichment-safety-tools";
import { buildToolBroker } from "../../tools/tool-broker.factory";
import { CONTROLLED_ENRICHMENT_API_HOSTS, type ControlledEnrichmentProvider, type ControlledEnrichmentProviderState } from "../../tools/contact-enrichment-safety-tools";
import { resolveHunterConfig } from "../finders/hunter.provider";
import { resolveMillionVerifierConfig } from "../verification/millionverifier.provider";
import { resolveEmailableConfig } from "../verification/emailable.provider";
import { resolveZeroBounceConfig } from "../verification/zerobounce.provider";
import { resolveConfiguredFinderProviders, resolveConfiguredTailFinderProviders } from "../finders/finder-pool";
import { checkProviderGates } from "../provider-gates";
import { loadCompanyContactEnrichmentTier, loadContactEnrichmentTargets, reachableContactEnrichmentFinders, gateConfiguredVerificationProviders } from "../waterfall/enrich-company-contacts";
import { enrichmentInputVersion, enrichmentRequestHash } from "../finders/email-enrichment-provider";
import { contactMayUseExternalProcessing } from "../../discovery/company-suppression-gate";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { contactTargetBeforeDigest, type EnrichmentPointBeforeSnapshot } from "./enrichment-target-snapshot";
import { canonicalSafetyJson, closedSafetyRecord, safetyInteger, EnrichmentSafetyError, type ContactTargetSnapshot, type QuotedEnrichmentSlot } from "./enrichment-safety.contract";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { WorkspaceEnrichmentTransactions } from "./enrichment-execution.repository";
import type { ExecutionBroker } from "../../tools/tool-contract";
import type { ContactEnrichmentPreparationInput, ContactEnrichmentPreparation } from "./contact-enrichment-safety.service";
import { resolveMx } from "node:dns/promises";
import { parseArtifactReference } from "../../durable-results/artifact/artifact-reference.schema";
import { paidOperationKey } from "../../site-builder/site-build-cost-ledger";
import { SmtpProbeProvider, mapSmtpProbeOutcome } from "../verification/smtp-probe.provider";
import { TypedProjectionRegistry } from "../../durable-results/typed-projection.registry";
import { registerContactEmailVerificationProjections } from "../../durable-results/contact-email-verification-projections";
import { registerSourceResultProjections } from "../../durable-results/source-result-projections";
import { originalSmtpBudgetOperationKey } from "../../tools/contact-enrichment-safety-tools";
import { durableReceiptFromLedgerRow, requireLedgerProjectionReceipt } from "../../tools/budget-operation-result";
import { parseGenericOperationProjection } from "../../tools/generic-operation-projection";
import { EnrichmentExecutionRepository, EnrichmentExecutionQueryRepository, linkEnrichmentStepSettled, markEnrichmentStepHold, listCompanyEnrichmentHeads } from "./enrichment-execution.repository";
import { EnrichmentOriginalResultRepository, EnrichmentResultReader } from "./enrichment-result-reader";
import { GovernedEnrichmentInvoker } from "./governed-enrichment-invoker";
import { EnrichmentDomainCommitter, parseEnrichmentContactApplyDecision } from "./enrichment-domain-commit";
import { ContactEnrichmentSafetyService } from "./contact-enrichment-safety.service";
import { buildContactEnrichmentQualityResult, encodeContactEnrichmentResultCursor } from "./contact-enrichment-results.dto";
import { readEnrichmentResultSnapshot } from "./enrichment-result-snapshot";
import { buildContactEnrichmentQualityFacts } from "./contact-enrichment-quality-facts.dto";
import type { ContactQualityFact } from "./enrichment-quality-facts";
import { finderPhysicalInputFingerprint, verificationPhysicalInputFingerprint, smtpPhysicalInputFingerprint } from "./enrichment-target-snapshot";
import { parseBoundEnrichmentStepRow } from "./enrichment-safety.contract";
import { findReusableAttempt, recordEnrichmentAttempt } from "../waterfall/enrichment-attempt";
import { applyCircuitOutcome, circuitAllowsCall, PrismaCircuitBreakerStore, type CircuitBreakerStore } from "../waterfall/circuit-breaker";
import { resolveVerificationVotes } from "../verification/verification-policy";
import { parseContactEmailVerificationResult } from "../../durable-results/contact-email-verification-projections";
export interface ContactEnrichmentPreparationDeps {
  readonly prisma: WorkspaceEnrichmentTransactions & PrismaClient;
  readonly env?: NodeJS.ProcessEnv; readonly clock?: () => Date; readonly broker?: ExecutionBroker;
  authorizeContact?: (tx: Prisma.TransactionClient, workspaceId: string, contactId: string) => Promise<boolean>;
  artifactsConfigured?: () => boolean;
}
/** Original pools/selector/gates only. Constructing a provider never means invoking it. */
export async function loadControlledEnrichmentProviderState(
  client: PrismaClient, env: NodeJS.ProcessEnv, provider: ControlledEnrichmentProvider,
): Promise<ControlledEnrichmentProviderState> {
  const config = provider === "hunter" ? resolveHunterConfig(env) : provider === "millionverifier" ? resolveMillionVerifierConfig(env) : provider === "emailable" ? resolveEmailableConfig(env) : resolveZeroBounceConfig(env);
  // The original gate reads only these two actual native delegates. No proposed model or alternate authority is fabricated.
  const gate = await checkProviderGates(client, { key: provider, domain: CONTROLLED_ENRICHMENT_API_HOSTS[provider] });
  const policy = await client.sourcePolicy.findUnique({ where: { domain: CONTROLLED_ENRICHMENT_API_HOSTS[provider] }, select: { retentionDays: true, updatedAt: true } });
  const retentionSeconds = policy && Number.isSafeInteger(policy.retentionDays) && policy.retentionDays > 0 ? policy.retentionDays * 86400 : 0;
  const revision = policy?.updatedAt instanceof Date && Number.isFinite(policy.updatedAt.getTime()) ? policy.updatedAt.toISOString() : "unavailable";
  const pricingVersion = createHash("sha256").update(canonicalSafetyJson({ version: 1, provider, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, costMicrousd: config.costMicrousd, retentionSeconds, policyRevision: revision })).digest("hex");
  return { provider, ...config, enabled: gate.ok, policyAllowed: gate.ok, retentionSeconds, pricingVersion };
}
export const ENRICHMENT_POINT_BEFORE_SELECT = Object.freeze({ id: true, type: true, value: true, status: true, verificationState: true, validSince: true, verifiedAt: true, nextReverifyAt: true, lastVerificationEventId: true, confidence: true } as const);
export function pointBeforeSnapshot(point: { id: string; type: string; value: string; status: string; verificationState: string; validSince: Date | null; verifiedAt: Date | null; nextReverifyAt: Date | null; lastVerificationEventId: string | null; confidence: number | null }): EnrichmentPointBeforeSnapshot {
  return { id: point.id, type: point.type, value: point.value, status: point.status, verificationState: point.verificationState,
    validSince: point.validSince?.toISOString() ?? null, verifiedAt: point.verifiedAt?.toISOString() ?? null, nextReverifyAt: point.nextReverifyAt?.toISOString() ?? null,
    lastVerificationEventId: point.lastVerificationEventId, confidence: point.confidence };
}
function preparerStateUsable(state: ControlledEnrichmentProviderState): boolean {
  if (!state.enabled || !state.policyAllowed || !state.apiKey || !Number.isSafeInteger(state.costMicrousd) || state.costMicrousd < 0 || state.costMicrousd > 150000 || !Number.isSafeInteger(state.timeoutMs) || state.timeoutMs < 100 || !Number.isSafeInteger(state.retentionSeconds) || state.retentionSeconds < 1) return false;
  try { const url = new URL(state.baseUrl); return url.protocol === "https:" && url.hostname === CONTROLLED_ENRICHMENT_API_HOSTS[state.provider] && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"; } catch { return false; }
}
export function createContactEnrichmentSafetyPreparer(deps: ContactEnrichmentPreparationDeps): (input: ContactEnrichmentPreparationInput) => Promise<ContactEnrichmentPreparation> {
  const env = deps.env ?? process.env;
  return async (input) => {
    const no = (reasonCode: string, tier: "A" | "B" = "B"): ContactEnrichmentPreparation => ({ status: "NOT_ADMITTED", reasonCode, tier });
    const primary = resolveConfiguredFinderProviders(env), tail = resolveConfiguredTailFinderProviders(env);
    const tier = await loadCompanyContactEnrichmentTier(deps.prisma, { workspaceId: input.workspaceId, companyId: input.companyId }, tail.length > 0);
    const configured = reachableContactEnrichmentFinders(primary, tail, tier);
    if (configured.length === 0) return no("NO_CONFIGURED_FINDER", tier);
    const finders = [];
    for (const finder of configured) if ((await checkProviderGates(deps.prisma, finder)).ok) finders.push(finder);
    if (finders.length === 0) return no("NO_ENABLED_FINDER", tier);
    if (finders.some((finder) => finder.key !== "hunter")) return no("GOVERNANCE_PENDING", tier);
    const verifiers = await gateConfiguredVerificationProviders(deps.prisma, env, deps.broker);
    if (verifiers.some((provider) => !["millionverifier", "emailable", "zerobounce", "smtp_self"].includes(provider.key))) return no("GOVERNANCE_PENDING", tier);
    try {
      assertPiiKeyConfigured();
      if (deps.artifactsConfigured ? !deps.artifactsConfigured() : !genericArtifactStorageConfig(env)) return no("ARTIFACT_UNAVAILABLE", tier);
    } catch { return no("ARTIFACT_UNAVAILABLE", tier); }
    const providerNames = ["hunter", ...verifiers.filter((provider) => provider.key !== "smtp_self").map((provider) => provider.key)] as ControlledEnrichmentProvider[];
    const states = new Map<ControlledEnrichmentProvider, ControlledEnrichmentProviderState>();
    for (const provider of providerNames) { const state = await loadControlledEnrichmentProviderState(deps.prisma, env, provider); if (!preparerStateUsable(state)) return no("POLICY_UNAVAILABLE", tier); states.set(provider, state); }
    const admittedAtMs = (deps.clock ?? (() => new Date()))().getTime();
    if (!Number.isSafeInteger(admittedAtMs) || admittedAtMs < 0) return no("POLICY_UNAVAILABLE", tier);
    try {
      return await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
        const selected = await loadContactEnrichmentTargets(tx, { companyId: input.companyId, ...(input.options.contactIds === undefined ? {} : { contactIds: input.options.contactIds }) }, 10);
        if (!selected.company?.domain) return no("NO_DOMAIN", tier);
        if (selected.contacts.length === 0) return no("NO_CONTACTS", tier);
        const targets: ContactTargetSnapshot[] = [], slots: QuotedEnrichmentSlot[] = [];
        for (const [ordinal, contact] of selected.contacts.entries()) {
          const authorized = deps.authorizeContact ? await deps.authorizeContact(tx, input.workspaceId, contact.id) : await contactMayUseExternalProcessing(tx, { workspaceId: input.workspaceId, contactId: contact.id });
          if (!authorized) return no("SUPPRESSED", tier);
          const points = await tx.contactPoint.findMany({ where: { workspaceId: input.workspaceId, contactId: contact.id }, select: ENRICHMENT_POINT_BEFORE_SELECT, orderBy: { id: "asc" }, take: 101 });
          const current = points.map(pointBeforeSnapshot);
          const inputVersion = enrichmentInputVersion({ fullName: contact.fullName, domain: selected.company.domain, companyName: selected.company.name });
          targets.push({ contactId: contact.id, contactOrdinal: ordinal, inputVersion, beforeDigest: contactTargetBeforeDigest({ inputVersion, points: current }), pointRefs: current.map((point) => point.id) });
          const finderKey = `contact-${ordinal}-finder`; const finder = states.get("hunter")!;
          slots.push({ slotKey: finderKey, contactId: contact.id, contactOrdinal: ordinal, phase: "FINDER", provider: "hunter", toolId: "contact_email.find.hunter", toolVersion: "1.0.0", quoteMicrousd: BigInt(finder.costMicrousd).toString(), pricingVersion: finder.pricingVersion, dependsOnSlotKey: null });
          let predecessor = finderKey;
          for (const [position, verifier] of verifiers.entries()) {
            const smtp = verifier.key === "smtp_self", state = smtp ? null : states.get(verifier.key as ControlledEnrichmentProvider)!;
            const slotKey = `contact-${ordinal}-verify-${position}`;
            slots.push({ slotKey, contactId: contact.id, contactOrdinal: ordinal, phase: smtp ? "SMTP" : "VERIFY", provider: verifier.key, toolId: smtp ? "smtp.rcpt_probe" : "contact_email.verify." + verifier.key, toolVersion: "1.0.0", quoteMicrousd: smtp ? "0" : BigInt(state!.costMicrousd).toString(), pricingVersion: smtp ? "original-smtp-v1" : state!.pricingVersion, dependsOnSlotKey: predecessor }); predecessor = slotKey;
          }
        }
        const plan = buildFrozenEnrichmentPlan({ workspaceId: input.workspaceId, companyId: input.companyId, entrypoint: input.entrypoint, businessRunId: input.businessRunId, requestSha256: input.requestSha256, admittedAtMs, deadlineAtMs: admittedAtMs + 600000, targets, slots,
          limits: { authorityCapMicrousd: input.authorityCapMicrousd, companyCapMicrousd: input.authorityCapMicrousd, contactCapMicrousd: "150000", finderCompanyMax: 10, finderContactMax: input.options.maxProviders ?? 3, verifyAddressMax: input.options.maxProbe ?? 6, maxContacts: 10 } });
        return { status: "PREPARED" as const, plan, tier };
      });
    } catch (error) {
      if (error instanceof EnrichmentSafetyError && error.code === "BUDGET_CAP_EXCEEDED") return no("BUDGET_CAP", tier);
      if (error instanceof EnrichmentSafetyError && error.code === "GOVERNANCE_PENDING") return no("GOVERNANCE_PENDING", tier);
      throw error;
    }
  };
}

export interface ContactEnrichmentSafetyRuntimeDeps {
  readonly prisma: ContactEnrichmentPreparationDeps['prisma'];
  readonly authority: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyServiceDeps['authority'];
  readonly broker: ExecutionBroker;
  readonly guards?: import('./enrichment-execution.repository').EnrichmentStepGuards;
  readonly grantConsumer: import('./enrichment-execution.repository').EnrichmentGrantConsumer;
  readonly store: import('./enrichment-domain-commit').EnrichmentDomainCommitStore;
  readonly artifacts?: import('./enrichment-result-reader').EnrichmentResultReaderDeps['artifacts'];
  readonly finderMaterializer?: import('./enrichment-result-reader').EnrichmentResultReaderDeps['finderMaterializer'];
  readonly loadTrustedInput?: (stepId: string, context: { workspaceId: string }) => Promise<import('../../tools/contact-enrichment-safety-tools').ControlledEnrichmentWireInput>;
  readonly materializeForDomain?: import('./enrichment-result-reader').EnrichmentResultReader['materializeForDomain'];
  readonly acknowledge?: import('./enrichment-domain-commit').EnrichmentDomainCommitDeps['acknowledge'];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly reusableAttempt?: (input: { workspaceId: string; contactId: string; providerKey: string; requestHash: string; now: Date }) => Promise<import("../waterfall/enrichment-attempt").EnrichmentAttemptSnapshot | null>;
  readonly recordAttempt?: (input: { workspaceId: string; contactId: string; providerKey: string; requestHash: string; outcome: "error" | "miss" | "hit" | "skipped_budget" | "skipped_compliance"; errorCode?: string | null; retryable?: boolean | null; runId?: string | null; accountKey: string; attemptedAt: Date }) => Promise<unknown>;
  readonly circuit?: CircuitBreakerStore;
  readonly budgets?: import('./enrichment-result-reader').EnrichmentResultReaderDeps['budgets'];
  readonly readSmtpResult?: import('./governed-enrichment-invoker').GovernedEnrichmentInvokerDeps['readSmtpResult'];
  readonly authorizeCurrent?: import('./enrichment-domain-commit').EnrichmentDomainCommitDeps['authorizeCurrent'];
  readonly prepare: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyServiceDeps['prepare'];
  readonly authorizeRecovery: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyServiceDeps['authorizeRecovery'];
}
export interface ContactEnrichmentSafetyRuntime {
  readonly service: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyService;
  readonly repository: import('./enrichment-execution.repository').EnrichmentExecutionRepository;
  readonly query: import('./enrichment-execution.repository').EnrichmentExecutionQueryRepository;
}
/** Scoped adapter dependencies; exported so the real list/read page behaviour is directly testable. */
export interface ContactEnrichmentResultsAdapterDeps {
  readonly database: import('./enrichment-execution.repository').WorkspaceEnrichmentTransactions;
  readonly loadById: (
    context: { workspaceId: string; companyId: string },
    id: string,
  ) => Promise<import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord | null>;
  readonly loadByRef: (
    context: { workspaceId: string; companyId: string },
    operationRef: string,
  ) => Promise<import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord | null>;
}
async function enrichmentResultsPage(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  parsed: import('./contact-enrichment-results.dto').ContactEnrichmentResultsQuery,
  build: (
    record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord,
  ) => unknown,
) {
  const scope = { workspaceId: context.workspaceId, companyId };
  const heads = await listCompanyEnrichmentHeads(deps.database, scope, {
    limit: parsed.limit,
    cursor: parsed.cursor,
    businessRunId: parsed.businessRunId,
  });
  // Unknown/foreign/soft-deleted company: no legitimate empty page exists.
  if (heads === null) return null;
  const page = heads.slice(0, parsed.limit);
  const items: unknown[] = [];
  for (const head of page) {
    const record = await deps.loadById(scope, head.id);
    if (record) items.push(build(record));
  }
  const hasMore = heads.length > parsed.limit;
  const last = page[page.length - 1];
  // The cursor follows the last head of the page even when its record cannot hydrate,
  // so a skipped record never shifts the next page boundary.
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeContactEnrichmentResultCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    hasMore,
  };
}
async function enrichmentResultByRef(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  operationRef: string,
  build: (
    record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord,
  ) => unknown,
) {
  const record = await deps.loadByRef({ workspaceId: context.workspaceId, companyId }, operationRef);
  return record ? build(record) : null;
}
export function listContactEnrichmentResults(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  parsed: import('./contact-enrichment-results.dto').ContactEnrichmentResultsQuery,
) {
  return enrichmentResultsPage(deps, context, companyId, parsed, buildContactEnrichmentQualityResult);
}
export function readContactEnrichmentResult(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  operationRef: string,
) {
  return enrichmentResultByRef(deps, context, companyId, operationRef, buildContactEnrichmentQualityResult);
}
export function listContactEnrichmentQualityFacts(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  parsed: import('./contact-enrichment-results.dto').ContactEnrichmentResultsQuery,
) {
  return enrichmentResultsPage(deps, context, companyId, parsed, buildContactEnrichmentQualityFacts);
}
export function readContactEnrichmentQualityFacts(
  deps: ContactEnrichmentResultsAdapterDeps,
  context: { workspaceId: string },
  companyId: string,
  operationRef: string,
) {
  return enrichmentResultByRef(deps, context, companyId, operationRef, buildContactEnrichmentQualityFacts);
}
/** Real composition root for the shared safety lane; every SQL/transport port is injected, absence fails closed. */
export function createContactEnrichmentSafetyRuntime(deps: ContactEnrichmentSafetyRuntimeDeps): ContactEnrichmentSafetyRuntime {
  const prisma = deps.prisma;
  const clock = deps.now ?? (() => new Date());
  const query = new EnrichmentExecutionQueryRepository(prisma);
  const originals = new EnrichmentOriginalResultRepository(prisma);
  const projections = registerSourceResultProjections(registerContactEmailVerificationProjections(new TypedProjectionRegistry()));
  const reader = new EnrichmentResultReader({
    loadBinding: (stepId, context) => originals.loadBinding(stepId, context),
    budgets: deps.budgets ?? {},
    projections,
    ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
    ...(deps.finderMaterializer ? { finderMaterializer: deps.finderMaterializer } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const repository = new EnrichmentExecutionRepository(prisma, deps.grantConsumer, deps.guards);
  const materializeForDomain = deps.materializeForDomain ?? ((stepId: string, context: { workspaceId: string; companyId: string }) => reader.materializeForDomain(stepId, context));
  const committer = new EnrichmentDomainCommitter({
    transactions: prisma,
    store: deps.store,
    materialize: materializeForDomain,
    authorizeCurrent: deps.authorizeCurrent ?? ((tx, address, email) => contactMayUseExternalProcessing(tx, { workspaceId: address.workspaceId, contactId: address.contactId, ...(email === undefined ? {} : { email }) })),
    ...(deps.acknowledge ? { acknowledge: deps.acknowledge } : {}),
    ...(deps.now ? { clock: deps.now } : {}),
  });
  const trustedContext = (workspaceId: string, companyId: string) => ({ workspaceId, companyId, authorizeExternalAction: async () => true });
  const invoker = new GovernedEnrichmentInvoker({
    broker: deps.broker,
    loadCurrentStep: async (stepId, context) => {
      const row = await loadStepRow(prisma, context.workspaceId, context.companyId, stepId);
      return {
        step: parseBoundEnrichmentStepRow(row),
        dispatchPhase: row.dispatch_phase as import('./governed-enrichment-invoker').EnrichmentStepExecutionState["dispatchPhase"],
        domainState: row.domain_state as import('./governed-enrichment-invoker').EnrichmentStepExecutionState["domainState"],
      };
    },
    readOriginalResult: (step) => reader.loadEnrichmentStepResult(step.stepId, { workspaceId: step.workspaceId, companyId: step.companyId }),
    claimBeforePhysicalWire: (step) => repository.claimStepBeforeWire({ workspaceId: step.workspaceId, companyId: step.companyId, stepId: step.stepId, expectedRevision: step.revision, operationKey: step.operationKey, expectedPricingVersion: step.pricingVersion }),
    linkSettledReference: async (step, reference) => {
      await prisma.withWorkspace(step.workspaceId, (tx) => linkEnrichmentStepSettled(tx, { workspaceId: step.workspaceId, executionId: step.executionId, stepId: step.stepId, expectedRevision: step.revision, operationId: step.budgetOperationId ?? reference.durableReceipt.operationId, reference }));
    },
    hold: async (step) => {
      try {
        await prisma.withWorkspace(step.workspaceId, (tx) => markEnrichmentStepHold(tx, { workspaceId: step.workspaceId, executionId: step.executionId, stepId: step.stepId, expectedRevision: step.revision }));
      } catch {
        /* metadata-only ACK failure never authorizes another wire */
      }
    },
    ...(deps.readSmtpResult ? { readSmtpResult: deps.readSmtpResult } : {}),
  });
  const attemptCache = deps.reusableAttempt ?? ((input: { workspaceId: string; contactId: string; providerKey: string; requestHash: string; now: Date }) => prisma.withWorkspace(input.workspaceId, (tx) => findReusableAttempt(tx, input)));
  const recordAttempt = deps.recordAttempt ?? ((input: { workspaceId: string; contactId: string; providerKey: string; requestHash: string; outcome: "error" | "miss" | "hit" | "skipped_budget" | "skipped_compliance"; errorCode?: string | null; retryable?: boolean | null; runId?: string | null; accountKey: string; attemptedAt: Date }) => prisma.withWorkspace(input.workspaceId, (tx) => recordEnrichmentAttempt(tx, input)));
  const circuits = deps.circuit ?? new PrismaCircuitBreakerStore(prisma);
  const finderFor = (record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord, row: import('./enrichment-safety.contract').EnrichmentStepContextRow) => {
  const finders = record.steps.filter((step) => step.phase === 'FINDER' && step.contact_id === row.contact_id && step.contact_ordinal === row.contact_ordinal);
  if (finders.length !== 1) throw new EnrichmentSafetyError('HOLD');
  const finder = finders[0]!;
  if (row.phase === 'FINDER') return finder;
  let key = row.depends_on_slot_key;
  for (let depth = 0; key !== null; depth += 1) {
    if (depth > 20) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
    if (key === finder.slot_key) return finder;
    const predecessor = record.steps.find((step) => step.contact_id === row.contact_id && step.slot_key === key);
    if (!predecessor) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
    key = predecessor.depends_on_slot_key;
  }
  throw new EnrichmentSafetyError('CONTROL_MISMATCH');
  };
  const terminal = (row: import('./enrichment-safety.contract').EnrichmentStepContextRow) => row.dispatch_phase === 'SETTLED' || row.dispatch_phase === 'SETTLED_WAITING_APPLY';
  type RuntimeStep = import('./enrichment-safety.contract').EnrichmentRuntimeStepRow;
  const hasOriginalTicket = (step: RuntimeStep) => step.budget_original_id !== null || step.budget_operation_id !== null;
  const closedOriginalStep = (step: RuntimeStep) => step.budget_status === 'SETTLED' && terminal(step) && step.domain_state === 'APPLIED';
  const readyOriginalStep = (step: RuntimeStep) => step.budget_status === 'SETTLED' && step.dispatch_phase === 'SETTLED_WAITING_APPLY';
  const requiredOriginalStepIds = (current: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord, contactId: string) =>
    current.steps.filter((step) => step.contact_id === contactId && step.dispatch_phase !== 'REDACTED' && hasOriginalTicket(step) && step.budget_status !== 'RELEASED').map((step) => step.id);
  const contactHasActiveOriginal = (current: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord, contactId: string) =>
    current.steps.some((step) => step.contact_id === contactId && step.dispatch_phase !== 'REDACTED' && hasOriginalTicket(step) && step.budget_status !== 'RELEASED' && !closedOriginalStep(step));
  type LoadedRecord = import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord & { plan: NonNullable<import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord['plan']> };
  type FinderMaterialized = Extract<import('./enrichment-safety.contract').EnrichmentDomainMaterializedResult, { phase: 'FINDER' }>;
  const executeFinderTarget = async (input: {
    workspaceId: string; companyId: string; executionId: string; target: import('./enrichment-safety.contract').ContactTargetSnapshot;
    record: LoadedRecord; finder: import('./enrichment-safety.contract').EnrichmentRuntimeStepRow; contactSteps: readonly import('./enrichment-safety.contract').EnrichmentRuntimeStepRow[];
    load: () => Promise<LoadedRecord>;
  }): Promise<{ kind: 'decided'; decision: import('./enrichment-domain-commit').EnrichmentContactApplyDecision } | { kind: 'materialized'; materialized: FinderMaterialized }> => {
    const { workspaceId, companyId, executionId, target, finder, contactSteps, load } = input;
    let record = input.record;
    const finderTicket = hasOriginalTicket(finder) && finder.budget_status !== 'RELEASED';
    const contactTicket = record.steps.some((step) => step.contact_id === target.contactId && step.dispatch_phase !== 'REDACTED' && hasOriginalTicket(step) && step.budget_status !== 'RELEASED');
    if (!finderTicket && contactTicket) throw new EnrichmentSafetyError('HOLD');
    let bound!: import('./enrichment-safety.contract').BoundEnrichmentStep;
    let onFailure: (() => Promise<void>) | null = null;
    let onSuccess: (() => Promise<void>) | null = null;
    let paidHold = false;
    if (!finderTicket) {
      const wire = deps.loadTrustedInput ? await deps.loadTrustedInput(finder.id, { workspaceId }) : null;
      if (!wire?.finder) throw new EnrichmentSafetyError('HOLD');
      const requestHash = enrichmentRequestHash(target.contactId, 'hunter', wire.finder);
      const reusable = await attemptCache({ workspaceId, contactId: target.contactId, providerKey: 'hunter', requestHash, now: clock() });
      if (reusable) {
        const state = reusable.outcome === 'hit' && reusable.emailState !== null && ['VALID', 'INVALID', 'CATCH_ALL_RISKY', 'UNKNOWN'].includes(reusable.emailState) ? reusable.emailState as import('./enrichment-domain-commit').EnrichmentContactApplyDecision['state'] : null;
        const decision = Object.freeze({ status: 'APPLIED' as const, contactId: target.contactId, reasonCode: reusable.outcome === 'hit' ? 'REUSED' as const : 'NO_MATCH' as const, state: reusable.outcome === 'hit' ? state : null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
        return { kind: 'decided', decision: await committer.commitSkipped({ workspaceId, companyId, executionId, contactId: target.contactId }, decision) };
      }
      const now = clock();
      const circuitState = await circuits.load('hunter');
      if (!circuitAllowsCall(circuitState, now)) {
        await recordAttempt({ workspaceId, contactId: target.contactId, providerKey: 'hunter', requestHash, outcome: 'error', errorCode: 'circuit_open', retryable: true, runId: record.businessRunId, accountKey: finder.account_key, attemptedAt: now });
        const decision = Object.freeze({ status: 'SAVE_PENDING' as const, contactId: target.contactId, reasonCode: 'RESULT_UNKNOWN' as const, state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
        return { kind: 'decided', decision: await committer.commitSkipped({ workspaceId, companyId, executionId, contactId: target.contactId }, decision) };
      }
      record = await load();
      const freshFinder = finderFor(record, contactSteps[0]!);
      bound = freshFinder.input_fingerprint === null || freshFinder.operation_key === null ? await bindStaticStep(freshFinder, record) : parseBoundEnrichmentStepRow(freshFinder);
      onFailure = async () => {
        await circuits.save('hunter', applyCircuitOutcome(circuitState, 'failure', now)).catch(() => undefined);
        await recordAttempt({ workspaceId, contactId: target.contactId, providerKey: 'hunter', requestHash, outcome: 'error', errorCode: 'provider_error', retryable: true, runId: record.businessRunId, accountKey: finder.account_key, attemptedAt: now }).catch(() => undefined);
      };
      onSuccess = async () => { await circuits.save('hunter', applyCircuitOutcome(circuitState, 'success', now)).catch(() => undefined); };
    } else {
      record = await load();
      const freshFinder = finderFor(record, contactSteps[0]!);
      if (freshFinder.input_fingerprint === null || freshFinder.operation_key === null || freshFinder.budget_operation_id === null) throw new EnrichmentSafetyError('HOLD');
      bound = parseBoundEnrichmentStepRow(freshFinder);
      paidHold = true;
    }
    try {
      await invoker.invoke(bound, trustedContext(workspaceId, companyId));
    } catch (error) {
      if (onFailure) await onFailure();
      if (paidHold) throw new EnrichmentSafetyError('HOLD');
      throw error;
    }
    if (onSuccess) await onSuccess();
    record = await load();
    const materializedFinder = finderFor(record, contactSteps[0]!);
    const materialized = await materializeForDomain(materializedFinder.id, { workspaceId, companyId });
    if (!materialized || materialized.phase !== 'FINDER') throw new EnrichmentSafetyError('HOLD');
    return { kind: 'materialized', materialized: materialized as FinderMaterialized };
  };
  const executeView = async (
    view: import('./enrichment-execution.repository').EnrichmentExecutionView,
    workspaceId: string,
    companyId: string,
    actorId: string,
    mode: "EXECUTE" | "RECOVER_NO_WIRE",
  ): Promise<import('../waterfall/enrich-company-contacts').EnrichCompanyContactsResult> => {
    const address = (contactId: string) => ({ workspaceId, companyId, executionId: view.executionId, contactId });
    const load = async (): Promise<LoadedRecord> => {
      const record = await query.loadById({ workspaceId, companyId }, view.executionId);
      if (!record || record.view.status === "REDACTED" || !record.plan) throw new EnrichmentSafetyError("HOLD");
      return record as LoadedRecord;
    };
    const decisionFor = (record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord, contactId: string) => {
      const snapshot = record.resultSnapshot;
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const contacts = (snapshot as { contacts?: unknown }).contacts;
      if (!Array.isArray(contacts)) return null;
      const found = contacts.find((entry) => entry !== null && typeof entry === 'object' && (entry as { contactId?: unknown }).contactId === contactId);
      return found === undefined ? null : parseEnrichmentContactApplyDecision(found);
    };
    const linkIndex = async (step: import('./enrichment-safety.contract').EnrichmentStepContextRow, reference: import('./enrichment-safety.contract').SettledEnrichmentStepReference) => {
      if (step.budget_operation_id === null) throw new EnrichmentSafetyError('HOLD');
      const current = (await load()).steps.find((candidate) => candidate.id === step.id);
      if (!current || current.budget_operation_id !== reference.durableReceipt.operationId) throw new EnrichmentSafetyError('HOLD');
      await prisma.withWorkspace(workspaceId, (tx) => linkEnrichmentStepSettled(tx, { workspaceId, executionId: view.executionId, stepId: step.id, expectedRevision: current.revision, operationId: current.budget_operation_id!, reference }));
    };
    const recoverSettledIndexes = async (current: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord, target: import('./enrichment-safety.contract').ContactTargetSnapshot) => {
      for (const step of current.steps.filter((candidate) => candidate.contact_id === target.contactId && candidate.dispatch_phase !== 'REDACTED' && hasOriginalTicket(candidate) && candidate.budget_status !== 'RELEASED' && !readyOriginalStep(candidate))) {
        if (step.budget_original_id === null) throw new EnrichmentSafetyError('HOLD');
        if (step.dispatch_phase === 'SETTLED' && step.domain_state !== 'APPLIED') throw new EnrichmentSafetyError('HOLD');
        if (step.phase === 'FINDER' && (step.dispatch_phase === 'RESULT_UNKNOWN' || step.budget_status === 'RESULT_UNKNOWN')) {
          if (step.budget_operation_id === null) throw new EnrichmentSafetyError('HOLD');
          const recovered = await reader.recoverEnrichmentStepResult(step.id, { workspaceId, companyId }, async () => true);
          if (recovered.status !== 'SETTLED') throw new EnrichmentSafetyError('HOLD');
          await linkIndex(step, recovered.reference);
          continue;
        }
        const read = await reader.loadEnrichmentStepResult(step.id, { workspaceId, companyId });
        if (read.status === 'SETTLED') { await linkIndex(step, read.reference); continue; }
        throw new EnrichmentSafetyError('HOLD');
      }
    };
    const voteFor = (row: import('./enrichment-safety.contract').EnrichmentStepContextRow, materialized: import('./enrichment-safety.contract').EnrichmentDomainMaterializedResult) => {
      if (materialized.phase === 'FINDER') throw new EnrichmentSafetyError('CONTROL_MISMATCH');
      if (materialized.phase === 'SMTP') {
        const mapped = mapSmtpProbeOutcome({ probe: materialized.result.data });
        return { providerKey: 'smtp_self', state: mapped.state, catchAllClass: mapped.catchAllClass, acceptAll: mapped.acceptAll };
      }
      const provider = row.provider;
      if (provider !== 'millionverifier' && provider !== 'emailable' && provider !== 'zerobounce') throw new EnrichmentSafetyError('CONTROL_MISMATCH');
      const restored = parseContactEmailVerificationResult(provider, materialized.result);
      return { providerKey: provider, state: restored.data.state, catchAllClass: restored.data.catchAllClass, acceptAll: restored.data.acceptAll };
    };
    const decisions = new Map<string, import('./enrichment-domain-commit').EnrichmentContactApplyDecision>();
    let record = await load();
    const commitSettled = async (contactId: string, preferredId?: string) => {
      const current = await load();
      const required = requiredOriginalStepIds(current, contactId);
      const rows = required.map((id) => current.steps.find((step) => step.id === id)!).filter(Boolean);
      if (rows.some((step) => !readyOriginalStep(step) && !closedOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
      return committer.commitContact({ workspaceId, companyId, executionId: view.executionId, contactId }, required.length > 0 ? required : (preferredId ? [preferredId] : []), actorId);
    };
    const runVerificationCluster = async (target: import('./enrichment-safety.contract').ContactTargetSnapshot, finderId: string): Promise<string[]> => {
      const executed: string[] = [finderId];
      const votes: Array<{ providerKey: string; state: import('../verification/verification-policy').ResolvedVerificationVotes['state']; catchAllClass: import('../verification/verification-policy').ResolvedVerificationVotes['catchAllClass']; acceptAll: boolean | null }> = [];
      let current = await load();
      const slots = current.steps.filter((step) => step.contact_id === target.contactId && step.phase !== 'FINDER' && step.dispatch_phase !== 'REDACTED');
      const runSlot = async (row: import('./enrichment-safety.contract').EnrichmentStepContextRow) => {
        try {
          current = await load();
          const step = current.steps.find((candidate) => candidate.id === row.id);
          if (!step) return null;
          if (!terminal(step)) {
            if (step.phase === 'SMTP') await invokeSmtpStep(step, current, trustedContext(workspaceId, companyId));
            else {
              const bound = step.input_fingerprint === null || step.operation_key === null ? await bindStaticStep(step, current) : parseBoundEnrichmentStepRow(step);
              await invoker.invoke(bound, trustedContext(workspaceId, companyId));
            }
          }
          const materialized = await materializeForDomain(row.id, { workspaceId, companyId });
          if (!materialized || materialized.phase === 'FINDER') return null;
          executed.push(row.id);
          const vote = voteFor(step, materialized);
          votes.push(vote);
          return vote;
        } catch { return null; }
      };
      const primary = slots[0];
      let stop = false;
      if (primary) { const vote = await runSlot(primary); if (!vote || vote.state !== 'VALID') stop = true; }
      const secondary = slots[1];
      if (!stop && secondary) {
        const vote = await runSlot(secondary);
        if (vote) {
          const resolved = resolveVerificationVotes(votes.map((entry) => ({ providerKey: entry.providerKey, state: entry.state, catchAllClass: entry.catchAllClass, acceptAll: entry.acceptAll })));
          if (!(resolved.state === 'VALID' || resolved.state === 'INVALID' || resolved.reason === 'accept_all_flag')) { const arbiter = slots[2]; if (arbiter) await runSlot(arbiter); }
        }
      }
      current = await load();
      return executed.filter((id) => { const step = current.steps.find((candidate) => candidate.id === id); return step !== undefined && terminal(step) && step.budget_original_id !== null; });
    };
    for (const target of record.plan.targets) {
      record = await load();
      const existing = decisionFor(record, target.contactId);
      if (existing) {
        const active = contactHasActiveOriginal(record, target.contactId);
        if (existing.status !== 'SAVE_PENDING' && !active) { decisions.set(target.contactId, existing); continue; }
        await recoverSettledIndexes(record, target);
        record = await load();
        if (existing.status !== 'SAVE_PENDING') throw new EnrichmentSafetyError('HOLD');
        const required = requiredOriginalStepIds(record, target.contactId);
        if (required.length === 0) throw new EnrichmentSafetyError('HOLD');
        const rows = required.map((id) => record.steps.find((step) => step.id === id)!).filter(Boolean);
        if (rows.some((step) => !readyOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
        if (rows.some((step) => closedOriginalStep(step)) && rows.some((step) => !closedOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
        decisions.set(target.contactId, await committer.commitContact(address(target.contactId), required, actorId));
        continue;
      }
      const contactSteps = record.steps.filter((step) => step.contact_id === target.contactId && step.dispatch_phase !== 'REDACTED');
      if (contactSteps.length === 0) continue;
      const finder = finderFor(record, contactSteps[0]!);
      if (mode === 'RECOVER_NO_WIRE') {
        await recoverSettledIndexes(record, target);
        record = await load();
        const required = requiredOriginalStepIds(record, target.contactId);
        if (required.length === 0) throw new EnrichmentSafetyError('HOLD');
        const rows = required.map((id) => record.steps.find((step) => step.id === id)!).filter(Boolean);
        if (rows.some((step) => !readyOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
        if (rows.some((step) => closedOriginalStep(step)) && rows.some((step) => !closedOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
        if (rows.every((step) => closedOriginalStep(step))) throw new EnrichmentSafetyError('HOLD');
        decisions.set(target.contactId, await committer.commitContact(address(target.contactId), required, actorId));
        continue;
      }
      let finderMaterialized: import('./enrichment-safety.contract').EnrichmentDomainMaterializedResult | null;
      if (terminal(finder)) {
        finderMaterialized = await materializeForDomain(finder.id, { workspaceId, companyId });
        if (!finderMaterialized || finderMaterialized.phase !== 'FINDER') throw new EnrichmentSafetyError('HOLD');
      } else {
        const outcome = await executeFinderTarget({ workspaceId, companyId, executionId: view.executionId, target, record, finder, contactSteps, load });
        if (outcome.kind === 'decided') { decisions.set(target.contactId, outcome.decision); continue; }
        finderMaterialized = outcome.materialized;
      }
      const finderResult = finderMaterialized.result;
      if (finderResult.status === 'miss') {
        decisions.set(target.contactId, await commitSettled(target.contactId, finder.id));
        continue;
      }
      await runVerificationCluster(target, finder.id);
      decisions.set(target.contactId, await commitSettled(target.contactId, finder.id));
    }
    await deps.store.finishAttempt?.({ workspaceId, companyId, executionId: view.executionId });
    record = await load();
    let charged = 0n;
    for (const step of record.steps) charged += step.budget_charged_microusd ?? 0n;
    if (charged > BigInt(Number.MAX_SAFE_INTEGER)) throw new EnrichmentSafetyError('HOLD');
    const targets = record.plan.targets;
    const results = targets.map((target) => {
      const decision = decisions.get(target.contactId) ?? decisionFor(record, target.contactId);
      const reasonCode = decision?.reasonCode ?? 'PENDING';
      if (reasonCode === 'STORED') return { contactId: target.contactId, status: 'stored' as const };
      if (reasonCode === 'INVALID_ALL') return { contactId: target.contactId, status: 'invalid_all' as const };
      if (reasonCode === 'NO_MATCH') return { contactId: target.contactId, status: 'not_found' as const };
      if (reasonCode === 'REUSED') return { contactId: target.contactId, status: 'reused' as const };
      if (reasonCode === 'DEADLINE') return { contactId: target.contactId, status: 'skipped_deadline' as const };
      if (reasonCode === 'BUDGET_CAP') return { contactId: target.contactId, status: 'skipped_company_cap' as const };
      return { contactId: target.contactId, status: 'skipped_compliance' as const, reason: reasonCode };
    });
    const attempted = targets.filter((target) => record.steps.some((step) => step.contact_id === target.contactId && step.phase === 'FINDER' && step.budget_original_id !== null) && decisions.get(target.contactId)?.reasonCode !== 'REUSED').length;
    return { companyId, tier: record.executionOptions?.tier ?? 'B', attempted, costMicrousd: Number(charged), deadlineHit: clock().getTime() >= record.plan.deadlineAtMs, results };
  };
  const bindStaticStep = async (
    row: import('./enrichment-safety.contract').EnrichmentStepContextRow,
    record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord,
  ): Promise<import('./enrichment-safety.contract').BoundEnrichmentStep> => {
    if (row.contact_id === null || row.account_key === null) throw new EnrichmentSafetyError("HOLD");
    const operationKey = paidOperationKey([row.account_key, "tool-budget", row.tool_id, row.tool_version, row.id]);
    if (row.phase === "FINDER") {
      const input = deps.loadTrustedInput ? await deps.loadTrustedInput(row.id, { workspaceId: row.workspace_id }) : null;
      if (!input?.finder) throw new EnrichmentSafetyError("HOLD");
      const inputVersion = enrichmentInputVersion(input.finder);
      return repository.bindStepInput({ workspaceId: row.workspace_id, companyId: row.company_id!, stepId: row.id, expectedRevision: row.revision, inputFingerprint: finderPhysicalInputFingerprint({ workspaceId: row.workspace_id, contactId: row.contact_id, inputVersion }), operationKey, candidateRef: null });
    }
    if (row.phase !== "VERIFY") throw new EnrichmentSafetyError("HOLD");
    const finderRow = finderFor(record, row);
    const finderInput = deps.loadTrustedInput ? await deps.loadTrustedInput(finderRow.id, { workspaceId: row.workspace_id }) : null;
    if (!finderInput?.finder || finderRow.budget_original_id === null || finderRow.budget_result_digest === null || finderRow.budget_result_json === null) throw new EnrichmentSafetyError("HOLD");
    const materialized = await materializeForDomain(finderRow.id, { workspaceId: row.workspace_id, companyId: row.company_id! });
    const email = materialized?.phase === "FINDER" ? materialized.result.email : null;
    if (!email) throw new EnrichmentSafetyError("HOLD");
    const candidateRef = { operationId: finderRow.budget_original_id, resultDigest: finderRow.budget_result_digest, artifactRef: parseArtifactReference(finderRow.budget_result_json) };
    const provider = row.provider;
    if (provider !== "millionverifier" && provider !== "emailable" && provider !== "zerobounce") throw new EnrichmentSafetyError("CONTROL_MISMATCH");
    const providerTimeoutSeconds = provider === "millionverifier" ? millionVerifierTimeoutSeconds(deps.env ?? process.env) : null;
    return repository.bindStepInput({ workspaceId: row.workspace_id, companyId: row.company_id!, stepId: row.id, expectedRevision: row.revision,
      inputFingerprint: verificationPhysicalInputFingerprint({ workspaceId: row.workspace_id, contactId: row.contact_id, provider, email, providerTimeoutSeconds }), operationKey, candidateRef });
  };
  const invokeSmtpStep = async (
    row: import('./enrichment-safety.contract').EnrichmentStepContextRow,
    record: import('./enrichment-safety.contract').EnrichmentRuntimeExecutionRecord,
    context: { workspaceId: string; companyId: string; authorizeExternalAction: () => Promise<boolean> },
  ): Promise<void> => {
    if (row.contact_id === null || row.account_key === null) throw new EnrichmentSafetyError("HOLD");
    const finderRow = finderFor(record, row);
    const materialized = await materializeForDomain(finderRow.id, { workspaceId: row.workspace_id, companyId: row.company_id! });
    const email = materialized?.phase === "FINDER" ? materialized.result.email : null;
    if (!email || finderRow.budget_original_id === null || finderRow.budget_result_digest === null || finderRow.budget_result_json === null) throw new EnrichmentSafetyError("HOLD");
    const candidateRef = { operationId: finderRow.budget_original_id, resultDigest: finderRow.budget_result_digest, artifactRef: parseArtifactReference(finderRow.budget_result_json) };
    const proxy: ExecutionBroker = {
      checkSourcePolicy: (toolId, domain, purpose) => deps.broker.checkSourcePolicy(toolId, domain, purpose),
      invoke: async <I, O>(toolId: string, input: I, caller: import('../../tools/tool-contract').ToolContext): Promise<import('../../tools/tool-contract').ToolResult<O>> => {
        if (toolId !== "smtp.rcpt_probe") throw new EnrichmentSafetyError("CONTROL_MISMATCH");
        const native = input as import('../../tools/builtin-tools').SmtpProbeInput;
        const current = await loadStepRow(prisma, row.workspace_id, row.company_id!, row.id);
        const bound = current.input_fingerprint !== null && current.operation_key !== null
          ? parseBoundEnrichmentStepRow(current)
          : await repository.bindStepInput({ workspaceId: row.workspace_id, companyId: row.company_id!, stepId: row.id, expectedRevision: current.revision,
              inputFingerprint: smtpPhysicalInputFingerprint({ workspaceId: row.workspace_id, contactId: row.contact_id!, originalInput: native }), operationKey: originalSmtpBudgetOperationKey(row.account_key!, native, row.tool_version), candidateRef });
        return invoker.createStepBoundSmtpBroker(bound, context).invoke<I, O>(toolId, input, caller);
      },
    };
    const provider = new SmtpProbeProvider(proxy, { config: { enabled: true }, resolveMxHost: (domain: string) => resolveMx(domain) });
    await provider.verify({ email, workspaceId: row.workspace_id, runId: row.account_key, authorizeExternalAction: context.authorizeExternalAction });
  };
  const execution: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyServiceDeps["execution"] = {
    findRun: async ({ workspaceId, companyId, businessRunId }) => {
      const record = await query.loadByRun({ workspaceId, companyId }, businessRunId);
      return record ? { view: record.view, workspaceId, companyId, businessRunId, accountKey: record.accountKey, admissionRequestSha256: record.admissionRequestSha256 } : null;
    },
    findByRef: async ({ workspaceId, companyId, operationRef }) => {
      const record = await query.loadByRef({ workspaceId, companyId }, operationRef);
      return record ? { view: record.view, workspaceId, companyId, businessRunId: record.businessRunId, accountKey: record.accountKey, admissionRequestSha256: record.admissionRequestSha256 } : null;
    },
    execute: ({ view, workspaceId, companyId, actorId, mode }) => executeView(view, workspaceId, companyId, actorId, mode),
  };
  const resultsAdapters: ContactEnrichmentResultsAdapterDeps = {
    database: prisma,
    loadById: (scope, id) => query.loadById(scope, id),
    loadByRef: (scope, operationRef) => query.loadByRef(scope, operationRef),
  };
  const service = new ContactEnrichmentSafetyService({
    authority: deps.authority,
    repository,
    prepare: deps.prepare,
    execution,
    results: {
      listEnrichmentExecutions: (context, companyId, parsed) =>
        listContactEnrichmentResults(resultsAdapters, context, companyId, parsed),
      readEnrichmentExecution: (context, companyId, operationRef) =>
        readContactEnrichmentResult(resultsAdapters, context, companyId, operationRef),
      listEnrichmentQualityFacts: (context, companyId, parsed) =>
        listContactEnrichmentQualityFacts(resultsAdapters, context, companyId, parsed),
      readEnrichmentQualityFacts: (context, companyId, operationRef) =>
        readContactEnrichmentQualityFacts(resultsAdapters, context, companyId, operationRef),
    },
    authorizeRecovery: deps.authorizeRecovery,
  });
  return { service, repository, query };
}

export interface ManagedContactEnrichmentSafety {
  readonly broker: ExecutionBroker;
  readonly service?: import('./contact-enrichment-safety.service').ContactEnrichmentSafetyService;
  readonly unavailableReason?: string;
}
type SafetyResultsPort = Pick<import('./contact-enrichment-safety.service').ContactEnrichmentSafetyService,
  'executeHttp' | 'executeRun' | 'listEnrichmentExecutions' | 'readEnrichmentExecution' | 'recoverEnrichmentExecution' | 'listEnrichmentQualityFacts' | 'readEnrichmentQualityFacts'>;
/** Explicit fail-closed executor: no Grant verify/consume, no broker, no legacy lane. */
export function createFailClosedSafetyExecutor(reasonCode: string): SafetyResultsPort {
  const notAdmitted = (companyId: string) => ({ companyId, tier: 'B' as const, attempted: 0, costMicrousd: 0, deadlineHit: false, results: [], admission: 'NOT_ADMITTED' as const, reasonCode, qualityCoverage: 'PREREQUISITE_ONLY' as const });
  return {
    executeHttp: async (_context, companyId) => notAdmitted(companyId),
    executeRun: async (input) => notAdmitted(input.companyId),
    listEnrichmentExecutions: async () => ({ items: [], nextCursor: null, hasMore: false }),
    readEnrichmentExecution: async () => null,
    recoverEnrichmentExecution: async () => null,
    listEnrichmentQualityFacts: async () => ({ items: [], nextCursor: null, hasMore: false }),
    readEnrichmentQualityFacts: async () => null,
  };
}
/** One shared construction used by both the API module and the real worker composition root. */
export async function createManagedContactEnrichmentSafety(input: {
  prisma: ContactEnrichmentPreparationDeps['prisma'] & import('../../prisma/prisma.service').PrismaService;
  env?: NodeJS.ProcessEnv;
  budgetStore: BudgetStore;
  authority: ContactEnrichmentSafetyRuntimeDeps['authority'];
  grantConsumer: ContactEnrichmentSafetyRuntimeDeps['grantConsumer'];
  buildBroker: (ports?: ContactEnrichmentSafetyToolDeps) => ExecutionBroker;
}): Promise<ManagedContactEnrichmentSafety> {
  const env = input.env ?? process.env;
  const prisma = input.prisma;
  let ports: ContactEnrichmentSafetyToolDeps | undefined;
  let artifacts: GenericOperationArtifactService | undefined;
  try {
    if (genericArtifactStorageConfig(env)) {
      artifacts = new GenericOperationArtifactService(new GenericOperationArtifactRepository(prisma), sharedGenericOperationArtifactStore(genericArtifactStorageConfig(env)), input.budgetStore);
    }
    const providerStates = {} as Record<ControlledEnrichmentProvider, ControlledEnrichmentProviderState>;
    for (const provider of ['hunter', 'millionverifier', 'emailable', 'zerobounce'] as const) providerStates[provider] = await loadControlledEnrichmentProviderState(prisma, env, provider);
    const originals = new EnrichmentOriginalResultRepository(prisma);
    const reader = new EnrichmentResultReader({
      loadBinding: (stepId, context) => originals.loadBinding(stepId, context),
      budgets: input.budgetStore,
      projections: registerSourceResultProjections(registerContactEmailVerificationProjections(new TypedProjectionRegistry())),
      ...(artifacts ? { artifacts } : {}),
      finderMaterializer: contactEmailFindMaterializer,
    });
    const loadWire = async (stepId: string, workspaceId: string, deriveOnly = false): Promise<ControlledEnrichmentWireInput> => {
      const row = await loadStepRowByStep(prisma, workspaceId, stepId);
      if (deriveOnly && row.phase === 'FINDER') {
        const contact = await prisma.withWorkspace(workspaceId, (tx) => tx.canonicalContact.findFirst({ where: { id: row.contact_id!, companyId: row.company_id! }, select: { fullName: true, company: { select: { name: true, domain: true } } } }));
        if (!contact || !contact.company?.domain) throw new EnrichmentSafetyError('HOLD');
        return { step: row as unknown as import('./enrichment-safety.contract').BoundEnrichmentStep, finder: { fullName: contact.fullName, domain: contact.company.domain, companyName: contact.company.name }, verification: null };
      }
      const step = parseBoundEnrichmentStepRow(row);
      if (step.phase === 'FINDER') {
        const contact = await prisma.withWorkspace(workspaceId, (tx) => tx.canonicalContact.findFirst({ where: { id: step.contactId, companyId: step.companyId }, select: { fullName: true, company: { select: { name: true, domain: true } } } }));
        if (!contact || !contact.company?.domain) throw new EnrichmentSafetyError('HOLD');
        return { step, finder: { fullName: contact.fullName, domain: contact.company.domain, companyName: contact.company.name }, verification: null };
      }
      const finders = await prisma.withWorkspace(workspaceId, async (tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM public.contact_enrichment_execution_step WHERE workspace_id=${workspaceId}::uuid AND execution_id=${step.executionId}::uuid AND contact_id=${step.contactId}::uuid AND phase='FINDER'`);
      if (finders.length !== 1 || !finders[0]) throw new EnrichmentSafetyError('HOLD');
      const materialized = await reader.materializeForDomain(finders[0].id, { workspaceId, companyId: step.companyId });
      if (!materialized || materialized.phase !== 'FINDER' || !materialized.result.email) throw new EnrichmentSafetyError('HOLD');
      const email = materialized.result.email;
      return { step, finder: null, verification: { email, domain: email.slice(email.lastIndexOf('@') + 1), providerTimeoutSeconds: step.provider === 'millionverifier' ? millionVerifierTimeoutSeconds(env) : null } };
    };
    ports = {
      providers: providerStates,
      currentProvider: (provider) => loadControlledEnrichmentProviderState(prisma, env, provider),
      loadTrustedInput: (stepId, context, deriveOnly) => loadWire(stepId, context.workspaceId, deriveOnly),
    };
  } catch {
    ports = undefined;
    artifacts = undefined;
  }
  let broker: ExecutionBroker;
  try {
    broker = input.buildBroker(ports);
  } catch {
    return { broker: input.buildBroker(undefined), unavailableReason: 'GOVERNANCE_PENDING' };
  }
  if (!ports || !artifacts) return { broker, unavailableReason: 'ARTIFACT_UNAVAILABLE' };
  try {
    const runtime = createContactEnrichmentSafetyRuntime({
      prisma,
      authority: input.authority,
      broker,
      grantConsumer: input.grantConsumer,
      guards: createSqlEnrichmentStepGuards(prisma, env),
      store: createSqlEnrichmentDomainCommitStore(prisma, env),
      artifacts,
      finderMaterializer: contactEmailFindMaterializer,
      budgets: input.budgetStore,
      loadTrustedInput: (stepId, context) => ports!.loadTrustedInput(stepId, { workspaceId: context.workspaceId, runId: 'safety', purpose: 'enrichment', authorizeExternalAction: async () => true, artifactSubject: { subjectType: 'contact', subjectId: '00000000-0000-4000-8000-000000000000' } }, true),
      prepare: createContactEnrichmentSafetyPreparer({ prisma, env, broker }),
      authorizeRecovery: async (context, companyId) => prisma.withWorkspace(context.workspaceId, async (tx) => {
        const company = await tx.canonicalCompany.findUnique({ where: { id: companyId }, select: { status: true } });
        if (!company || company.status === 'SUPPRESSED') return false;
        const contact = await tx.canonicalContact.findFirst({ where: { companyId }, select: { id: true } });
        return contact ? contactMayUseExternalProcessing(tx, { workspaceId: context.workspaceId, contactId: contact.id }) : false;
      }),
      env,
    });
    return { broker, service: runtime.service };
  } catch {
    return { broker, unavailableReason: 'GOVERNANCE_PENDING' };
  }
}
export async function createWorkerContactEnrichmentSafety(input: {
  prisma: ContactEnrichmentPreparationDeps['prisma'] & import('../../prisma/prisma.service').PrismaService;
  budgetStore: BudgetStore;
  costLedger: unknown;
  sourcePolicyReader: ReturnType<typeof import('../../tools/tool-broker.factory').sourcePolicyReaderFrom>;
}): Promise<ManagedContactEnrichmentSafety> {
  return createManagedContactEnrichmentSafety({
    prisma: input.prisma,
    env: process.env,
    budgetStore: input.budgetStore,
    authority: { verifyWorkspaceGrant: async () => { throw new Error('WORKER_HTTP_GRANT_UNAVAILABLE'); } },
    grantConsumer: { consumeVerifiedWorkspaceGrantInTransaction: async () => { throw new Error('WORKER_HTTP_GRANT_UNAVAILABLE'); } },
    buildBroker: (ports) => buildToolBroker({ sourcePolicyReader: input.sourcePolicyReader, paidLedger: input.costLedger as never, budgetStore: input.budgetStore, prisma: input.prisma, ...(ports ? { contactEnrichment: ports } : {}) }),
  });
}
async function loadStepRowByStep(transactions: ContactEnrichmentPreparationDeps['prisma'], workspaceId: string, stepId: string): Promise<import('./enrichment-safety.contract').EnrichmentRuntimeStepRow> {
  return transactions.withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<import('./enrichment-safety.contract').EnrichmentRuntimeStepRow[]>`SELECT s.id::text,s.workspace_id::text,s.execution_id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,s.quote_microusd,s.pricing_version,s.depends_on_slot_key,
      s.input_fingerprint,s.operation_key,s.budget_operation_id::text,s.candidate_ref,s.revision,s.dispatch_phase,s.domain_state,
      e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.status AS execution_status,
      ((e.frozen_limits->>'deadlineAtMs')::bigint>floor(extract(epoch FROM statement_timestamp())*1000)) AS deadline_open,
      o.id::text AS budget_original_id,o.status::text AS budget_status,o.amount_unit AS budget_amount_unit,o.reserved_microusd AS budget_reserved_microusd,o.charged_microusd AS budget_charged_microusd,
      o.result_schema AS budget_result_schema,o.result_digest AS budget_result_digest,o.result_json AS budget_result_json,o.receipt_usage AS budget_receipt_usage,o.receipt_cost_basis AS budget_receipt_cost_basis
      FROM public.contact_enrichment_execution_step s JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
      JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
      LEFT JOIN public.tool_budget_operation o ON o.scope_key=e.workspace_id::text AND o.account_id=e.account_id AND o.generation=e.generation AND o.operation_key=s.operation_key
      WHERE s.workspace_id=${workspaceId}::uuid AND s.id=${stepId}::uuid`;
    if (rows.length !== 1 || !rows[0]) throw new EnrichmentSafetyError('HOLD');
    return rows[0];
  });
}
async function loadStepRow(transactions: ContactEnrichmentPreparationDeps['prisma'], workspaceId: string, companyId: string, stepId: string): Promise<import('./enrichment-safety.contract').EnrichmentRuntimeStepRow> {
  return transactions.withWorkspace(workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<import('./enrichment-safety.contract').EnrichmentRuntimeStepRow[]>`SELECT s.id::text,s.workspace_id::text,s.execution_id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,s.quote_microusd,s.pricing_version,s.depends_on_slot_key,
      s.input_fingerprint,s.operation_key,s.budget_operation_id::text,s.candidate_ref,s.revision,s.dispatch_phase,s.domain_state,
      e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.status AS execution_status,
      ((e.frozen_limits->>'deadlineAtMs')::bigint>floor(extract(epoch FROM statement_timestamp())*1000)) AS deadline_open,
      o.id::text AS budget_original_id,o.status::text AS budget_status,o.amount_unit AS budget_amount_unit,o.reserved_microusd AS budget_reserved_microusd,o.charged_microusd AS budget_charged_microusd,
      o.result_schema AS budget_result_schema,o.result_digest AS budget_result_digest,o.result_json AS budget_result_json,o.receipt_usage AS budget_receipt_usage,o.receipt_cost_basis AS budget_receipt_cost_basis
      FROM public.contact_enrichment_execution_step s JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
      JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
      LEFT JOIN public.tool_budget_operation o ON o.scope_key=e.workspace_id::text AND o.account_id=e.account_id AND o.generation=e.generation AND o.operation_key=s.operation_key
      WHERE s.workspace_id=${workspaceId}::uuid AND e.company_id=${companyId}::uuid AND s.id=${stepId}::uuid`;
    if (rows.length !== 1 || !rows[0]) throw new EnrichmentSafetyError("HOLD");
    return rows[0];
  });
}
function millionVerifierTimeoutSeconds(env: NodeJS.ProcessEnv): number {
  const config = resolveMillionVerifierConfig(env);
  return Math.max(1, Math.min(30, Math.floor(config.timeoutMs / 1000)));
}

function buildLedgerReference(row: {
  id: string; phase: string; provider: string; tool_id: string; operation_key: string | null; budget_original_id: string | null;
  budget_result_schema: string | null; budget_result_digest: string | null; budget_result_json: unknown; budget_receipt_usage: unknown; budget_receipt_cost_basis: string | null;
}, head: { workspace_id: string; account_id: string; authority_id: string }): import('./enrichment-safety.contract').SettledEnrichmentStepReference | null {
  try {
    if (row.budget_original_id === null || row.operation_key === null) return null;
    const schema = row.phase === 'FINDER' ? 'contact-email-find-hunter/v1' : row.phase === 'SMTP' ? 'smtp-probe-verdict/v1' : 'contact-email-verify-' + row.provider + '/v1';
    const common = { scopeKey: head.workspace_id, operationId: row.budget_original_id, operationKey: row.operation_key, accountId: head.account_id, authorityId: head.authority_id,
      resultSchema: row.budget_result_schema, resultDigest: row.budget_result_digest, resultJson: row.budget_result_json, receiptUsage: row.budget_receipt_usage, receiptCostBasis: row.budget_receipt_cost_basis };
    let receipt;
    if (row.phase === 'FINDER') {
      const reference = parseArtifactReference(row.budget_result_json);
      receipt = durableReceiptFromLedgerRow({ ...common, resultSchemaVersion: 'generic-operation-artifact-ref/v1' }) ?? null;
      if (!receipt || reference.sha256 !== receipt.resultDigest) return null;
    } else {
      const projection = parseGenericOperationProjection(row.budget_result_json);
      receipt = requireLedgerProjectionReceipt({ ...common, expectedOperationId: row.budget_original_id, resultSchemaVersion: 'generic-operation-projection/v1', expectedProjection: projection });
    }
    if (receipt.resultSchema !== schema || receipt.resultStrategy !== (row.phase === 'FINDER' ? 'artifact_reference' : 'typed_projection')) return null;
    return { stepId: row.id, producerId: row.tool_id, resultSchema: schema, resultDigest: receipt.resultDigest, durableReceipt: receipt };
  } catch {
    return null;
  }
}

/** SQL/current-policy guard port for the step claim; real PG validation remains the original E gate. */
export function createSqlEnrichmentStepGuards(client: PrismaClient, env: NodeJS.ProcessEnv): import('./enrichment-execution.repository').EnrichmentStepGuards {
  return {
    assertCurrentSubjectAndPolicy: async (tx, row) => {
      if (row.contact_id === null) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
      if (!(await contactMayUseExternalProcessing(tx, { workspaceId: row.workspace_id, contactId: row.contact_id }))) throw new EnrichmentSafetyError('HOLD');
      if (row.phase === 'SMTP') return { pricingVersion: row.pricing_version };
      if (!(['hunter', 'millionverifier', 'emailable', 'zerobounce'] as readonly string[]).includes(row.provider)) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
      const state = await loadControlledEnrichmentProviderState(client, env, row.provider as ControlledEnrichmentProvider);
      if (!state.enabled || !state.policyAllowed || !state.apiKey || state.pricingVersion !== row.pricing_version) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
      return { pricingVersion: state.pricingVersion };
    },
    assertCandidateOrigin: async (tx, row, candidate) => {
      const rows = await tx.$queryRaw<Array<{ status: string; amount_unit: string; result_schema: string | null; result_digest: string | null; scope_key: string; account_id: string; generation: number; step_contact_id: string | null; step_execution_id: string; step_contact_ordinal: number; step_phase: string; execution_company_id: string | null }>>`SELECT o.status::text AS status,o.amount_unit,o.result_schema,o.result_digest,o.scope_key,o.account_id::text AS account_id,o.generation,
          s.contact_id::text AS step_contact_id,s.execution_id::text AS step_execution_id,s.contact_ordinal AS step_contact_ordinal,s.phase::text AS step_phase,e.company_id::text AS execution_company_id
        FROM public.tool_budget_operation o
        JOIN public.contact_enrichment_execution_step s ON s.workspace_id::text=o.scope_key AND s.budget_operation_id=o.id
        JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
        WHERE o.scope_key=${row.workspace_id} AND o.account_id=${row.account_id}::uuid AND o.generation=${row.generation} AND o.id=${candidate.operationId}::uuid`;
      const operation = rows[0];
      if (rows.length !== 1 || !operation || operation.status !== 'SETTLED' || operation.amount_unit !== 'microusd' ||
          operation.result_schema !== 'contact-email-find-hunter/v1' || operation.result_digest !== candidate.resultDigest ||
          operation.scope_key !== row.workspace_id || operation.account_id !== row.account_id || operation.generation !== row.generation ||
          operation.step_contact_id !== row.contact_id || operation.step_execution_id !== row.execution_id ||
          operation.step_contact_ordinal !== row.contact_ordinal || operation.step_phase !== 'FINDER' ||
          operation.execution_company_id !== row.company_id || candidate.artifactRef.operationId !== candidate.operationId) throw new EnrichmentSafetyError('CONTROL_MISMATCH');
    },
  };
}

/** Parameterized SQL store for the domain-commit port; real PG/RLS/immutability remains the original E gate. */
export function createSqlEnrichmentDomainCommitStore(transactions: ContactEnrichmentPreparationDeps['prisma'], env: NodeJS.ProcessEnv): import('./enrichment-domain-commit').EnrichmentDomainCommitStore {
  void env;
  const readDecision = (snapshot: unknown, contactId: string) => {
    if (snapshot === null || typeof snapshot !== 'object') return null;
    const contacts = (snapshot as { contacts?: unknown }).contacts;
    if (!Array.isArray(contacts)) return null;
    const found = contacts.find((entry) => entry !== null && typeof entry === 'object' && (entry as { contactId?: unknown }).contactId === contactId);
    return found === undefined ? null : parseEnrichmentContactApplyDecision(found);
  };
  const loadOriginalFacts = async (tx: import('@prisma/client').Prisma.TransactionClient, address: import('./enrichment-domain-commit').EnrichmentContactCommitAddress) =>
    tx.$queryRaw<Array<{ step_id: string; operation_id: string | null; operation_status: string | null; dispatch_phase: string; domain_state: string }>>`SELECT s.id::text AS step_id,o.id::text AS operation_id,o.status::text AS operation_status,s.dispatch_phase,s.domain_state
      FROM public.contact_enrichment_execution_step s
      LEFT JOIN public.tool_budget_operation o ON o.scope_key=s.workspace_id::text AND o.operation_key=s.operation_key AND o.account_id=(SELECT e.account_id FROM public.contact_enrichment_execution e WHERE e.workspace_id=s.workspace_id AND e.id=s.execution_id) AND o.generation=(SELECT e.generation FROM public.contact_enrichment_execution e WHERE e.workspace_id=s.workspace_id AND e.id=s.execution_id)
      WHERE s.workspace_id=${address.workspaceId}::uuid AND s.execution_id=${address.executionId}::uuid AND s.contact_id=${address.contactId}::uuid`;
  const factsCoherent = (facts: readonly { operationId: string | null; status: string | null; dispatchPhase: string; domainState: string }[]) =>
    !facts.some((fact) => fact.operationId !== null && fact.status !== 'RELEASED' &&
      !(fact.status === 'SETTLED' && (fact.dispatchPhase === 'SETTLED' || fact.dispatchPhase === 'SETTLED_WAITING_APPLY') && fact.domainState === 'APPLIED'));
  type HeadFact = { contact_id: string | null; dispatch_phase: string; domain_state: string; operation_id: string | null; operation_status: string | null };
  const aggregateHeadStatus = (parsed: readonly import('./enrichment-domain-commit').EnrichmentContactApplyDecision[], facts: readonly HeadFact[], remaining: number, targetCount: number, pendingSignal = false): string => {
    const activePaid = facts.some((fact) => fact.operation_id !== null && fact.operation_status !== 'RELEASED' &&
      !(fact.operation_status === 'SETTLED' && (fact.dispatch_phase === 'SETTLED' || fact.dispatch_phase === 'SETTLED_WAITING_APPLY') && fact.domain_state === 'APPLIED'));
    const releasedWithoutObligation = (fact: HeadFact) => fact.dispatch_phase === 'RELEASED' && (fact.operation_id === null || fact.operation_status === 'RELEASED');
    const genuinePending = parsed.some((entry) => entry.status === 'SAVE_PENDING') || activePaid ||
      facts.some((fact) => fact.domain_state === 'SAVE_PENDING' && !releasedWithoutObligation(fact));
    const closed = parsed.length === targetCount && parsed.every((entry) => entry.status === 'APPLIED' || entry.status === 'REPLAYED') && !activePaid && !pendingSignal;
    if (closed) return 'COMPLETED';
    if (genuinePending || pendingSignal) return 'APPLY_PENDING';
    if (remaining > 0) return 'RUNNING';
    return parsed.length === targetCount ? 'APPLY_PENDING' : 'RUNNING';
  };
  const readHeadFacts = async (tx: import('@prisma/client').Prisma.TransactionClient, address: { workspaceId: string; executionId: string }) =>
    tx.$queryRaw<HeadFact[]>`SELECT s.contact_id::text,s.domain_state,s.dispatch_phase,o.id::text AS operation_id,o.status::text AS operation_status
      FROM public.contact_enrichment_execution_step s
      LEFT JOIN public.tool_budget_operation o ON o.scope_key=s.workspace_id::text AND o.operation_key=s.operation_key AND o.account_id=(SELECT e.account_id FROM public.contact_enrichment_execution e WHERE e.workspace_id=s.workspace_id AND e.id=s.execution_id) AND o.generation=(SELECT e.generation FROM public.contact_enrichment_execution e WHERE e.workspace_id=s.workspace_id AND e.id=s.execution_id)
      WHERE s.workspace_id=${address.workspaceId}::uuid AND s.execution_id=${address.executionId}::uuid`;
  return {
    readCommitted: async (tx, address) => {
      const rows = await tx.$queryRaw<{ result_snapshot: unknown }[]>`SELECT result_snapshot FROM public.contact_enrichment_execution WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid`;
      const decision = rows.length === 1 ? readDecision(rows[0]?.result_snapshot, address.contactId) : null;
      if (!decision || decision.status === 'SAVE_PENDING') return decision;
      const facts = await loadOriginalFacts(tx, address);
      return factsCoherent(facts.map((fact) => ({ operationId: fact.operation_id, status: fact.operation_status, dispatchPhase: fact.dispatch_phase, domainState: fact.domain_state }))) ? decision : null;
    },
    lockAndLoad: async (tx, address) => {
      const initialHeads = await tx.$queryRaw<Array<{ id: string; workspace_id: string; company_id: string | null; authority_id: string; account_id: string; generation: number; account_key: string }>>`SELECT e.id::text,e.workspace_id::text,e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key
        FROM public.contact_enrichment_execution e JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
        WHERE e.workspace_id=${address.workspaceId}::uuid AND e.id=${address.executionId}::uuid AND e.company_id=${address.companyId}::uuid`;
      if (initialHeads.length !== 1 || !initialHeads[0]) return null;
      const initialHead = initialHeads[0];
      const lockedAccounts = await tx.$queryRaw<Array<{ account_id: string; authority_id: string; generation: number }>>`SELECT account_id,authority_id,generation
        FROM public.lock_contact_enrichment_account_v1(${address.workspaceId}::uuid, ${initialHead.authority_id}::uuid, ${initialHead.account_key})`;
      if (lockedAccounts.length !== 1 || !lockedAccounts[0] ||
          lockedAccounts[0].account_id !== initialHead.account_id ||
          lockedAccounts[0].authority_id !== initialHead.authority_id ||
          lockedAccounts[0].generation !== initialHead.generation) return null;
      const heads = await tx.$queryRaw<Array<{ id: string; workspace_id: string; company_id: string | null; authority_id: string; account_id: string; generation: number; account_key: string; entrypoint: string; business_run_id: string | null; status: string; frozen_limits: unknown; target_snapshot: unknown; result_snapshot: unknown }>>`SELECT e.id::text,e.workspace_id::text,e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.entrypoint,e.business_run_id::text,e.status,e.frozen_limits,e.target_snapshot,e.result_snapshot
        FROM public.contact_enrichment_execution e JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
        WHERE e.workspace_id=${address.workspaceId}::uuid AND e.id=${address.executionId}::uuid AND e.company_id=${address.companyId}::uuid FOR UPDATE OF e`;
      if (heads.length !== 1 || !heads[0]) return null;
      const head = heads[0];
      if (head.workspace_id !== initialHead.workspace_id || head.company_id !== initialHead.company_id ||
          head.account_id !== initialHead.account_id || head.authority_id !== initialHead.authority_id ||
          head.generation !== initialHead.generation) return null;
      if (head.company_id !== address.companyId || head.status === 'REDACTED') return null;
      const limits = head.frozen_limits as { executionOptions?: { lawfulBasisKind?: string } } | null;
      const lockedContacts = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM public.canonical_contact WHERE id=${address.contactId}::uuid FOR UPDATE`;
      if (lockedContacts.length !== 1) return null;
      const contact = await tx.canonicalContact.findUnique({ where: { id: address.contactId }, select: { id: true, fullName: true, companyId: true, company: { select: { name: true, domain: true } } } });
      const domain = contact?.company?.domain ?? null;
      if (!contact || contact.companyId !== address.companyId || !domain) return null;
      const lockedPoints = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM public.contact_point WHERE workspace_id=${address.workspaceId}::uuid AND contact_id=${address.contactId}::uuid ORDER BY id FOR UPDATE`;
      const pointRows = lockedPoints.length === 0 ? [] : await tx.contactPoint.findMany({ where: { workspaceId: address.workspaceId, contactId: address.contactId }, select: { ...ENRICHMENT_POINT_BEFORE_SELECT, emailType: true }, orderBy: { id: 'asc' } });
      const stepRows = await tx.$queryRaw<Array<{ id: string; contact_id: string | null; contact_ordinal: number; slot_key: string; phase: string; provider: string; tool_id: string; tool_version: string; pricing_version: string; depends_on_slot_key: string | null; quote_microusd: bigint; dispatch_phase: string; domain_state: string; budget_operation_id: string | null; input_fingerprint: string | null; operation_key: string | null; candidate_ref: unknown; revision: number; budget_original_id: string | null; budget_status: string | null; budget_amount_unit: string | null; budget_reserved_microusd: bigint | null; budget_result_schema_version: string | null; budget_result_schema: string | null; budget_result_digest: string | null; budget_result_json: unknown; budget_receipt_usage: unknown; budget_receipt_cost_basis: string | null }>>`SELECT s.id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,s.pricing_version,s.depends_on_slot_key,s.quote_microusd,s.dispatch_phase,s.domain_state,s.budget_operation_id::text,s.input_fingerprint,s.operation_key,s.candidate_ref,s.revision,
        o.id::text AS budget_original_id,o.status::text AS budget_status,o.amount_unit AS budget_amount_unit,o.reserved_microusd AS budget_reserved_microusd,o.result_schema_version AS budget_result_schema_version,o.result_schema AS budget_result_schema,o.result_digest AS budget_result_digest,o.result_json AS budget_result_json,o.receipt_usage AS budget_receipt_usage,o.receipt_cost_basis AS budget_receipt_cost_basis
        FROM public.contact_enrichment_execution_step s LEFT JOIN public.tool_budget_operation o ON o.scope_key=s.workspace_id::text AND o.account_id=(SELECT e2.account_id FROM public.contact_enrichment_execution e2 WHERE e2.workspace_id=s.workspace_id AND e2.id=s.execution_id) AND o.generation=(SELECT e2.generation FROM public.contact_enrichment_execution e2 WHERE e2.workspace_id=s.workspace_id AND e2.id=s.execution_id) AND o.operation_key=s.operation_key
        WHERE s.workspace_id=${address.workspaceId}::uuid AND s.execution_id=${address.executionId}::uuid AND s.contact_id=${address.contactId}::uuid FOR UPDATE OF s`;
      const pending = await tx.$queryRaw<Array<{ operation_id: string }>>`SELECT o.id::text AS operation_id FROM public.tool_budget_operation o
        WHERE o.scope_key=${address.workspaceId}::text AND o.status IN ('RESERVED','RESULT_UNKNOWN') AND EXISTS (
          SELECT 1 FROM public.contact_enrichment_execution_step s JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
          WHERE s.workspace_id=${address.workspaceId}::uuid AND s.contact_id=${address.contactId}::uuid AND e.id<>${address.executionId}::uuid AND s.budget_operation_id=o.id)`;
      const target = (Array.isArray(head.target_snapshot) ? head.target_snapshot : []).find((entry) => (entry as { contactId?: unknown }).contactId === address.contactId) as import('./enrichment-safety.contract').ContactTargetSnapshot | undefined;
      if (!target) return null;
      const references = stepRows
        .filter((step) => step.budget_original_id !== null)
        .map((step) => {
          const reference = buildLedgerReference({ ...step, id: step.id }, head);
          if (!reference) return null;
          const boundRow = { ...step, workspace_id: head.workspace_id, execution_id: head.id, company_id: head.company_id, contact_id: step.contact_id, authority_id: head.authority_id, account_id: head.account_id, generation: head.generation, account_key: head.account_key, execution_status: head.status, deadline_open: false };
          return { step: parseBoundEnrichmentStepRow(boundRow as never), reference };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);
      return {
        workspaceId: address.workspaceId, companyId: address.companyId, executionId: address.executionId, contactId: address.contactId,
        authorityId: head.authority_id, accountId: head.account_id, generation: head.generation, businessRunId: head.business_run_id,
        target,
        currentInput: { fullName: contact.fullName, domain, companyName: contact.company?.name ?? '' },
        currentPoints: pointRows.map(pointBeforeSnapshot),
        qualityPoints: pointRows.map((point) => ({ id: point.id, type: point.type, emailType: point.emailType ?? null, verificationState: point.verificationState })),
        originalReferences: references,
        originalFacts: stepRows.map((step) => ({ stepId: step.id, operationId: step.budget_original_id, status: step.budget_status, dispatchPhase: step.dispatch_phase, domainState: step.domain_state })),
        committed: readDecision(head.result_snapshot, address.contactId),
        redacted: false,
        lawfulBasis: { basis: (limits?.executionOptions?.lawfulBasisKind ?? 'legitimate_interest') as import('../../discovery/provider-contract').LawfulBasisKind },
        pendingOperationIds: pending.map((row) => row.operation_id),
        originalSmtpAcknowledgements: [],
      };
    },
    persist: async (tx, address, decision, references, quality: ContactQualityFact | null = null) => {
      const heads = await tx.$queryRaw<Array<{ result_snapshot: unknown; target_snapshot: unknown; frozen_limits: unknown; status: string }>>`SELECT result_snapshot,target_snapshot,frozen_limits,status FROM public.contact_enrichment_execution
        WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid`;
      if (heads.length !== 1 || !heads[0] || heads[0].status === 'REDACTED' || heads[0].status === 'COMPLETED' || heads[0].status === 'FAILED') throw new EnrichmentSafetyError('HOLD');
      const head = heads[0];
      const frozen = closedSafetyRecord(head.frozen_limits, ['caps','admittedAtMs','deadlineAtMs','targetCount','executionOptions']);
      const targetCount = safetyInteger(frozen.targetCount, 0, 10);
      const targets = Array.isArray(head.target_snapshot) ? head.target_snapshot : [];
      if (targets.length !== targetCount) throw new EnrichmentSafetyError('HOLD');
      const snapshot = head.result_snapshot === null ? { contacts: [] as unknown[] } : head.result_snapshot as { contacts?: unknown };
      const contacts = Array.isArray(snapshot.contacts) ? snapshot.contacts.filter((entry) => entry !== null && typeof entry === 'object' && (entry as { contactId?: unknown }).contactId !== address.contactId) : [];
      const merged = [...contacts, decision];
      if (merged.length > targetCount) throw new EnrichmentSafetyError('HOLD');
      const parsed = merged.map(parseEnrichmentContactApplyDecision);
      if (new Set(parsed.map((entry) => entry.contactId)).size !== parsed.length) throw new EnrichmentSafetyError('HOLD');
      const newCandidatePoints = parsed.reduce((sum, entry) => sum + entry.newCandidatePoints, 0);
      if (newCandidatePoints > 10) throw new EnrichmentSafetyError('HOLD');
      const priorQuality = head.result_snapshot === null ? [] : readEnrichmentResultSnapshot(head.result_snapshot).quality;
      const qualityContacts = quality === null ? [...priorQuality] : [...priorQuality.filter((fact) => fact.contactId !== address.contactId), quality];
      if (new Set(qualityContacts.map((fact) => fact.contactId)).size !== qualityContacts.length || qualityContacts.length > targetCount ||
          qualityContacts.some((fact) => !parsed.some((entry) => entry.contactId === fact.contactId))) throw new EnrichmentSafetyError('HOLD');
      for (const reference of references) {
        await tx.$queryRaw`UPDATE public.contact_enrichment_execution_step SET dispatch_phase='SETTLED',domain_state='APPLIED',revision=revision+1
          WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND contact_id=${address.contactId}::uuid AND id=${reference.stepId}::uuid AND budget_operation_id=${reference.durableReceipt.operationId}::uuid`;
      }
      await tx.$queryRaw`UPDATE public.contact_enrichment_execution_step SET dispatch_phase='RELEASED'
        WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND contact_id=${address.contactId}::uuid AND dispatch_phase='ADMITTED' AND budget_operation_id IS NULL`;
      const remaining = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM public.contact_enrichment_execution_step
        WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND dispatch_phase NOT IN ('SETTLED','RELEASED','REDACTED')`;
      const stepStates = await readHeadFacts(tx, address);
      const nextStatus = aggregateHeadStatus(parsed, stepStates, Number(remaining[0]?.count ?? -1), targetCount);
      await tx.$queryRaw`UPDATE public.contact_enrichment_execution
        SET result_snapshot=${canonicalSafetyJson({ version: 2, targetCount, newCandidatePoints, contacts: parsed, quality: { version: 1, contacts: qualityContacts } })}::jsonb,result_revision=result_revision+1,status=${nextStatus}
        WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid AND status<>'REDACTED'`;
    },
    finishAttempt: async (address) => {
      await transactions.withWorkspace(address.workspaceId, async (tx) => {
        const heads = await tx.$queryRaw<Array<{ result_snapshot: unknown; frozen_limits: unknown; status: string }>>`SELECT result_snapshot,frozen_limits,status FROM public.contact_enrichment_execution
          WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid FOR UPDATE`;
        if (heads.length !== 1 || !heads[0] || heads[0].status === 'REDACTED' || heads[0].status === 'COMPLETED' || heads[0].status === 'FAILED') return;
        const frozen = closedSafetyRecord(heads[0].frozen_limits, ['caps','admittedAtMs','deadlineAtMs','targetCount','executionOptions']);
        const targetCount = safetyInteger(frozen.targetCount, 0, 10);
        const snapshot = heads[0].result_snapshot === null ? { contacts: [] } : heads[0].result_snapshot as { contacts?: unknown };
        const parsed = (Array.isArray(snapshot.contacts) ? snapshot.contacts : []).map(parseEnrichmentContactApplyDecision);
        const remaining = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM public.contact_enrichment_execution_step
          WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND dispatch_phase NOT IN ('SETTLED','RELEASED','REDACTED')`;
        const facts = await readHeadFacts(tx, address);
        const aggregate = aggregateHeadStatus(parsed, facts, Number(remaining[0]?.count ?? -1), targetCount);
        const nextStatus = aggregate === 'RUNNING' ? 'APPLY_PENDING' : aggregate;
        await tx.$queryRaw`UPDATE public.contact_enrichment_execution SET status=${nextStatus}
          WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid AND status NOT IN ('COMPLETED','FAILED','REDACTED')`;
      });
    },
    savePending: async (tx, address, reason) => {
      void reason;
      const heads = await tx.$queryRaw<Array<{ result_snapshot: unknown; target_snapshot: unknown; frozen_limits: unknown; status: string }>>`SELECT result_snapshot,target_snapshot,frozen_limits,status FROM public.contact_enrichment_execution
        WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid FOR UPDATE`;
      if (heads.length !== 1 || !heads[0] || heads[0].status === 'REDACTED' || heads[0].status === 'COMPLETED' || heads[0].status === 'FAILED') throw new EnrichmentSafetyError('HOLD');
      const frozen = closedSafetyRecord(heads[0].frozen_limits, ['caps','admittedAtMs','deadlineAtMs','targetCount','executionOptions']);
      const targetCount = safetyInteger(frozen.targetCount, 0, 10);
      const snapshot = heads[0].result_snapshot === null ? { contacts: [] } : heads[0].result_snapshot as { contacts?: unknown };
      await tx.$queryRaw`UPDATE public.contact_enrichment_execution_step SET domain_state='SAVE_PENDING' WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND contact_id=${address.contactId}::uuid AND domain_state='PENDING'`;
      const parsed = (Array.isArray(snapshot.contacts) ? snapshot.contacts : []).map(parseEnrichmentContactApplyDecision);
      const remaining = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*)::bigint AS count FROM public.contact_enrichment_execution_step
        WHERE workspace_id=${address.workspaceId}::uuid AND execution_id=${address.executionId}::uuid AND dispatch_phase NOT IN ('SETTLED','RELEASED','REDACTED')`;
      const facts = await readHeadFacts(tx, address);
      const nextStatus = aggregateHeadStatus(parsed, facts, Number(remaining[0]?.count ?? -1), targetCount, true);
      await tx.$queryRaw`UPDATE public.contact_enrichment_execution SET status=${nextStatus}
        WHERE workspace_id=${address.workspaceId}::uuid AND id=${address.executionId}::uuid AND company_id=${address.companyId}::uuid AND status NOT IN ('COMPLETED','FAILED','REDACTED')`;
    },
  };
}
