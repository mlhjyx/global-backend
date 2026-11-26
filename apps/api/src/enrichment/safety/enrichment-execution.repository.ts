import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from "../../execution-budget/execution-budget-binding";
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from "../../execution-budget/execution-budget-authority.types";
import { MAX_MICROUSD, parseCanonicalMicrousd } from "../../tools/microusd";
import {
  buildFrozenEnrichmentPlan,
  assertSupportedEnrichmentSlot,
} from "./enrichment-call-plan";
import {
  canonicalSafetyJson,
  closedSafetyRecord,
  deepFreezeSafety,
  safetyInteger,
  type EnrichmentRuntimeExecutionRecord,
  type EnrichmentRuntimeStepRow,
  EnrichmentSafetyError,
  parseEnrichmentCandidateRef,
  parseQuotedEnrichmentSlot,
  parseBoundEnrichmentStepRow,
  parseEnrichmentExecutionOptions,
  type EnrichmentExecutionOptions,
  safetyDigest,
  type FrozenEnrichmentPlan,
  type BoundEnrichmentStep,
  type CandidateRef,
  type EnrichmentStepContextRow,
} from "./enrichment-safety.contract";

export interface WorkspaceEnrichmentTransactions {
  withWorkspace<T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T>;
}
export interface EnrichmentGrantConsumer {
  consumeVerifiedWorkspaceGrantInTransaction(
    authority: VerifiedExecutionBudgetAuthority,
    tx: Prisma.TransactionClient,
  ): Promise<ExecutionBudgetBinding>;
}
export type EnrichmentExecutionStatus =
  | "PREPARED"
  | "RUNNING"
  | "RESULT_UNKNOWN"
  | "APPLY_PENDING"
  | "COMPLETED"
  | "FAILED"
  | "REDACTED";
export interface EnrichmentExecutionView {
  readonly executionId: string;
  readonly operationRef: string;
  readonly planSha256: string;
  readonly status: EnrichmentExecutionStatus;
  readonly accountId: string;
  readonly authorityId: string;
  readonly generation: number;
}
export interface EnrichmentExecutionRow {
  id: string;
  workspace_id: string;
  company_id: string | null;
  authority_id: string;
  account_id: string;
  generation: number;
  operation_ref: string;
  plan_sha256: string;
  status: EnrichmentExecutionStatus;
  admission_request_sha256: string;
}
interface AccountRow {
  account_id: string;
  scope_key: string;
  account_key: string;
  authority_id: string;
  generation: number;
  authorized_cap_microusd: bigint | null;
}
interface PhysicalAccountRow extends AccountRow {
  closed_at: Date | null;
  ref_count: number;
}
interface OriginalReservedOperationRow {
  operation_id: string;
  scope_key: string;
  account_id: string;
  generation: number;
  operation_key: string;
  status: string;
  amount_unit: string;
  reserved_microusd: bigint | null;
}
interface AuthorityRow {
  id: string;
  scope_key: string;
  usable: boolean;
  revoked_at: Date | null;
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );
function mismatch(): never {
  throw new EnrichmentSafetyError("CONTROL_MISMATCH");
}
function validatePlan(plan: FrozenEnrichmentPlan): void {
  const { version, planSha256, ...body } = plan;
  if (
    version !== 1 ||
    buildFrozenEnrichmentPlan(body).planSha256 !== planSha256
  )
    mismatch();
}
function view(row: EnrichmentExecutionRow): EnrichmentExecutionView {
  if (
    !uuid(row.id) ||
    !uuid(row.workspace_id) ||
    !uuid(row.account_id) ||
    !uuid(row.authority_id) ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  )
    mismatch();
  if (
    ![
      "PREPARED",
      "RUNNING",
      "RESULT_UNKNOWN",
      "APPLY_PENDING",
      "COMPLETED",
      "FAILED",
      "REDACTED",
    ].includes(row.status)
  )
    mismatch();
  return Object.freeze({
    executionId: row.id,
    operationRef: safetyDigest(row.operation_ref),
    planSha256: safetyDigest(row.plan_sha256),
    status: row.status,
    accountId: row.account_id,
    authorityId: row.authority_id,
    generation: row.generation,
  });
}

