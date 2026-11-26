import { createHash } from "node:crypto";
import { types } from "node:util";
import { ForbiddenException } from "@nestjs/common";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { enrichContactsExecutionBudgetRequestScope } from "../../execution-budget/execution-budget-request-scope";
import { parseExecutionBudgetBinding } from "../../execution-budget/execution-budget-binding";
import { parseCanonicalMicrousd } from "../../tools/microusd";
import { isValidLawfulBasis } from "../../discovery/compliance/email-verification-gate";
import { buildFrozenEnrichmentPlan } from "./enrichment-call-plan";
import { canonicalSafetyJson, closedSafetyRecord, denseSafetyArray, safetyInteger } from "./enrichment-safety.contract";
import type { RequestContext } from "../../auth/request-context";
import type { LawfulBasis } from "../../discovery/provider-contract";
import type { EnrichCompanyContactsResult } from "../waterfall/enrich-company-contacts";
import type { ExecutionBudgetBinding } from "../../execution-budget/execution-budget-binding";
import type { ExecutionBudgetAuthorityService } from "../../execution-budget/execution-budget-authority.service";
import type { EnrichmentExecutionRepository, EnrichmentExecutionView } from "./enrichment-execution.repository";
import type { FrozenEnrichmentPlan } from "./enrichment-safety.contract";
import { EnrichmentSafetyError } from "./enrichment-safety.contract";
import type { ContactEnrichmentResultsPort } from "./contact-enrichment-results.controller";
import type { ContactEnrichmentResultsQuery } from "./contact-enrichment-results.dto";
export interface ContactEnrichmentSafetyOptions { lawfulBasis?: LawfulBasis; contactIds?: string[]; maxProviders?: number; maxProbe?: number; attemptId?: string; }
export interface ExistingSafetyExecution { readonly view: EnrichmentExecutionView; readonly workspaceId: string; readonly companyId: string; readonly businessRunId: string | null; readonly accountKey: string; readonly admissionRequestSha256: string; }
export type ContactEnrichmentSafetyResult = EnrichCompanyContactsResult & Readonly<{ admission: "ADMITTED" | "NOT_ADMITTED"; operationRef?: string; reasonCode?: string; qualityCoverage: "PREREQUISITE_ONLY" }>;
export interface ContactEnrichmentPreparationInput {
  readonly workspaceId: string; readonly companyId: string; readonly entrypoint: "http" | "discovery_run"; readonly businessRunId: string | null; readonly requestSha256: string;
  readonly authorityCapMicrousd: string; readonly options: ContactEnrichmentSafetyOptions;
}
export type ContactEnrichmentPreparation = Readonly<{ status: "NOT_ADMITTED"; reasonCode: string; tier?: "A" | "B" }> | Readonly<{ status: "PREPARED"; plan: FrozenEnrichmentPlan; tier: "A" | "B" }>;
export interface ContactEnrichmentSafetyServiceDeps {
  readonly authority: Pick<ExecutionBudgetAuthorityService, "verifyWorkspaceGrant">;
  readonly repository: Pick<EnrichmentExecutionRepository, "admitHttp" | "admitRun">;
  prepare(input: ContactEnrichmentPreparationInput): Promise<ContactEnrichmentPreparation>;
  readonly execution: {
    findRun(input: { workspaceId: string; companyId: string; businessRunId: string; binding: ExecutionBudgetBinding }): Promise<ExistingSafetyExecution | null>;
    findByRef(input: { workspaceId: string; companyId: string; operationRef: string }): Promise<ExistingSafetyExecution | null>;
    execute(input: { view: EnrichmentExecutionView; workspaceId: string; companyId: string; actorId: string; mode: "EXECUTE" | "RECOVER_NO_WIRE" }): Promise<EnrichCompanyContactsResult>;
  };
  readonly results: Pick<ContactEnrichmentResultsPort, "listEnrichmentExecutions" | "readEnrichmentExecution" | "listEnrichmentQualityFacts" | "readEnrichmentQualityFacts"> & {
    readStreamingEnrichmentExecution?(context: RequestContext, companyId: string, operationRef: string): Promise<unknown | null>;
  };
  authorizeRecovery(context: RequestContext, companyId: string): Promise<boolean>;
}
export interface ContactEnrichmentSafetyRunInput { readonly workspaceId: string; readonly companyId: string; readonly businessRunId: string; readonly binding: ExecutionBudgetBinding; readonly lawfulBasis: LawfulBasis; readonly remainingMicrousd: string; readonly actorId: string; }
export class ContactEnrichmentSafetyService implements ContactEnrichmentResultsPort {
  constructor(private readonly deps: ContactEnrichmentSafetyServiceDeps) {}
  async executeHttp(context: RequestContext, companyId: string, options: ContactEnrichmentSafetyOptions, compactJws?: string): Promise<ContactEnrichmentSafetyResult> {
    this.address(context.workspaceId, companyId);
    const normalized = this.options(options);
    const scope = enrichContactsExecutionBudgetRequestScope(companyId, { attemptId: normalized.attemptId });
    const authority = await this.deps.authority.verifyWorkspaceGrant({ compactJws, identity: context, scope });
    if (authority.capMicrousd === null || authority.workspaceId !== context.workspaceId || authority.subjectId !== companyId || authority.requestSha256 !== scope.requestSha256) throw new EnrichmentSafetyError("CONTROL_MISMATCH");
    const preparation = await this.prepare({ workspaceId: context.workspaceId, companyId, entrypoint: "http", businessRunId: null, requestSha256: scope.requestSha256, authorityCapMicrousd: parseCanonicalMicrousd("HTTP cap", authority.capMicrousd.toString()).toString(), options: normalized });
    if (preparation.status === "NOT_ADMITTED") return this.notAdmitted(companyId, preparation);
    const view = await this.deps.repository.admitHttp({ authority, plan: preparation.plan, admissionRequestSha256: this.admissionDigest("http", null, normalized), executionOptions: { lawfulBasisKind: normalized.lawfulBasis!.basis, tier: preparation.tier } });
    const result = await this.deps.execution.execute({ view, workspaceId: context.workspaceId, companyId, actorId: context.userId, mode: "EXECUTE" });
    return { ...result, admission: "ADMITTED", operationRef: view.operationRef, qualityCoverage: "PREREQUISITE_ONLY" };
  }
  async executeRun(input: ContactEnrichmentSafetyRunInput): Promise<ContactEnrichmentSafetyResult> {
    this.address(input.workspaceId, input.companyId);
    if (!isCanonicalArtifactUuid(input.businessRunId)) throw new EnrichmentSafetyError("INVALID_PLAN");
    // Grant subject is the request scope; businessRunId is the separate business execution identity.
    const binding = parseExecutionBudgetBinding(input.binding, { scopeKey: input.workspaceId, purpose: "discovery.run", subjectType: "discovery_run" });
    const options = this.options({ lawfulBasis: input.lawfulBasis });
    const admissionRequestSha256 = this.admissionDigest("discovery_run", input.businessRunId, options);
    const existing = await this.deps.execution.findRun({ workspaceId: input.workspaceId, companyId: input.companyId, businessRunId: input.businessRunId, binding });
    let view: EnrichmentExecutionView;
    if (existing) {
      if (existing.workspaceId !== input.workspaceId || existing.companyId !== input.companyId || existing.businessRunId !== input.businessRunId || existing.view.authorityId !== binding.authorityId || existing.accountKey !== binding.accountKey) throw new EnrichmentSafetyError("CONTROL_MISMATCH");
      if (existing.admissionRequestSha256 !== admissionRequestSha256) throw new EnrichmentSafetyError("INPUT_CONFLICT");
      view = existing.view;
    } else {
      const remaining = parseCanonicalMicrousd("run remaining", input.remainingMicrousd);
      const preparation = await this.prepare({ workspaceId: input.workspaceId, companyId: input.companyId, entrypoint: "discovery_run", businessRunId: input.businessRunId, requestSha256: binding.requestSha256, authorityCapMicrousd: remaining.toString(), options });
      if (preparation.status === "NOT_ADMITTED") return this.notAdmitted(input.companyId, preparation);
      view = await this.deps.repository.admitRun({ binding, plan: preparation.plan, admissionRequestSha256, executionOptions: { lawfulBasisKind: options.lawfulBasis!.basis, tier: preparation.tier } });
    }
    const result = await this.deps.execution.execute({ view, workspaceId: input.workspaceId, companyId: input.companyId, actorId: input.actorId, mode: "EXECUTE" });
    return { ...result, admission: "ADMITTED", operationRef: view.operationRef, qualityCoverage: "PREREQUISITE_ONLY" };
  }
  async listEnrichmentExecutions(context: RequestContext, companyId: string, query: ContactEnrichmentResultsQuery): ReturnType<ContactEnrichmentResultsPort["listEnrichmentExecutions"]> {
    this.address(context.workspaceId, companyId);
    return this.deps.results.listEnrichmentExecutions(context, companyId, query);
  }
  async readEnrichmentExecution(context: RequestContext, companyId: string, operationRef: string): Promise<unknown | null> {
    this.address(context.workspaceId, companyId, operationRef);
    return this.deps.results.readEnrichmentExecution(context, companyId, operationRef);
  }
  async listEnrichmentQualityFacts(context: RequestContext, companyId: string, query: ContactEnrichmentResultsQuery): ReturnType<ContactEnrichmentResultsPort["listEnrichmentQualityFacts"]> {
    this.address(context.workspaceId, companyId);
    return this.deps.results.listEnrichmentQualityFacts(context, companyId, query);
  }
  async readEnrichmentQualityFacts(context: RequestContext, companyId: string, operationRef: string): Promise<unknown | null> {
    this.address(context.workspaceId, companyId, operationRef);
    return this.deps.results.readEnrichmentQualityFacts(context, companyId, operationRef);
  }
  async recoverEnrichmentExecution(context: RequestContext, companyId: string, operationRef: string): Promise<unknown | null> {
    this.address(context.workspaceId, companyId, operationRef);
    const scopes = new Set(context.scopes ?? []);
    if (!["acquisition:write", "contact-discovery:read", "compliance:manage"].every((scope) => scopes.has(scope as never))) throw new ForbiddenException("contact enrichment recovery scope required");
    const existing = await this.deps.execution.findByRef({ workspaceId: context.workspaceId, companyId, operationRef });
    if (!existing) return await this.deps.results.readStreamingEnrichmentExecution?.(context, companyId, operationRef) ?? null;
    if (existing.workspaceId !== context.workspaceId || existing.companyId !== companyId) return null;
    if (!(await this.deps.authorizeRecovery(context, companyId))) throw new ForbiddenException("contact enrichment recovery subject unavailable");
    try { await this.deps.execution.execute({ view: existing.view, workspaceId: context.workspaceId, companyId, actorId: context.userId, mode: "RECOVER_NO_WIRE" }); }
    catch (error) { if (!(error instanceof EnrichmentSafetyError) || error.code !== "HOLD") throw error; }
    return this.deps.results.readEnrichmentExecution(context, companyId, operationRef);
  }
  private address(workspaceId: string, companyId: string, operationRef?: string): void {
    if (![workspaceId, companyId].every(isCanonicalArtifactUuid) || (operationRef !== undefined && !/^[a-f0-9]{64}$/.test(operationRef))) throw new EnrichmentSafetyError("INVALID_PLAN");
  }
  private options(value: ContactEnrichmentSafetyOptions): ContactEnrichmentSafetyOptions {
    if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) throw new EnrichmentSafetyError("INVALID_PLAN");
    const allowed = ["lawfulBasis", "contactIds", "maxProviders", "maxProbe", "attemptId"];
    const keys = Reflect.ownKeys(value); if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) throw new EnrichmentSafetyError("INVALID_PLAN");
    const row = closedSafetyRecord(value, keys as string[]);
    if (!isValidLawfulBasis(row.lawfulBasis as LawfulBasis | undefined)) throw new ForbiddenException({ error: { code: "CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED", message: "an explicit lawful basis is required for external contact enrichment" } });
    const lawfulBasis = row.lawfulBasis as LawfulBasis;
    for (const text of [lawfulBasis.ref, lawfulBasis.note, row.attemptId]) if (text !== undefined && (typeof text !== "string" || text.length > 4096 || Array.from(text).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new EnrichmentSafetyError("INVALID_PLAN");
    const contactIds = row.contactIds === undefined ? undefined : denseSafetyArray(row.contactIds, 10).map((id) => { if (!isCanonicalArtifactUuid(id)) throw new EnrichmentSafetyError("INVALID_PLAN"); return id; });
    if (contactIds && new Set(contactIds).size !== contactIds.length) throw new EnrichmentSafetyError("INVALID_PLAN");
    return { lawfulBasis: { basis: lawfulBasis.basis, ...(lawfulBasis.ref === undefined ? {} : { ref: lawfulBasis.ref }), ...(lawfulBasis.note === undefined ? {} : { note: lawfulBasis.note }) }, ...(contactIds === undefined ? {} : { contactIds: [...contactIds].sort() }), ...(row.maxProviders === undefined ? {} : { maxProviders: safetyInteger(row.maxProviders, 1, 3) }), ...(row.maxProbe === undefined ? {} : { maxProbe: safetyInteger(row.maxProbe, 1, 6) }), ...(row.attemptId === undefined ? {} : { attemptId: row.attemptId as string }) };
  }
  private admissionDigest(entrypoint: "http" | "discovery_run", businessRunId: string | null, options: ContactEnrichmentSafetyOptions): string {
    return createHash("sha256").update(canonicalSafetyJson({ version: 1, entrypoint, businessRunId, lawfulBasis: { basis: options.lawfulBasis!.basis, ref: options.lawfulBasis!.ref ?? null, note: options.lawfulBasis!.note ?? null }, contactIds: options.contactIds ?? null, maxProviders: options.maxProviders ?? 3, maxProbe: options.maxProbe ?? 6, attemptId: options.attemptId ?? null })).digest("hex");
  }
  private async prepare(input: ContactEnrichmentPreparationInput): Promise<ContactEnrichmentPreparation> {
    try {
      const prepared = await this.deps.prepare(input);
      if (prepared.status === "NOT_ADMITTED") return prepared;
      const { version, planSha256, ...body } = prepared.plan;
      const plan = buildFrozenEnrichmentPlan(body);
      if (version !== 1 || plan.planSha256 !== planSha256 || plan.workspaceId !== input.workspaceId || plan.companyId !== input.companyId || plan.entrypoint !== input.entrypoint || plan.businessRunId !== input.businessRunId || plan.requestSha256 !== input.requestSha256 || BigInt(plan.limits.authorityCapMicrousd) > BigInt(input.authorityCapMicrousd) || plan.limits.finderContactMax > (input.options.maxProviders ?? 3) || plan.limits.verifyAddressMax > (input.options.maxProbe ?? 6) || !plan.targets.every((target) => isCanonicalArtifactUuid(target.contactId))) throw new EnrichmentSafetyError("CONTROL_MISMATCH");
      return { status: "PREPARED", plan, tier: prepared.tier };
    } catch (error) {
      if (error instanceof EnrichmentSafetyError && (error.code === "GOVERNANCE_PENDING" || error.code === "BUDGET_CAP_EXCEEDED")) return { status: "NOT_ADMITTED", reasonCode: error.code === "GOVERNANCE_PENDING" ? "GOVERNANCE_PENDING" : "BUDGET_CAP" };
      throw error;
    }
  }
  private notAdmitted(companyId: string, outcome: Extract<ContactEnrichmentPreparation, { status: "NOT_ADMITTED" }>): ContactEnrichmentSafetyResult {
    return { companyId, tier: outcome.tier ?? "B", attempted: 0, costMicrousd: 0, deadlineHit: false, results: [], admission: "NOT_ADMITTED", reasonCode: outcome.reasonCode, qualityCoverage: "PREREQUISITE_ONLY" };
  }
}
