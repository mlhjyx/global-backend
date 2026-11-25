import { EMAIL_VERIFICATION_STATES } from "../../discovery/contact-point-verification-state";
import { CONTACT_ENRICHMENT_RESULT_REASONS, closedSafetyRecord, safetyInteger, type EnrichmentContactResultReason } from "./enrichment-safety.contract";
import { parseDurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import type { DomainAckRecord } from "../../durable-results/domain-ack";
import { applyDomainAckConsumerTransactions, getDomainAckProductConsumerBinding } from "../../durable-results/domain-ack-consumer-bindings";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { parseContactEmailFindPayload } from "../../durable-results/artifact/materializers/contact-email-find.materializer";
import { parseContactEmailVerificationResult } from "../../durable-results/contact-email-verification-projections";
import { upsertProviderEmailPoint, setEmailPointState } from "../../discovery/contact-point-writer";
import { recordContactPointVerificationEvent, buildVerificationRequestHash } from "../../discovery/contact-point-verification-event";
import { classifyContactEmail } from "../../discovery/contact-classifier";
import { transitionVerificationState, verifiedAtStateColumns, legacyCatchAllFromClass } from "../../discovery/contact-point-verification-state";
import { isValidLawfulBasis } from "../../discovery/compliance/email-verification-gate";
import { enrichmentInputVersion, enrichmentRequestHash, normalizeEnrichedEmail } from "../finders/email-enrichment-provider";
import { recordEnrichmentAttempt } from "../waterfall/enrichment-attempt";
import { resolveVerificationVotes, scoreEmailPoint } from "../verification/verification-policy";
import { eventVerdictFromProviderResult } from "../verification/verification-waterfall";
import { mapSmtpProbeOutcome } from "../verification/smtp-probe.provider";
import type { EmailVerificationProviderResult } from "../verification/email-verification-provider";
import type { ProviderEmailPointSnapshot } from "../../discovery/contact-point-writer";
import { contactTargetBeforeDigest } from "./enrichment-target-snapshot";
import { assertSupportedEnrichmentSlot } from "./enrichment-call-plan";
import { canonicalSafetyJson, deepFreezeSafety, denseSafetyArray, parseEnrichmentCandidateRef } from "./enrichment-safety.contract";
import { buildContactQualityFact, type ContactQualityFact, type ContactQualityNewPoint, type ContactQualityPoint } from "./enrichment-quality-facts";
import type { Prisma } from "@prisma/client";
import type { LawfulBasis } from "../../discovery/provider-contract";
import type { FindEmailInput } from "../finders/email-enrichment-provider";
import type { WorkspaceEnrichmentTransactions } from "./enrichment-execution.repository";
import type { ContactTargetSnapshot, BoundEnrichmentStep, SettledEnrichmentStepReference, EnrichmentDomainMaterializedResult } from "./enrichment-safety.contract";
import { EnrichmentSafetyError } from "./enrichment-safety.contract";
import type { EnrichmentPointBeforeSnapshot } from "./enrichment-target-snapshot";
type PreparedEnrichmentApplication = Readonly<{
  status: "OK";
  results: readonly EnrichmentDomainMaterializedResult[];
  finder: Extract<EnrichmentDomainMaterializedResult, { phase: "FINDER" }>;
  candidate: import("../../durable-results/artifact/materializers/contact-email-find.materializer").ContactEmailFindPayload;
  votes: readonly EmailVerificationProviderResult[];
  resolved: import("../verification/verification-policy").ResolvedVerificationVotes;
  now: Date;
}>;
export interface EnrichmentContactCommitAddress { workspaceId: string; companyId: string; executionId: string; contactId: string; }
export interface EnrichmentContactApplyDecision {
  readonly status: "APPLIED" | "REPLAYED" | "SAVE_PENDING" | "REDACTED";
  readonly contactId: string | null; readonly reasonCode: EnrichmentContactResultReason;
  readonly state: "VALID" | "INVALID" | "CATCH_ALL_RISKY" | "UNKNOWN" | null;
  readonly pointRefs: readonly string[]; readonly eventRefs: readonly string[]; readonly attemptRefs: readonly string[];
  /** This call's actual creation delta. A replay is zero; the stored original request snapshot is not rewritten. */
  readonly newCandidatePoints: number;
}
export interface LockedEnrichmentContactCommitState extends EnrichmentContactCommitAddress {
  readonly authorityId: string; readonly accountId: string; readonly generation: number; readonly businessRunId: string | null;
  readonly target: ContactTargetSnapshot;
  readonly currentInput: Pick<FindEmailInput, "fullName" | "domain" | "companyName" | "linkedinUrl">;
  readonly currentPoints: readonly EnrichmentPointBeforeSnapshot[];
  /** Typed email categories of the same locked rows; absent in ports that cannot prove them. */
  readonly qualityPoints?: readonly ContactQualityPoint[];
  readonly originalReferences: readonly Readonly<{ step: BoundEnrichmentStep; reference: SettledEnrichmentStepReference }>[];
  /** Current original-operation facts, independent of whether a settled reference can be built. */
  readonly originalFacts?: readonly Readonly<{ stepId: string; operationId: string | null; status: string | null; dispatchPhase: string; domainState: string }>[];
  readonly committed: EnrichmentContactApplyDecision | null; readonly redacted: boolean; readonly lawfulBasis: LawfulBasis;
  readonly pendingOperationIds: readonly string[]; readonly originalSmtpAcknowledgements: readonly DomainAckRecord[];
}
export interface EnrichmentDomainCommitStore {
  readCommitted(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress): Promise<EnrichmentContactApplyDecision | null>;
  /** SQL adapter must lock original authority/account, suppression policy, head/steps and contact/points in that order. */
  lockAndLoad(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress): Promise<LockedEnrichmentContactCommitState | null>;
  persist(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, decision: EnrichmentContactApplyDecision, references: readonly SettledEnrichmentStepReference[], quality?: ContactQualityFact | null): Promise<void>;
  savePending(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, reason: "INPUT_CONFLICT" | "SUPPRESSED"): Promise<void>;
  /** End-of-run transition only: RUNNING -> APPLY_PENDING; never changes terminal states. */
  finishAttempt?(address: Pick<EnrichmentContactCommitAddress, "workspaceId" | "companyId" | "executionId">): Promise<void>;
}
export interface EnrichmentContactAckInput {
  readonly transaction: Prisma.TransactionClient;
  readonly acknowledgements: readonly Readonly<{ producerId: string; receipt: SettledEnrichmentStepReference["durableReceipt"]; domainAckKey: string; domainRevision: string }>[];
  readonly apply: (tx: Prisma.TransactionClient) => Promise<EnrichmentContactApplyDecision>;
  readonly readback: (tx: Prisma.TransactionClient) => Promise<EnrichmentContactApplyDecision>;
}
export interface EnrichmentDomainCommitDeps {
  readonly transactions: WorkspaceEnrichmentTransactions; readonly store: EnrichmentDomainCommitStore;
  materialize(stepId: string, context: { workspaceId: string; companyId: string }): Promise<EnrichmentDomainMaterializedResult | null>;
  authorizeCurrent(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, email?: string): Promise<boolean>;
  /** Explicit fake override only for private transaction-port tests; default uses original same-tx ACK helper. */
  acknowledge?: (input: EnrichmentContactAckInput) => Promise<{ status: "APPLIED" | "REPLAYED" | "UNRECEIPTED"; value: EnrichmentContactApplyDecision }>;
  readonly clock?: () => Date;
}
export class EnrichmentDomainCommitter {
  constructor(private readonly deps: EnrichmentDomainCommitDeps) {}
  async commitContact(address: EnrichmentContactCommitAddress, stepIds: readonly string[], actorId: string): Promise<EnrichmentContactApplyDecision> {
    if (![address.workspaceId, address.companyId, address.executionId, address.contactId].every(isCanonicalArtifactUuid) || typeof actorId !== "string" || actorId.length < 1 || actorId.length > 256) return this.hold();
    const ids = denseSafetyArray(stepIds, 21);
    if (ids.length < 1 || !ids.every(isCanonicalArtifactUuid) || new Set(ids).size !== ids.length) return this.hold();
    const cached = await this.deps.transactions.withWorkspace(address.workspaceId, (tx) => this.deps.store.readCommitted(tx, address));
    if (cached && cached.status !== "SAVE_PENDING") return this.replay(cached);
    const results: EnrichmentDomainMaterializedResult[] = [];
    // No write transaction spans artifact IO, decryption or typed result loading.
    for (const stepId of ids) {
      const result = await this.deps.materialize(stepId as string, { workspaceId: address.workspaceId, companyId: address.companyId });
      if (!result) return this.hold(); results.push(result);
    }
    return this.deps.transactions.withWorkspace(address.workspaceId, async (tx) =>
      this.runInTransaction(tx, address, results, actorId),
    );
  }
  /** Persist a closed skip/reuse decision without materializing any provider result. */
  async commitSkipped(address: EnrichmentContactCommitAddress, decision: EnrichmentContactApplyDecision): Promise<EnrichmentContactApplyDecision> {
    if (![address.workspaceId, address.companyId, address.executionId, address.contactId].every(isCanonicalArtifactUuid)) return this.hold();
    const normalized = parseEnrichmentContactApplyDecision(decision);
    if (normalized.contactId !== address.contactId || normalized.status === "REDACTED") return this.hold();
    const cached = await this.deps.transactions.withWorkspace(address.workspaceId, (tx) => this.deps.store.readCommitted(tx, address));
    if (cached) return this.replay(cached);
    return this.deps.transactions.withWorkspace(address.workspaceId, async (tx) => {
      const state = await this.deps.store.lockAndLoad(tx, address);
      if (!state) return this.hold();
      if (state.committed) {
        if (!this.committedCoherent(state)) return this.hold();
        return this.replay(state.committed);
      }
      if (state.redacted) return this.empty(address, "REDACTED", "REDACTED");
      if (this.activeOriginalFacts(state).length > 0) return this.hold();
      await this.deps.store.persist(tx, address, normalized, [], this.qualityFact(state, normalized, null));
      return normalized;
    });
  }
  private activeOriginalFacts(state: LockedEnrichmentContactCommitState): readonly NonNullable<LockedEnrichmentContactCommitState["originalFacts"]>[number][] {
    return (state.originalFacts ?? []).filter((fact) => fact.operationId !== null && fact.status !== "RELEASED" &&
      !(fact.status === "SETTLED" && (fact.dispatchPhase === "SETTLED" || fact.dispatchPhase === "SETTLED_WAITING_APPLY") && fact.domainState === "APPLIED"));
  }
  private committedCoherent(state: LockedEnrichmentContactCommitState): boolean {
    return this.activeOriginalFacts(state).length === 0;
  }
  private async runInTransaction(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, results: readonly EnrichmentDomainMaterializedResult[], actorId: string): Promise<EnrichmentContactApplyDecision> {
    const state = await this.deps.store.lockAndLoad(tx, address);
    if (!state) return this.hold();
    if (state.committed && state.committed.status !== "SAVE_PENDING") {
      if (!this.committedCoherent(state)) return this.hold();
      return this.replay(state.committed);
    }
    if (state.redacted) return this.empty(address, "REDACTED", "REDACTED");
    this.assertOriginalBindings(state, address, results);
    const conflict = await this.detectInputConflict(tx, address, state);
    if (conflict) return conflict;
    const prepared = await this.prepareWireApplication(tx, address, state, results);
    if (prepared.status === "DENIED") return prepared.decision;
    return this.applyAndAcknowledge(tx, address, state, results, prepared, actorId);
  }
  private async detectInputConflict(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState): Promise<EnrichmentContactApplyDecision | null> {
    const inputVersion = enrichmentInputVersion(state.currentInput);
    const sameInput = inputVersion === state.target.inputVersion && contactTargetBeforeDigest({ inputVersion, points: state.currentPoints }) === state.target.beforeDigest;
    if (sameInput && !state.currentPoints.some((point) => point.type === "email" && point.verificationState === "VALID")) return null;
    await this.deps.store.savePending(tx, address, "INPUT_CONFLICT");
    return this.empty(address, "SAVE_PENDING", "INPUT_CONFLICT");
  }
  private isProspeoVerifiedAttestation(
    finder: Extract<EnrichmentDomainMaterializedResult, { phase: "FINDER" }>,
    candidate: import("../../durable-results/artifact/materializers/contact-email-find.materializer").ContactEmailFindPayload,
  ): boolean {
    return (
      finder.step.provider === "prospeo" &&
      candidate.status === "hit" &&
      candidate.providerConfidence !== null &&
      candidate.providerConfidence >= 95 &&
      candidate.acceptAll !== true
    );
  }
  private async prepareWireApplication(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState, results: readonly EnrichmentDomainMaterializedResult[]): Promise<PreparedEnrichmentApplication | Readonly<{ status: "DENIED"; decision: EnrichmentContactApplyDecision }>> {
    const finder = this.singleFinder(results);
    const candidate = parseContactEmailFindPayload(finder.result);
    if (candidate.status === "miss" && results.length !== 1) return this.hold();
    if (candidate.email !== null && normalizeEnrichedEmail(candidate.email, state.currentInput.domain, { allowCorporateGroup: true }) !== candidate.email) return this.hold();
    if (!isValidLawfulBasis(state.lawfulBasis)) return this.hold();
    if (!(await this.deps.authorizeCurrent(tx, address, candidate.email ?? undefined))) {
      await this.deps.store.savePending(tx, address, "SUPPRESSED");
      return { status: "DENIED" as const, decision: this.empty(address, "SAVE_PENDING", "SUPPRESSED") };
    }
    const now = (this.deps.clock ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) return this.hold();
    const votes = results.filter((result) => result.phase !== "FINDER").map((result) => this.verificationResult(result));
    if (votes.length > 6) return this.hold();
    let resolved = resolveVerificationVotes(votes.map((vote) => ({ providerKey: vote.providerKey, state: vote.state, catchAllClass: vote.catchAllClass, acceptAll: vote.acceptAll })));
    const rejectedByVerifier = votes.some((vote) => vote.state === "INVALID" || vote.catchAllClass === "true_catch_all");
    if (this.isProspeoVerifiedAttestation(finder, candidate) && !rejectedByVerifier && resolved.state !== "VALID") {
      resolved = { state: "VALID", catchAllClass: "not_catch_all", reason: "prospeo_only_verified_email" };
    }
    return { status: "OK" as const, results, finder, candidate, votes, resolved, now };
  }
  private singleFinder(results: readonly EnrichmentDomainMaterializedResult[]): Extract<EnrichmentDomainMaterializedResult, { phase: "FINDER" }> {
    const finders = results.filter((result): result is Extract<EnrichmentDomainMaterializedResult, { phase: "FINDER" }> => result.phase === "FINDER");
    if (finders.length !== 1) return this.hold();
    return finders[0]!;
  }
  private async applyAndAcknowledge(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState, results: readonly EnrichmentDomainMaterializedResult[], prepared: Extract<PreparedEnrichmentApplication, { status: "OK" }>, actorId: string): Promise<EnrichmentContactApplyDecision> {
    const { candidate, finder, resolved } = prepared;
    const { pointRefs, eventRefs } = await this.writePointAndEvents(tx, address, state, prepared, actorId);
    const finderProvider = finder.step.provider as "hunter" | "prospeo";
    const attempt = await recordEnrichmentAttempt(tx, { workspaceId: address.workspaceId, contactId: address.contactId, providerKey: finderProvider, requestHash: enrichmentRequestHash(address.contactId, finderProvider, state.currentInput), outcome: candidate.status, costMicrousd: this.originalCharge(finder), emailState: candidate.status === "hit" ? resolved.state : null,
      evidence: { costBasis: "estimated_upper_bound", latencyBasis: "unavailable" }, runId: state.businessRunId, accountKey: finder.step.accountKey, attemptedAt: prepared.now });
    if (!attempt.attempt) return this.hold();
    const decision: EnrichmentContactApplyDecision = deepFreezeSafety({ status: "APPLIED", contactId: address.contactId, reasonCode: candidate.status === "miss" ? "NO_MATCH" : resolved.state === "INVALID" ? "INVALID_ALL" : "STORED", state: candidate.status === "miss" ? null : resolved.state, pointRefs, eventRefs, attemptRefs: [attempt.attempt.id], newCandidatePoints: pointRefs.length });
    const newPoint: ContactQualityNewPoint | null = candidate.email !== null && pointRefs.length > 0 && decision.state !== null ? { emailType: classifyContactEmail(candidate.email).emailType, state: decision.state } : null;
    return this.applyAcknowledgements(tx, address, state, results, decision, pointRefs, this.qualityFact(state, decision, newPoint));
  }
  private async writePointAndEvents(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState, prepared: Extract<PreparedEnrichmentApplication, { status: "OK" }>, actorId: string): Promise<{ pointRefs: string[]; eventRefs: string[] }> {
    const { candidate, finder, resolved, now } = prepared;
    if (candidate.email === null || resolved.state === "INVALID") return { pointRefs: [], eventRefs: [] };
    const point = await upsertProviderEmailPoint(tx, { workspaceId: address.workspaceId, contactId: address.contactId, email: candidate.email, emailType: classifyContactEmail(candidate.email).emailType, legalBasis: state.lawfulBasis.basis });
    // The concrete store holds the parent FOR UPDATE and all original point rows. Real FK/concurrency proof is a mandatory PG gate.
    // Allow upgrading an existing unverified (UNKNOWN / CATCH_ALL_RISKY) point; never overwrite a VALID point.
    if (point.verificationState === "VALID" || point.validSince !== null) throw new EnrichmentSafetyError("INPUT_CONFLICT");
    const eventRefs = await this.recordVotes(tx, address, state, prepared, point.id, actorId);
    await this.applyFinalPointState(tx, state, prepared, point, finder, eventRefs, now);
    return { pointRefs: [point.id], eventRefs };
  }
  private async recordVotes(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState, prepared: Extract<PreparedEnrichmentApplication, { status: "OK" }>, pointId: string, actorId: string): Promise<string[]> {
    const { votes, finder, candidate, resolved } = prepared;
    const sources = prepared.results.filter((result) => result.phase !== "FINDER");
    const eventRefs: string[] = [];
    for (const [index, vote] of votes.entries()) {
      const source = sources[index]!;
      const event = await recordContactPointVerificationEvent(tx, { workspaceId: address.workspaceId, contactPointId: pointId, providerKey: vote.providerKey, method: vote.method ?? "third_party_api", verdict: eventVerdictFromProviderResult(vote), detail: source.phase === "SMTP" ? vote.detail : "provider_verdict", catchAll: vote.catchAll, catchAllClass: vote.catchAllClass, score: vote.score,
        costMicrousd: this.originalCharge(source), lawfulBasis: state.lawfulBasis as unknown as Record<string, unknown>, actorId, requestHash: buildVerificationRequestHash(pointId, vote.providerKey, source.step.operationKey), latencyMs: null });
      if (!event.id) return this.hold();
      eventRefs.push(event.id);
    }
    if (resolved.reason === "prospeo_only_verified_email" && this.isProspeoVerifiedAttestation(finder, candidate)) {
      const event = await recordContactPointVerificationEvent(tx, { workspaceId: address.workspaceId, contactPointId: pointId, providerKey: "prospeo", method: "third_party_api", verdict: "valid", detail: "prospeo_only_verified_email", catchAll: "not_catch_all", catchAllClass: "not_catch_all", score: 95,
        costMicrousd: 0, lawfulBasis: state.lawfulBasis as unknown as Record<string, unknown>, actorId, requestHash: buildVerificationRequestHash(pointId, "prospeo", finder.step.operationKey), latencyMs: null });
      if (!event.id) return this.hold();
      eventRefs.push(event.id);
    }
    return eventRefs;
  }
  private async applyFinalPointState(tx: Prisma.TransactionClient, state: LockedEnrichmentContactCommitState, prepared: Extract<PreparedEnrichmentApplication, { status: "OK" }>, point: ProviderEmailPointSnapshot, finder: Extract<EnrichmentDomainMaterializedResult, { phase: "FINDER" }>, eventRefs: readonly string[], now: Date): Promise<void> {
    const { resolved, votes } = prepared;
    if (votes.length === 0 && resolved.reason !== "prospeo_only_verified_email") {
      await setEmailPointState(tx, { pointId: point.id, state: "UNKNOWN", status: "UNVERIFIED", validSince: null, verifiedAt: now, nextReverifyAt: new Date(now.getTime() + 24 * 3600000), confidence: 20, catchAll: "unknown", catchAllClass: null, lastVerificationEventId: null });
      return;
    }
    const verdict = resolved.state === "VALID" ? "valid" : resolved.state === "CATCH_ALL_RISKY" ? "catch_all" : "unknown";
    const columns = verifiedAtStateColumns(transitionVerificationState({ state: point.verificationState, validSince: point.validSince, nextReverifyAt: point.nextReverifyAt }, { verdict, catchAllClass: resolved.catchAllClass }, now));
    const last = votes.filter((vote) => vote.error === null).at(-1);
    const providerKey = resolved.reason === "prospeo_only_verified_email" ? "prospeo" : (last?.providerKey ?? finder.step.provider);
    const verificationMethod = resolved.reason === "prospeo_only_verified_email" ? "third_party_api" : (last?.method ?? "third_party_api");
    await setEmailPointState(tx, { pointId: point.id, state: columns.verificationState, status: columns.status, validSince: columns.validSince, verifiedAt: columns.verifiedAt, nextReverifyAt: columns.nextReverifyAt, confidence: columns.confidence,
      verificationProvider: providerKey, verificationMethod, ...(resolved.state === "UNKNOWN" ? {} : { catchAll: legacyCatchAllFromClass(resolved.catchAllClass), catchAllClass: resolved.catchAllClass }), lastVerificationEventId: eventRefs[eventRefs.length - 1] ?? null });
  }
  private async applyAcknowledgements(tx: Prisma.TransactionClient, address: EnrichmentContactCommitAddress, state: LockedEnrichmentContactCommitState, results: readonly EnrichmentDomainMaterializedResult[], decision: EnrichmentContactApplyDecision, pointRefs: readonly string[], quality: ContactQualityFact | null): Promise<EnrichmentContactApplyDecision> {
    const acknowledgements = results.filter((result) => !this.originalSmtpAcknowledged(state, result)).map((result) => ({ producerId: result.step.toolId, receipt: result.reference.durableReceipt,
      domainAckKey: result.phase === "SMTP" ? (pointRefs[0] ? `contact-point:${pointRefs[0]}:${result.reference.durableReceipt.operationId}` : `contact-guess:${address.contactId}:${result.reference.durableReceipt.operationId}`) : `contact-enrichment:${address.executionId}:${address.contactId}:${result.reference.durableReceipt.operationId}`, domainRevision: result.reference.resultDigest }));
    const request: EnrichmentContactAckInput = { transaction: tx, acknowledgements, apply: async (transaction) => { await this.deps.store.persist(transaction, address, decision, results.map((result) => result.reference), quality); return decision; }, readback: async (transaction) => { const value = await this.deps.store.readCommitted(transaction, address); return value ? this.replay(value) : this.hold(); } };
    const applied = this.deps.acknowledge ? await this.deps.acknowledge(request) : await applyDomainAckConsumerTransactions(request);
    if (applied.status === "UNRECEIPTED" || !applied.value) return this.hold();
    return applied.status === "REPLAYED" ? this.replay(applied.value) : applied.value;
  }
  /** Only the original locked rows whose digest still matches the frozen target may seed quality facts. */
  private qualityFact(state: LockedEnrichmentContactCommitState, decision: EnrichmentContactApplyDecision, newPoint: ContactQualityNewPoint | null): ContactQualityFact | null {
    if (!state.qualityPoints) return null;
    const inputVersion = enrichmentInputVersion(state.currentInput);
    if (inputVersion !== state.target.inputVersion || contactTargetBeforeDigest({ inputVersion, points: state.currentPoints }) !== state.target.beforeDigest) return null;
    return buildContactQualityFact({ contactId: state.contactId, points: state.qualityPoints, decision, newPoint });
  }
  private hold(): never { throw new EnrichmentSafetyError("HOLD"); }
  private replay(value: EnrichmentContactApplyDecision): EnrichmentContactApplyDecision { return deepFreezeSafety({ ...value, status: value.status === "REDACTED" ? "REDACTED" : "REPLAYED", newCandidatePoints: 0 }); }
  private empty(address: EnrichmentContactCommitAddress, status: "SAVE_PENDING" | "REDACTED", reasonCode: "INPUT_CONFLICT" | "SUPPRESSED" | "REDACTED"): EnrichmentContactApplyDecision {
    return deepFreezeSafety({ status, contactId: status === "REDACTED" ? null : address.contactId, reasonCode, state: null, pointRefs: [], eventRefs: [], attemptRefs: [], newCandidatePoints: 0 });
  }
  private assertOriginalBindings(state: LockedEnrichmentContactCommitState, address: EnrichmentContactCommitAddress, results: readonly EnrichmentDomainMaterializedResult[]): void {
    if (state.workspaceId !== address.workspaceId || state.companyId !== address.companyId || state.executionId !== address.executionId || state.contactId !== address.contactId || state.target.contactId !== address.contactId || state.pendingOperationIds.length !== 0 || state.originalReferences.length !== results.length) return this.hold();
    const originals = new Map(state.originalReferences.map((item) => [item.step.stepId, item]));
    if (originals.size !== state.originalReferences.length) return this.hold();
    const resultIds = new Set(results.map((result) => result.step.stepId));
    if (this.activeOriginalFacts(state).some((fact) => !resultIds.has(fact.stepId))) return this.hold();
    for (const result of results) {
      const step = result.step; assertSupportedEnrichmentSlot(step);
      if (result.phase !== step.phase || step.workspaceId !== address.workspaceId || step.companyId !== address.companyId || step.executionId !== address.executionId || step.contactId !== address.contactId || step.authorityId !== state.authorityId || step.accountId !== state.accountId || step.generation !== state.generation) return this.hold();
      const original = originals.get(step.stepId); if (!original || canonicalSafetyJson(original.step) !== canonicalSafetyJson(step) || canonicalSafetyJson(original.reference) !== canonicalSafetyJson(result.reference)) return this.hold();
      const receipt = parseDurableExecutionReceipt(result.reference.durableReceipt);
      if (result.reference.stepId !== step.stepId || result.reference.producerId !== step.toolId || receipt.scopeKey !== address.workspaceId || receipt.accountId !== state.accountId || receipt.authorityId !== state.authorityId || receipt.operationId !== step.budgetOperationId || receipt.operationKey !== step.operationKey || receipt.resultDigest !== result.reference.resultDigest || receipt.resultSchema !== result.reference.resultSchema || receipt.usage.upperBoundMicrousd !== step.quoteMicrousd) return this.hold();
      if (step.phase !== "FINDER") parseEnrichmentCandidateRef(step.candidateRef);
    }
    const finder = results.find((result) => result.phase === "FINDER");
    if (!finder) return this.hold();
    for (const result of results.filter((result) => result.phase !== "FINDER")) if (result.step.candidateRef?.operationId !== finder.reference.durableReceipt.operationId || result.step.candidateRef.resultDigest !== finder.reference.resultDigest) return this.hold();
  }
  private originalCharge(result: EnrichmentDomainMaterializedResult): number {
    const receipt = parseDurableExecutionReceipt(result.reference.durableReceipt), quote = BigInt(result.step.quoteMicrousd);
    const amount = BigInt(receipt.usage.chargedMicrousd ?? result.step.quoteMicrousd);
    if (quote > 150000n || amount < 0n || amount > quote) return this.hold(); return Number(amount);
  }
  private verificationResult(result: Exclude<EnrichmentDomainMaterializedResult, { phase: "FINDER" }>): EmailVerificationProviderResult {
    if (result.phase === "SMTP") { const mapped = mapSmtpProbeOutcome({ probe: result.result.data }); return { providerKey: "smtp_self", ...mapped, score: scoreEmailPoint({ state: mapped.state, catchAllClass: mapped.catchAllClass }), disposable: null, role: null, costMicrousd: 0, latencyMs: 0, method: "smtp_rcpt" }; }
    const provider = result.step.provider;
    if (provider !== "millionverifier" && provider !== "emailable" && provider !== "zerobounce") return this.hold();
    const restored = parseContactEmailVerificationResult(provider, result.result);
    if (restored.costMicrousd !== result.step.quoteMicrousd) return this.hold();
    return { ...restored.data, detail: "provider_verdict", error: null, costMicrousd: this.originalCharge(result), latencyMs: 0, method: "third_party_api" };
  }
  private originalSmtpAcknowledged(state: LockedEnrichmentContactCommitState, result: EnrichmentDomainMaterializedResult): boolean {
    if (result.phase !== "SMTP") return false;
    const binding = getDomainAckProductConsumerBinding("smtp.rcpt_probe"), receipt = result.reference.durableReceipt;
    const matching = state.originalSmtpAcknowledgements.filter((ack) => ack.operationId === receipt.operationId);
    if (matching.length === 0) return false;
    if (!matching.some((ack) => ack.scopeKey === receipt.scopeKey && ack.authorityId === receipt.authorityId && ack.accountId === receipt.accountId && ack.consumer === binding.consumer && ack.domainAggregateType === binding.domainAggregateType && ack.resultSchema === receipt.resultSchema && ack.resultDigest === receipt.resultDigest)) return this.hold();
    return true;
  }
}


/** Closed persisted business decision only; no raw provider content or receipt is public result metadata. */
export function parseEnrichmentContactApplyDecision(value: unknown): EnrichmentContactApplyDecision {
  const bad = (): never => { throw new EnrichmentSafetyError("HOLD"); };
  const row = closedSafetyRecord(value, ["status", "contactId", "reasonCode", "state", "pointRefs", "eventRefs", "attemptRefs", "newCandidatePoints"]);
  if (row.status !== "APPLIED" && row.status !== "REPLAYED" && row.status !== "SAVE_PENDING" && row.status !== "REDACTED") return bad();
  if (typeof row.reasonCode !== "string" || !CONTACT_ENRICHMENT_RESULT_REASONS.some((reason) => reason === row.reasonCode) || (row.status === "REDACTED" ? row.contactId !== null : !isCanonicalArtifactUuid(row.contactId)) ||
      (row.state !== null && !EMAIL_VERIFICATION_STATES.some((state) => state === row.state))) return bad();
  const ids = (value: unknown, max: number): string[] => { const result = denseSafetyArray(value, max).map((id) => isCanonicalArtifactUuid(id) ? id : bad()); if (new Set(result).size !== result.length) return bad(); return result; };
  const pointRefs = ids(row.pointRefs, 100), eventRefs = ids(row.eventRefs, 18), attemptRefs = ids(row.attemptRefs, 3), newCandidatePoints = safetyInteger(row.newCandidatePoints, 0, 10);
  if (newCandidatePoints > pointRefs.length || (row.status !== "APPLIED" && newCandidatePoints !== 0) || (row.status === "REDACTED" && pointRefs.length + eventRefs.length + attemptRefs.length !== 0)) return bad();
  return deepFreezeSafety({ status: row.status, contactId: row.contactId as string | null, reasonCode: row.reasonCode as EnrichmentContactResultReason, state: row.state as EnrichmentContactApplyDecision["state"], pointRefs, eventRefs, attemptRefs, newCandidatePoints });
}