/** Raw parameterized source only. Proposed tables have no Prisma delegates; real SQL/RLS remains a separate mandatory gate. */
export interface EnrichmentStepAddress {
  workspaceId: string;
  companyId: string;
  stepId: string;
}
export interface EnrichmentInputSeal extends EnrichmentStepAddress {
  expectedRevision: number;
  inputFingerprint: string;
  operationKey: string;
  candidateRef: CandidateRef | null;
}
export interface EnrichmentWireClaim extends EnrichmentStepAddress {
  expectedRevision: number;
  operationKey: string;
  expectedPricingVersion: string;
}
/** These callbacks are SQL/current-policy checks only. No object/network IO inside the short transaction. */
export interface EnrichmentStepGuards {
  assertCurrentSubjectAndPolicy(
    tx: Prisma.TransactionClient,
    step: EnrichmentStepContextRow,
  ): Promise<{ pricingVersion: string }>;
  assertCandidateOrigin(
    tx: Prisma.TransactionClient,
    step: EnrichmentStepContextRow,
    candidate: CandidateRef,
  ): Promise<void>;
}
export class EnrichmentExecutionRepository {
  constructor(
    private readonly database: WorkspaceEnrichmentTransactions,
    private readonly consumer: EnrichmentGrantConsumer,
    private readonly guards?: EnrichmentStepGuards,
  ) {}
  async admitHttp(input: {
    authority: VerifiedExecutionBudgetAuthority;
    plan: FrozenEnrichmentPlan;
    admissionRequestSha256: string;
    executionOptions?: EnrichmentExecutionOptions;
  }): Promise<EnrichmentExecutionView> {
    const { authority, plan } = input;
    validatePlan(plan);
    safetyDigest(input.admissionRequestSha256);
    const executionOptions = input.executionOptions === undefined ? null : parseEnrichmentExecutionOptions(input.executionOptions);
    if (
      plan.entrypoint !== "http" ||
      authority.authorityKind !== "WORKSPACE_GRANT" ||
      authority.workspaceId !== plan.workspaceId ||
      authority.purpose !== "contact.enrich" ||
      authority.subjectType !== "company" ||
      authority.subjectId !== plan.companyId ||
      authority.requestSha256 !== plan.requestSha256 ||
      authority.capMicrousd === null ||
      parseCanonicalMicrousd(
        "authority cap",
        plan.limits.authorityCapMicrousd,
      ) > authority.capMicrousd
    )
      mismatch();
    return this.database.withWorkspace(plan.workspaceId, async (tx) => {
      const binding = parseExecutionBudgetBinding(
        await this.consumer.consumeVerifiedWorkspaceGrantInTransaction(
          authority,
          tx,
        ),
        {
          scopeKey: plan.workspaceId,
          purpose: "contact.enrich",
          subjectType: "company",
        },
      );
      if (
        binding.subjectId !== plan.companyId ||
        binding.requestSha256 !== plan.requestSha256
      )
        mismatch();
      return this.admitInTransaction(
        tx,
        binding,
        plan,
        input.admissionRequestSha256,
        executionOptions,
      );
    });
  }
  async admitRun(input: {
    binding: ExecutionBudgetBinding;
    plan: FrozenEnrichmentPlan;
    admissionRequestSha256: string;
    executionOptions?: EnrichmentExecutionOptions;
  }): Promise<EnrichmentExecutionView> {
    const { plan } = input;
    validatePlan(plan);
    safetyDigest(input.admissionRequestSha256);
    const executionOptions = input.executionOptions === undefined ? null : parseEnrichmentExecutionOptions(input.executionOptions);
    const binding = parseExecutionBudgetBinding(input.binding, {
      scopeKey: plan.workspaceId,
      purpose: "discovery.run",
      subjectType: "discovery_run",
    });
    // Real run grants scope the subject as a derived request identity; the business run UUID
    // travels separately in the frozen plan and head, never as the grant subject id.
    if (
      plan.entrypoint !== "discovery_run" ||
      binding.requestSha256 !== plan.requestSha256
    )
      mismatch();
    return this.database.withWorkspace(plan.workspaceId, (tx) =>
      this.admitInTransaction(tx, binding, plan, input.admissionRequestSha256, executionOptions),
    );
  }
  async bindStepInput(
    input: EnrichmentInputSeal,
  ): Promise<BoundEnrichmentStep> {
    safetyDigest(input.inputFingerprint);
    this.assertOperationKey(input.operationKey);
    this.assertRevision(input.expectedRevision);
    return this.withLockedStep(input, async (tx, row, guards) => {
      const candidate = this.candidateForPhase(row, input.candidateRef);
      if (row.input_fingerprint !== null || row.operation_key !== null) {
        const previous = this.candidateForPhase(row, row.candidate_ref);
        if (
          row.input_fingerprint !== input.inputFingerprint ||
          row.operation_key !== input.operationKey ||
          canonicalSafetyJson(previous) !== canonicalSafetyJson(candidate)
        )
          throw new EnrichmentSafetyError("INPUT_CONFLICT");
        return this.boundStep(row);
      }
      if (
        row.revision !== input.expectedRevision ||
        row.dispatch_phase !== "ADMITTED"
      )
        throw new EnrichmentSafetyError("HOLD");
      await this.checkCurrentGuards(tx, row, candidate, guards);
      const updated = await tx.$queryRaw<
        { id: string }[]
      >`UPDATE public.contact_enrichment_execution_step
     SET input_fingerprint=${input.inputFingerprint},operation_key=${input.operationKey},candidate_ref=${candidate === null ? null : canonicalSafetyJson(candidate)}::jsonb,revision=revision+1
     WHERE workspace_id=${input.workspaceId}::uuid AND execution_id=${row.execution_id}::uuid AND id=${input.stepId}::uuid
       AND revision=${input.expectedRevision} AND input_fingerprint IS NULL AND operation_key IS NULL AND dispatch_phase='ADMITTED' RETURNING id::text`;
      if (updated.length !== 1 || updated[0]?.id !== row.id)
        throw new EnrichmentSafetyError("HOLD");
      return this.boundStep({
        ...row,
        input_fingerprint: input.inputFingerprint,
        operation_key: input.operationKey,
        candidate_ref: candidate,
        revision: row.revision + 1,
      });
    });
  }
  /** Called only by the original broker's beforePhysicalWire path, after its own reserve. No reserve or physical IO here. */
  async claimStepBeforeWire(
    input: EnrichmentWireClaim,
  ): Promise<BoundEnrichmentStep> {
    this.assertOperationKey(input.operationKey);
    this.assertRevision(input.expectedRevision);
    return this.withLockedStep(input, async (tx, row, guards) => {
      if (
        row.input_fingerprint === null ||
        row.operation_key === null ||
        row.dispatch_phase !== "ADMITTED" ||
        row.revision !== input.expectedRevision
      )
        throw new EnrichmentSafetyError("HOLD");
      if (
        row.operation_key !== input.operationKey ||
        row.pricing_version !== input.expectedPricingVersion ||
        row.budget_operation_id !== null
      )
        mismatch();
      const candidate = this.candidateForPhase(row, row.candidate_ref);
      await this.checkCurrentGuards(tx, row, candidate, guards);
      const operations = await tx.$queryRaw<
        OriginalReservedOperationRow[]
      >`SELECT operation_id,scope_key,account_id,generation,operation_key,status,amount_unit,reserved_microusd
     FROM public.lock_contact_enrichment_operation_v1(${input.workspaceId}::uuid, ${row.account_id}::uuid, ${row.generation}::int, ${row.operation_key})`;
      const operation = operations[0];
      if (
        operations.length !== 1 ||
        !operation ||
        !uuid(operation.operation_id) ||
        operation.scope_key !== input.workspaceId ||
        operation.account_id !== row.account_id ||
        operation.generation !== row.generation ||
        operation.operation_key !== row.operation_key ||
        operation.amount_unit !== "microusd" ||
        operation.reserved_microusd !== row.quote_microusd
      )
        mismatch();
      if (operation.status !== "RESERVED")
        throw new EnrichmentSafetyError("HOLD");
      const updated = await tx.$queryRaw<
        { id: string }[]
      >`UPDATE public.contact_enrichment_execution_step
     SET budget_operation_id=${operation.operation_id}::uuid,dispatch_phase='RESERVED',revision=revision+1
     WHERE workspace_id=${input.workspaceId}::uuid AND execution_id=${row.execution_id}::uuid AND id=${input.stepId}::uuid
       AND revision=${input.expectedRevision} AND dispatch_phase='ADMITTED' AND budget_operation_id IS NULL
       AND input_fingerprint=${row.input_fingerprint} AND operation_key=${row.operation_key} RETURNING id::text`;
      if (updated.length !== 1 || updated[0]?.id !== row.id)
        throw new EnrichmentSafetyError("HOLD");
      return this.boundStep({
        ...row,
        budget_operation_id: operation.operation_id,
        dispatch_phase: "RESERVED",
        revision: row.revision + 1,
      });
    });
  }
  private assertOperationKey(value: string): void {
    if (typeof value !== "string" || !/^[A-Za-z0-9:._/-]{1,200}$/.test(value))
      mismatch();
  }
  private assertRevision(value: number): void {
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value >= Number.MAX_SAFE_INTEGER
    )
      mismatch();
  }
  private candidateForPhase(
    row: EnrichmentStepContextRow,
    value: unknown,
  ): CandidateRef | null {
    if (row.phase === "FINDER") {
      if (value !== null) mismatch();
      return null;
    }
    if (value === null) mismatch();
    return parseEnrichmentCandidateRef(value);
  }
  private boundStep(row: EnrichmentStepContextRow): BoundEnrichmentStep {
    const step = parseBoundEnrichmentStepRow(row);
    assertSupportedEnrichmentSlot(step);
    return step;
  }
  private async checkCurrentGuards(
    tx: Prisma.TransactionClient,
    row: EnrichmentStepContextRow,
    candidate: CandidateRef | null,
    guards: EnrichmentStepGuards,
  ): Promise<void> {
    const current = await guards.assertCurrentSubjectAndPolicy(tx, row);
    if (current.pricingVersion !== row.pricing_version) mismatch();
    if (candidate !== null)
      await guards.assertCandidateOrigin(tx, row, candidate);
  }
  private async stepContext(
    tx: Prisma.TransactionClient,
    input: EnrichmentStepAddress,
  ): Promise<EnrichmentStepContextRow> {
    const rows = await tx.$queryRaw<
      EnrichmentStepContextRow[]
    >`SELECT s.id::text,s.workspace_id::text,s.execution_id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,
    s.quote_microusd,s.pricing_version,s.depends_on_slot_key,s.input_fingerprint,s.operation_key,s.budget_operation_id::text,s.candidate_ref,s.revision,s.dispatch_phase,s.domain_state,
    e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.status AS execution_status,
    ((e.frozen_limits->>'deadlineAtMs')::bigint>floor(extract(epoch FROM statement_timestamp())*1000)) AS deadline_open
    FROM public.contact_enrichment_execution_step s JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
    JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
    WHERE s.workspace_id=${input.workspaceId}::uuid AND e.company_id=${input.companyId}::uuid AND s.id=${input.stepId}::uuid`;
    if (rows.length !== 1 || !rows[0]) throw new EnrichmentSafetyError("HOLD");
    const row = rows[0];
    if (
      row.workspace_id !== input.workspaceId ||
      row.company_id !== input.companyId ||
      row.id !== input.stepId ||
      !uuid(row.execution_id) ||
      !uuid(row.authority_id) ||
      !uuid(row.account_id) ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      typeof row.quote_microusd !== "bigint" ||
      row.quote_microusd < 0n ||
      row.quote_microusd > MAX_MICROUSD
    )
      mismatch();
    if (
      row.contact_id === null ||
      row.company_id === null ||
      row.execution_status === "REDACTED" ||
      row.domain_state === "REDACTED"
    )
      throw new EnrichmentSafetyError("REDACTED");
    if (!uuid(row.contact_id)) mismatch();
    if (
      row.deadline_open !== true ||
      !["PREPARED", "RUNNING"].includes(row.execution_status)
    )
      throw new EnrichmentSafetyError("HOLD");
    const slot = parseQuotedEnrichmentSlot({
      slotKey: row.slot_key,
      contactId: row.contact_id,
      contactOrdinal: row.contact_ordinal,
      phase: row.phase,
      provider: row.provider,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      quoteMicrousd: row.quote_microusd.toString(),
      pricingVersion: row.pricing_version,
      dependsOnSlotKey: row.depends_on_slot_key,
    });
    assertSupportedEnrichmentSlot(slot);
    return row;
  }
  private immutableStepIdentity(row: EnrichmentStepContextRow): string {
    return canonicalSafetyJson({
      id: row.id,
      workspace: row.workspace_id,
      company: row.company_id,
      execution: row.execution_id,
      contact: row.contact_id,
      authority: row.authority_id,
      account: row.account_id,
      generation: row.generation,
      accountKey: row.account_key,
      slot: row.slot_key,
      phase: row.phase,
      provider: row.provider,
      tool: row.tool_id,
      version: row.tool_version,
      quote: row.quote_microusd.toString(),
      pricing: row.pricing_version,
      predecessor: row.depends_on_slot_key,
    });
  }
  private async withLockedStep<T>(
    input: EnrichmentStepAddress,
    fn: (
      tx: Prisma.TransactionClient,
      row: EnrichmentStepContextRow,
      guards: EnrichmentStepGuards,
    ) => Promise<T>,
  ): Promise<T> {
    if (
      !uuid(input.workspaceId) ||
      !uuid(input.companyId) ||
      !uuid(input.stepId)
    )
      mismatch();
    const guards = this.guards;
    if (!guards) throw new EnrichmentSafetyError("HOLD");
    return this.database.withWorkspace(input.workspaceId, async (tx) => {
      const initial = await this.stepContext(tx, input);
      const authorities = await tx.$queryRaw<
        AuthorityRow[]
      >`SELECT id,scope_key,revoked_at,usable
     FROM public.lock_contact_enrichment_authority_v1(${input.workspaceId}::uuid, ${initial.authority_id}::uuid)`;
      const authority = authorities[0];
      if (
        authorities.length !== 1 ||
        !authority ||
        authority.id !== initial.authority_id ||
        authority.scope_key !== input.workspaceId ||
        authority.usable !== true ||
        authority.revoked_at !== null
      )
        mismatch();
      const accounts = await tx.$queryRaw<
        PhysicalAccountRow[]
      >`SELECT account_id,scope_key,account_key,authority_id,generation,authorized_cap_microusd,closed_at,ref_count
     FROM public.lock_contact_enrichment_account_v1(${input.workspaceId}::uuid, ${initial.authority_id}::uuid, ${initial.account_key})`;
      const account = accounts[0];
      if (
        accounts.length !== 1 ||
        !account ||
        account.account_id !== initial.account_id ||
        account.scope_key !== input.workspaceId ||
        account.account_key !== initial.account_key ||
        account.authority_id !== initial.authority_id ||
        account.generation !== initial.generation ||
        account.closed_at !== null ||
        !Number.isSafeInteger(account.ref_count) ||
        account.ref_count < 1 ||
        typeof account.authorized_cap_microusd !== "bigint" ||
        account.authorized_cap_microusd < initial.quote_microusd ||
        account.authorized_cap_microusd > MAX_MICROUSD
      )
        mismatch();
      const anchors = await tx.$queryRaw<
        { execution_id: string; step_id: string }[]
      >`SELECT e.id::text AS execution_id,s.id::text AS step_id
     FROM public.contact_enrichment_execution e JOIN public.contact_enrichment_execution_step s ON s.workspace_id=e.workspace_id AND s.execution_id=e.id
     WHERE e.workspace_id=${input.workspaceId}::uuid AND e.company_id=${input.companyId}::uuid AND s.id=${input.stepId}::uuid FOR UPDATE OF e,s`;
      if (
        anchors.length !== 1 ||
        anchors[0]?.execution_id !== initial.execution_id ||
        anchors[0]?.step_id !== initial.id
      )
        mismatch();
      const current = await this.stepContext(tx, input);
      if (
        this.immutableStepIdentity(initial) !==
        this.immutableStepIdentity(current)
      )
        mismatch();
      return fn(tx, current, guards);
    });
  }
  private async admitInTransaction(
    tx: Prisma.TransactionClient,
    binding: ExecutionBudgetBinding,
    plan: FrozenEnrichmentPlan,
    admissionSha: string,
    executionOptions: EnrichmentExecutionOptions | null,
  ): Promise<EnrichmentExecutionView> {
    // Original authority first, then its actual opened account. No separate connection/attest during uncommitted HTTP consumption.
    const authorities = await tx.$queryRaw<
      AuthorityRow[]
    >`SELECT id,scope_key,revoked_at,usable
    FROM public.lock_contact_enrichment_authority_v1(${binding.scopeKey}::uuid, ${binding.authorityId}::uuid)`;
    const authority = authorities[0];
    if (
      authorities.length !== 1 ||
      !authority ||
      authority.id !== binding.authorityId ||
      authority.scope_key !== binding.scopeKey ||
      authority.usable !== true ||
      authority.revoked_at !== null
    )
      mismatch();
    const accounts = await tx.$queryRaw<
      AccountRow[]
    >`SELECT account_id,scope_key,account_key,authority_id,generation,authorized_cap_microusd
    FROM public.lock_contact_enrichment_account_v1(${binding.scopeKey}::uuid, ${binding.authorityId}::uuid, ${binding.accountKey})`;
    const account = accounts[0];
    if (
      accounts.length !== 1 ||
      !account ||
      !uuid(account.account_id) ||
      account.scope_key !== binding.scopeKey ||
      account.account_key !== binding.accountKey ||
      account.authority_id !== binding.authorityId ||
      !Number.isSafeInteger(account.generation) ||
      account.generation < 1 ||
      typeof account.authorized_cap_microusd !== "bigint" ||
      account.authorized_cap_microusd < 0n ||
      account.authorized_cap_microusd > MAX_MICROUSD ||
      parseCanonicalMicrousd(
        "plan authority cap",
        plan.limits.authorityCapMicrousd,
      ) > account.authorized_cap_microusd
    )
      mismatch();
    const identity = {
      version: 1,
      workspaceId: plan.workspaceId,
      companyId: plan.companyId,
      authorityId: binding.authorityId,
      accountId: account.account_id,
      generation: account.generation,
      requestSha256: plan.requestSha256,
      entrypoint: plan.entrypoint,
      businessRunId: plan.businessRunId,
    };
    const operationRef = createHash("sha256")
      .update(canonicalSafetyJson(identity), "utf8")
      .digest("hex");
    const existing = await tx.$queryRaw<
      EnrichmentExecutionRow[]
    >`SELECT id::text,workspace_id::text,company_id::text,authority_id::text,account_id::text,generation,operation_ref,plan_sha256,status,admission_request_sha256
    FROM public.contact_enrichment_execution WHERE workspace_id=${plan.workspaceId}::uuid AND company_id=${plan.companyId}::uuid
      AND authority_id=${binding.authorityId}::uuid AND account_id=${account.account_id}::uuid AND generation=${account.generation}
      AND request_sha256=${plan.requestSha256} AND entrypoint=${plan.entrypoint} AND business_run_id IS NOT DISTINCT FROM ${plan.businessRunId}::uuid FOR UPDATE`;
    if (existing.length > 1) mismatch();
    if (existing[0]) {
      const row = existing[0];
      if (plan.entrypoint === "http")
        throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_REUSED");
      if (
        row.workspace_id !== plan.workspaceId ||
        row.company_id !== plan.companyId ||
        row.authority_id !== binding.authorityId ||
        row.account_id !== account.account_id ||
        row.generation !== account.generation
      )
        mismatch();
      if (row.admission_request_sha256 !== admissionSha)
        throw new EnrichmentSafetyError("INPUT_CONFLICT");
      return view(row); // Original frozen head wins. No new target selection/deadline/plan is persisted.
    }
    const executionId = randomUUID();
    const inserted = await tx.$queryRaw<
      { id: string }[]
    >`INSERT INTO public.contact_enrichment_execution
    (id,workspace_id,company_id,entrypoint,business_run_id,authority_id,account_id,generation,request_sha256,admission_request_sha256,operation_ref,protocol_version,plan_sha256,frozen_limits,target_snapshot,status,quality_coverage,result_revision)
    VALUES (${executionId}::uuid,${plan.workspaceId}::uuid,${plan.companyId}::uuid,${plan.entrypoint},${plan.businessRunId}::uuid,${binding.authorityId}::uuid,${account.account_id}::uuid,${account.generation},${plan.requestSha256},${admissionSha},${operationRef},1,${plan.planSha256},${canonicalSafetyJson({ caps: plan.limits, admittedAtMs: plan.admittedAtMs, deadlineAtMs: plan.deadlineAtMs, targetCount: plan.targets.length, executionOptions })}::jsonb,${canonicalSafetyJson(plan.targets)}::jsonb,'PREPARED','PREREQUISITE_ONLY',1) RETURNING id::text`;
    if (inserted.length !== 1 || !inserted[0] || !uuid(inserted[0].id))
      mismatch();
    const headId = inserted[0].id;
    for (const [ordinal, slot] of plan.slots.entries()) {
      const steps = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO public.contact_enrichment_execution_step
     (id,workspace_id,execution_id,contact_id,contact_ordinal,slot_ordinal,slot_key,phase,provider,tool_id,tool_version,quote_microusd,pricing_version,depends_on_slot_key,input_fingerprint,operation_key,budget_operation_id,dispatch_phase,domain_state,revision)
     VALUES (${randomUUID()}::uuid,${plan.workspaceId}::uuid,${headId}::uuid,${slot.contactId}::uuid,${slot.contactOrdinal},${ordinal},${slot.slotKey},${slot.phase},${slot.provider},${slot.toolId},${slot.toolVersion},${slot.quoteMicrousd}::bigint,${slot.pricingVersion},${slot.dependsOnSlotKey},NULL,NULL,NULL,'ADMITTED','PENDING',1) RETURNING id::text`;
      if (steps.length !== 1 || !steps[0]) mismatch();
    }
    return view({
      id: headId,
      workspace_id: plan.workspaceId,
      company_id: plan.companyId,
      authority_id: binding.authorityId,
      account_id: account.account_id,
      generation: account.generation,
      operation_ref: operationRef,
      plan_sha256: plan.planSha256,
      status: "PREPARED",
      admission_request_sha256: admissionSha,
    });
  }
}


interface RuntimeEnrichmentHeadRow extends EnrichmentExecutionRow {
  entrypoint: "http" | "discovery_run"; business_run_id: string | null; request_sha256: string; account_key: string;
  protocol_version: number; frozen_limits: unknown; target_snapshot: unknown; created_at: Date; result_revision: number; result_snapshot: unknown;
  current_account_id: string; current_authority_id: string; current_generation: number;
}
/** Scoped SELECT-only runtime lookup; no account re-attestation, deadline refresh or implicit new execution. */
export class EnrichmentExecutionQueryRepository {
  constructor(private readonly database: WorkspaceEnrichmentTransactions) {}
  async loadById(context: { workspaceId: string; companyId: string }, executionId: string): Promise<EnrichmentRuntimeExecutionRecord | null> {
    if (!uuid(executionId)) return mismatch(); return this.lookup(context, { executionId, operationRef: null, businessRunId: null });
  }
  async loadByRef(context: { workspaceId: string; companyId: string }, operationRef: string): Promise<EnrichmentRuntimeExecutionRecord | null> {
    safetyDigest(operationRef); return this.lookup(context, { executionId: null, operationRef, businessRunId: null });
  }
  async loadByRun(context: { workspaceId: string; companyId: string }, businessRunId: string): Promise<EnrichmentRuntimeExecutionRecord | null> {
    if (!uuid(businessRunId)) return mismatch(); return this.lookup(context, { executionId: null, operationRef: null, businessRunId });
  }
  private async lookup(context: { workspaceId: string; companyId: string }, identity: { executionId: string | null; operationRef: string | null; businessRunId: string | null }): Promise<EnrichmentRuntimeExecutionRecord | null> {
    if (!uuid(context.workspaceId) || !uuid(context.companyId)) return mismatch();
    return this.database.withWorkspace(context.workspaceId, async (tx) => {
      const heads = await tx.$queryRaw<RuntimeEnrichmentHeadRow[]>`SELECT e.id::text,e.workspace_id::text,e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,
        e.operation_ref,e.plan_sha256,e.status,e.admission_request_sha256,e.entrypoint,e.business_run_id::text,e.request_sha256,e.protocol_version,e.frozen_limits,e.target_snapshot,e.created_at,e.result_revision,e.result_snapshot,
        a.id::text AS current_account_id,a.authority_id::text AS current_authority_id,a.generation AS current_generation
        FROM public.contact_enrichment_execution e JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
        WHERE e.workspace_id=${context.workspaceId}::uuid AND e.company_id=${context.companyId}::uuid
          AND (${identity.executionId}::uuid IS NULL OR e.id=${identity.executionId}::uuid)
          AND (${identity.operationRef}::text IS NULL OR e.operation_ref=${identity.operationRef})
          AND (${identity.businessRunId}::uuid IS NULL OR (e.entrypoint='discovery_run' AND e.business_run_id=${identity.businessRunId}::uuid))
        ORDER BY e.created_at,e.id LIMIT 2`;
      if (heads.length === 0) return null;
      if (heads.length !== 1 || !heads[0]) throw new EnrichmentSafetyError("HOLD");
      const head = heads[0];
      if (head.workspace_id !== context.workspaceId || head.company_id !== context.companyId) return null;
      if ((identity.executionId !== null && head.id !== identity.executionId) || (identity.operationRef !== null && head.operation_ref !== identity.operationRef) || (identity.businessRunId !== null && head.business_run_id !== identity.businessRunId)) return mismatch();
      const steps = await tx.$queryRaw<EnrichmentRuntimeStepRow[]>`SELECT s.id::text,s.workspace_id::text,s.execution_id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,s.quote_microusd,s.pricing_version,s.depends_on_slot_key,
        s.input_fingerprint,s.operation_key,s.budget_operation_id::text,s.candidate_ref,s.revision,s.dispatch_phase,s.domain_state,
        e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.status AS execution_status,
        ((e.frozen_limits->>'deadlineAtMs')::bigint>floor(extract(epoch FROM statement_timestamp())*1000)) AS deadline_open,
        o.id::text AS budget_original_id,o.status::text AS budget_status,o.amount_unit AS budget_amount_unit,o.reserved_microusd AS budget_reserved_microusd,o.charged_microusd AS budget_charged_microusd,
        o.result_schema AS budget_result_schema,o.result_digest AS budget_result_digest,o.result_json AS budget_result_json,o.receipt_usage AS budget_receipt_usage,o.receipt_cost_basis AS budget_receipt_cost_basis
        FROM public.contact_enrichment_execution_step s JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
        JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
        LEFT JOIN public.tool_budget_operation o ON o.scope_key=e.workspace_id::text AND o.account_id=e.account_id AND o.generation=e.generation AND o.operation_key=s.operation_key
        WHERE s.workspace_id=${context.workspaceId}::uuid AND s.execution_id=${head.id}::uuid AND e.company_id=${context.companyId}::uuid ORDER BY s.slot_ordinal,s.id LIMIT 71`;
      return this.hydrate(head, steps);
    });
  }
  private hydrate(head: RuntimeEnrichmentHeadRow, steps: readonly EnrichmentRuntimeStepRow[]): EnrichmentRuntimeExecutionRecord {
    const currentView = view(head);
    if (head.protocol_version !== 1 || (head.entrypoint !== "http" && head.entrypoint !== "discovery_run") || (head.entrypoint === "http") !== (head.business_run_id === null) ||
        (head.business_run_id !== null && !uuid(head.business_run_id)) || !uuid(head.current_account_id) || head.current_account_id !== head.account_id || !uuid(head.current_authority_id) ||
        !Number.isSafeInteger(head.current_generation) || head.current_generation < 1 || typeof head.account_key !== "string" || head.account_key.length < 1 || head.account_key.length > 200 ||
        !(head.created_at instanceof Date) || !Number.isFinite(head.created_at.getTime()) || steps.length > 70 || new Set(steps.map((step) => step.id)).size !== steps.length) return mismatch();
    const frozen = closedSafetyRecord(head.frozen_limits, ["caps", "admittedAtMs", "deadlineAtMs", "targetCount", "executionOptions"]);
    const targetCount = safetyInteger(frozen.targetCount, 0, 10);
    const executionOptions = frozen.executionOptions === null ? null : parseEnrichmentExecutionOptions(frozen.executionOptions);
    for (const step of steps) this.assertStepHeader(head, step);
    const plan = head.status === "REDACTED" ? null : buildFrozenEnrichmentPlan({ workspaceId: head.workspace_id, companyId: head.company_id!, entrypoint: head.entrypoint, businessRunId: head.business_run_id, requestSha256: safetyDigest(head.request_sha256),
      admittedAtMs: safetyInteger(frozen.admittedAtMs, 0, Number.MAX_SAFE_INTEGER), deadlineAtMs: safetyInteger(frozen.deadlineAtMs, 1, Number.MAX_SAFE_INTEGER), targets: head.target_snapshot as FrozenEnrichmentPlan["targets"],
      slots: steps.map((step) => parseQuotedEnrichmentSlot({ slotKey: step.slot_key, contactId: step.contact_id, contactOrdinal: step.contact_ordinal, phase: step.phase, provider: step.provider, toolId: step.tool_id, toolVersion: step.tool_version, quoteMicrousd: step.quote_microusd.toString(), pricingVersion: step.pricing_version, dependsOnSlotKey: step.depends_on_slot_key })), limits: frozen.caps as FrozenEnrichmentPlan["limits"] });
    if (plan && (plan.planSha256 !== head.plan_sha256 || plan.targets.length !== targetCount)) return mismatch();
    return deepFreezeSafety({ view: currentView, workspaceId: head.workspace_id, companyId: head.company_id!, entrypoint: head.entrypoint, businessRunId: head.business_run_id,
      requestSha256: safetyDigest(head.request_sha256), admissionRequestSha256: safetyDigest(head.admission_request_sha256), accountKey: head.account_key,
      currentAccount: { accountId: head.current_account_id, authorityId: head.current_authority_id, generation: head.current_generation }, plan, targetCount, executionOptions,
      createdAt: head.created_at.toISOString(), resultRevision: safetyInteger(head.result_revision, 1, 2147483647), resultSnapshot: head.result_snapshot, steps });
  }
  private assertStepHeader(head: RuntimeEnrichmentHeadRow, step: EnrichmentRuntimeStepRow): void {
    if (!uuid(step.id) || step.workspace_id !== head.workspace_id || step.company_id !== head.company_id || step.execution_id !== head.id || step.authority_id !== head.authority_id || step.account_id !== head.account_id || step.generation !== head.generation ||
        typeof step.quote_microusd !== "bigint" || step.quote_microusd < 0n || step.quote_microusd > MAX_MICROUSD ||
        (head.status !== "REDACTED" && (step.contact_id === null || !uuid(step.contact_id))) || (step.budget_operation_id !== null && step.budget_operation_id !== step.budget_original_id)) return mismatch();
    if (step.budget_original_id !== null && (!uuid(step.budget_original_id) || step.budget_amount_unit !== "microusd" || step.budget_reserved_microusd !== step.quote_microusd ||
        (step.budget_charged_microusd !== null && (step.budget_charged_microusd < 0n || step.budget_charged_microusd > step.quote_microusd)))) return mismatch();
  }
}


/** Audited DSR redaction in the caller's existing freeze/erase transaction. Never deletes ledger or rewrites funds. */
export async function redactEnrichmentSubject(tx: Prisma.TransactionClient, input: {
  workspaceId: string; subjectType: "contact" | "company"; subjectId: string; deletionRequestId: string;
}): Promise<Readonly<{ headsRedacted: number; stepsRedacted: number }>> {
  if (!uuid(input.workspaceId) || !uuid(input.subjectId) || !uuid(input.deletionRequestId) || (input.subjectType !== "contact" && input.subjectType !== "company")) throw new EnrichmentSafetyError("INVALID_PLAN");
  const heads = await tx.$queryRaw<{ redacted: number }[]>`UPDATE public.contact_enrichment_execution
    SET target_snapshot='[]'::jsonb,status='REDACTED',
        result_snapshot=jsonb_build_object(
          'version',1,
          'targetCount',LEAST(10,GREATEST(0,COALESCE(NULLIF(frozen_limits->>'targetCount','')::int,jsonb_array_length(target_snapshot),0))),
          'newCandidatePoints',LEAST(10,GREATEST(0,COALESCE(NULLIF(result_snapshot->>'newCandidatePoints','')::int,0))),
          'contacts','[]'::jsonb)
    WHERE workspace_id=${input.workspaceId}::uuid AND ((${input.subjectType}::text='company' AND company_id=${input.subjectId}::uuid) OR (${input.subjectType}::text='contact' AND id IN (SELECT execution_id FROM public.contact_enrichment_execution_step WHERE workspace_id=${input.workspaceId}::uuid AND contact_id=${input.subjectId}::uuid))) RETURNING 1 AS redacted`;
  const steps = await tx.$queryRaw<{ redacted: number }[]>`UPDATE public.contact_enrichment_execution_step
    SET contact_id=NULL,candidate_ref=NULL,input_fingerprint=NULL,domain_state='REDACTED'
    WHERE workspace_id=${input.workspaceId}::uuid AND ((${input.subjectType}::text='company' AND execution_id IN (SELECT id FROM public.contact_enrichment_execution WHERE workspace_id=${input.workspaceId}::uuid AND company_id=${input.subjectId}::uuid)) OR (${input.subjectType}::text='contact' AND contact_id=${input.subjectId}::uuid)) RETURNING 1 AS redacted`;
  return Object.freeze({ headsRedacted: heads.length, stepsRedacted: steps.length });
}


/** Persist the original settled reference on the step index. Parameterized source only; real PG is a separate gate. */
export async function linkEnrichmentStepSettled(tx: Prisma.TransactionClient, input: {
  workspaceId: string; executionId: string; stepId: string; expectedRevision: number;
  operationId: string; reference: import('./enrichment-safety.contract').SettledEnrichmentStepReference;
}): Promise<void> {
  const { version, ...receiptBody } = input.reference.durableReceipt as unknown as Record<string, unknown> & { version?: unknown };
  void version;
  const artifact = input.reference.durableReceipt.resultStrategy === "artifact_reference" ? input.reference.durableReceipt.artifactId : null;
  const expectedArtifact = artifact === null ? null : { artifactId: artifact, operationId: input.operationId };
  const rows = await tx.$queryRaw<Array<{ id: string; revision: number; dispatch_phase: string; budget_operation_id: string | null; operation_key: string | null; result_digest: string | null; receipt: unknown; artifact_reference: unknown }>>`SELECT id::text,revision,dispatch_phase,budget_operation_id::text,operation_key,result_digest,receipt,artifact_reference
    FROM public.contact_enrichment_execution_step
    WHERE workspace_id=${input.workspaceId}::uuid AND execution_id=${input.executionId}::uuid AND id=${input.stepId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.budget_operation_id !== input.operationId || row.operation_key === null) throw new EnrichmentSafetyError("HOLD");
  if (row.dispatch_phase === "RESERVED" || row.dispatch_phase === "RESULT_UNKNOWN") {
    if (row.revision !== input.expectedRevision) throw new EnrichmentSafetyError("HOLD");
    const updated = await tx.$queryRaw<{ id: string }[]>`UPDATE public.contact_enrichment_execution_step
      SET result_digest=${input.reference.resultDigest}, receipt=${canonicalSafetyJson(receiptBody)}::jsonb, artifact_reference=${artifact === null ? null : canonicalSafetyJson(expectedArtifact)}::jsonb, dispatch_phase='SETTLED_WAITING_APPLY', revision=revision+1
      WHERE workspace_id=${input.workspaceId}::uuid AND execution_id=${input.executionId}::uuid AND id=${input.stepId}::uuid
        AND revision=${input.expectedRevision} AND budget_operation_id=${input.operationId}::uuid AND dispatch_phase IN ('RESERVED','RESULT_UNKNOWN') RETURNING id::text`;
    if (updated.length !== 1 || updated[0]?.id !== input.stepId) throw new EnrichmentSafetyError("HOLD");
    return;
  }
  if (row.dispatch_phase === "SETTLED_WAITING_APPLY" || row.dispatch_phase === "SETTLED") {
    if (row.result_digest !== input.reference.resultDigest || canonicalSafetyJson(row.receipt) !== canonicalSafetyJson(receiptBody) || canonicalSafetyJson(row.artifact_reference) !== canonicalSafetyJson(expectedArtifact)) throw new EnrichmentSafetyError("HOLD");
    return;
  }
  throw new EnrichmentSafetyError("HOLD");
}

/** Keep an ambiguous step held without touching money. Parameterized source only. */
export async function markEnrichmentStepHold(tx: Prisma.TransactionClient, input: {
  workspaceId: string; executionId: string; stepId: string; expectedRevision: number;
}): Promise<void> {
  await tx.$queryRaw`UPDATE public.contact_enrichment_execution_step
    SET dispatch_phase='RESULT_UNKNOWN', revision=revision+1
    WHERE workspace_id=${input.workspaceId}::uuid AND execution_id=${input.executionId}::uuid AND id=${input.stepId}::uuid
      AND revision=${input.expectedRevision} AND budget_operation_id IS NOT NULL AND dispatch_phase IN ('RESERVED','RESULT_UNKNOWN')`;
}

/** Company-scoped keyset listing of already admitted heads; SELECT-only. */
export async function listCompanyEnrichmentHeads(database: WorkspaceEnrichmentTransactions, context: { workspaceId: string; companyId: string }, page: {
  limit: number; cursor: { createdAt: string; id: string } | null; businessRunId: string | null; includeStreaming?: boolean;
}): Promise<readonly { id: string; createdAt: string; streaming: boolean }[] | null> {
  if (!uuid(context.workspaceId) || !uuid(context.companyId) || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 10) throw new EnrichmentSafetyError("INVALID_PLAN");
  return database.withWorkspace(context.workspaceId, async (tx) => {
    // A missing/foreign/soft-deleted company is not a legitimate empty result; zero executions for a
    // readable company still is. Both checks share the same RLS-scoped transaction.
    const company = await tx.$queryRaw<{ id: string }[]>`SELECT id::text FROM public.canonical_company
      WHERE id=${context.companyId}::uuid AND workspace_id=${context.workspaceId}::uuid LIMIT 1`;
    if (company.length !== 1) return null;
    // Legacy heads use clock_timestamp() with microseconds. Compare both sources
    // at the millisecond precision carried by the public cursor.
    const rows = await tx.$queryRaw<{ id: string; created_at: Date; streaming: boolean }[]>`
      WITH page_scope AS (
        SELECT ${context.workspaceId}::uuid AS workspace_id, ${context.companyId}::uuid AS company_id,
          ${page.businessRunId}::uuid AS run_id, ${page.cursor?.createdAt ?? null}::timestamptz AS cursor_at,
          ${page.cursor?.id ?? null}::uuid AS cursor_id
      )
      SELECT head.id::text, head.created_at, head.streaming
      FROM (
        SELECT e.id, date_trunc('milliseconds', e.created_at) AS created_at, FALSE AS streaming
        FROM public.contact_enrichment_execution e CROSS JOIN page_scope s
        WHERE e.workspace_id = s.workspace_id AND e.company_id = s.company_id
          AND (s.run_id IS NULL OR e.business_run_id = s.run_id)
          AND e.created_at >= COALESCE(s.cursor_at, '-infinity'::timestamptz)
        UNION ALL
        SELECT j.id, j.contact_enrichment_started_at AS created_at, TRUE AS streaming
        FROM public.discovery_company_job j CROSS JOIN page_scope s
        WHERE ${page.includeStreaming === true}::boolean AND j.workspace_id = s.workspace_id
          AND j.canonical_company_id = s.company_id AND j.contact_enrichment_operation_ref IS NOT NULL
          AND (s.run_id IS NULL OR j.run_id = s.run_id)
          AND j.contact_enrichment_started_at >= COALESCE(s.cursor_at, '-infinity'::timestamptz)
      ) head CROSS JOIN page_scope s
      WHERE s.cursor_at IS NULL OR (head.created_at, head.id) > (s.cursor_at, s.cursor_id)
      ORDER BY head.created_at, head.id LIMIT ${page.limit + 1}`;
    return rows.map((row) => ({ id: row.id, createdAt: row.created_at.toISOString(), streaming: row.streaming }));
  });
}
