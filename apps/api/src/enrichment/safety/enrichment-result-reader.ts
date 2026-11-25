import { parseContactEmailFindPayload } from "../../durable-results/artifact/materializers/contact-email-find.materializer";
import { parseContactEmailVerificationResult } from "../../durable-results/contact-email-verification-projections";
import {
  durableReceiptFromLedgerRow,
  requireLedgerProjectionReceipt,
} from "../../tools/budget-operation-result";
import {
  parseBoundEnrichmentStepRow,
  type EnrichmentStepContextRow,
} from "./enrichment-safety.contract";
import type { WorkspaceEnrichmentTransactions } from "./enrichment-execution.repository";
import { parseGenericOperationProjection } from "../../tools/generic-operation-projection";
import { parseDurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import { parseArtifactReference } from "../../durable-results/artifact/artifact-reference.schema";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { isTypedProjectionSchema } from "../../durable-results/durable-result-strategy";
import { CONTACT_EMAIL_VERIFICATION_SCHEMAS } from "../../durable-results/contact-email-verification-projections";
import { ExecutionControlError } from "../../execution-budget/execution-control-error";
import { assertSupportedEnrichmentSlot } from "./enrichment-call-plan";
import { deepFreezeSafety, safetyDigest } from "./enrichment-safety.contract";
import type { SettledEnrichmentStepReference } from "./enrichment-safety.contract";
import type { BudgetStore, BudgetReservation } from "../../tools/budget-store";
import type { GenericOperationArtifactService } from "../../durable-results/artifact/generic-operation-artifact.service";
import type {
  ArtifactMaterializer,
  GenericOperationArtifactReference,
} from "../../durable-results/artifact/artifact.types";
import type { TypedProjectionRegistry } from "../../durable-results/typed-projection.registry";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import type {
  BoundEnrichmentStep,
  OriginalEnrichmentStepReadback,
} from "./enrichment-safety.contract";
export interface EnrichmentResultReadContext {
  readonly workspaceId: string;
  readonly companyId: string;
}
/** The controlled RLS step-to-original-ledger lookup must establish these bindings; this type does not prove SQL origin. */
export interface EnrichmentOriginalResultBinding {
  readonly step: BoundEnrichmentStep;
  readonly redacted: boolean;
  readonly currentAccount: Readonly<{
    accountId: string;
    authorityId: string;
    generation: number;
  }> | null;
  readonly originalOperationId: string | null;
  readonly expectedResultDigest: string | null;
  readonly ledgerStatus:
    "NOT_FOUND" | "RESERVED" | "RELEASED" | "RESULT_UNKNOWN" | "SETTLED";
  readonly artifactReference: GenericOperationArtifactReference | null;
  readonly originalReceipt: DurableExecutionReceipt | null;
  readonly originalReservation: BudgetReservation | null;
}
export interface EnrichmentResultReaderDeps {
  loadBinding(
    stepId: string,
    context: EnrichmentResultReadContext,
  ): Promise<EnrichmentOriginalResultBinding | null>;
  readonly budgets: Pick<BudgetStore, "readOperationResult">;
  readonly projections: TypedProjectionRegistry;
  readonly artifacts?: Pick<
    GenericOperationArtifactService,
    "readVerified" | "recoverUnknown"
  >;
  readonly finderMaterializer?: ArtifactMaterializer<unknown>;
  readonly finderMaterializers?: Readonly<Record<string, ArtifactMaterializer<unknown>>>;
  readonly now?: () => Date;
}
export class EnrichmentResultReader {
  constructor(private readonly deps: EnrichmentResultReaderDeps) {}
  /** Authorized in-memory SMTP protocol replay only, never a public result DTO. */
  async loadOriginalSmtpResult(
    stepId: string,
    context: EnrichmentResultReadContext,
  ): Promise<
    | import("../../tools/tool-contract").ToolResult<
        import("../../tools/builtin-tools").SmtpProbeOutput
      >
    | null
  > {
    try {
      const binding = await this.deps.loadBinding(stepId, context);
      if (
        !this.usable(binding, stepId, context) ||
        binding.step.phase !== "SMTP"
      )
        return null;
      const original = await this.readTypedBound(binding);
      if (original.status !== "SETTLED") return null;
      // The exact original SMTP schema has already passed its registered codec and original receipt binding.
      const restored =
        original.restored as import("../../tools/tool-contract").ToolResult<
          import("../../tools/builtin-tools").SmtpProbeOutput
        >;
      if (restored.costCents !== 0) return null;
      return deepFreezeSafety({
        data: restored.data,
        costCents: 0,
        durableReceipt: original.reference.durableReceipt,
      });
    } catch {
      return null;
    }
  }
  /** Explicit domain-internal materialization; public GET must use only the persisted metadata repository. */
  async materializeForDomain(
    stepId: string,
    context: EnrichmentResultReadContext,
  ): Promise<
    | import("./enrichment-safety.contract").EnrichmentDomainMaterializedResult
    | null
  > {
    try {
      const binding = await this.deps.loadBinding(stepId, context);
      if (
        !this.usable(binding, stepId, context) ||
        binding.ledgerStatus !== "SETTLED"
      )
        return null;
      const step = binding.step;
      if (step.phase === "FINDER") {
        const original = await this.readFinderBound(binding);
        if (!original) return null;
        return deepFreezeSafety({
          phase: "FINDER" as const,
          step,
          reference: original.reference,
          result: parseContactEmailFindPayload(original.materialized),
        });
      }
      const original = await this.readTypedBound(binding);
      if (original.status !== "SETTLED") return null;
      if (step.phase === "SMTP") {
        const restored =
          original.restored as import("../../tools/tool-contract").ToolResult<
            import("../../tools/builtin-tools").SmtpProbeOutput
          >;
        if (restored.costCents !== 0) return null;
        return deepFreezeSafety({
          phase: "SMTP" as const,
          step,
          reference: original.reference,
          result: {
            data: restored.data,
            costCents: 0,
            durableReceipt: original.reference.durableReceipt,
          },
        });
      }
      if (
        step.provider !== "millionverifier" &&
        step.provider !== "emailable" &&
        step.provider !== "zerobounce"
      )
        return null;
      return deepFreezeSafety({
        phase: "VERIFY" as const,
        step,
        reference: original.reference,
        result: parseContactEmailVerificationResult(
          step.provider,
          original.restored,
        ),
      });
    } catch {
      return null;
    }
  }
  async loadEnrichmentStepResult(
    stepId: string,
    context: EnrichmentResultReadContext,
  ): Promise<OriginalEnrichmentStepReadback> {
    try {
      const binding = await this.deps.loadBinding(stepId, context);
      if (!this.usable(binding, stepId, context))
        return { status: "UNAVAILABLE" };
      return await this.loadBound(binding);
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }
  async recoverEnrichmentStepResult(
    stepId: string,
    context: EnrichmentResultReadContext,
    authorizeRecovery: () => Promise<boolean>,
  ): Promise<OriginalEnrichmentStepReadback> {
    try {
      if (
        typeof authorizeRecovery !== "function" ||
        !(await authorizeRecovery())
      )
        return { status: "UNAVAILABLE" };
      const binding = await this.deps.loadBinding(stepId, context);
      if (!this.usable(binding, stepId, context))
        return { status: "UNAVAILABLE" };
      if (
        binding.step.phase !== "FINDER" ||
        binding.ledgerStatus !== "RESULT_UNKNOWN"
      )
        return await this.loadBound(binding);
      const reservation = binding.originalReservation;
      const step = binding.step;
      if (
        !this.deps.artifacts ||
        !this.finderMaterializerFor("contact-email-find-" + step.provider + "/v1") ||
        !reservation ||
        reservation.workspaceId !== step.workspaceId ||
        reservation.accountKey !== step.accountKey ||
        reservation.authorityId !== step.authorityId ||
        reservation.operationId !== binding.originalOperationId ||
        reservation.estimatedMicrousd !== BigInt(step.quoteMicrousd)
      )
        return { status: "UNAVAILABLE" };
      const recovered = await this.deps.artifacts.recoverUnknown({
        reservation,
        authorityId: step.authorityId,
        observedMicrousd: reservation.estimatedMicrousd,
        subjectRef: { subjectType: "contact", subjectId: step.contactId },
      });
      if (
        binding.expectedResultDigest !== null &&
        binding.expectedResultDigest !== recovered.durableReceipt.resultDigest
      )
        return { status: "UNAVAILABLE" };
      // Only the old unknown snapshot/settlement protocol. No grant, account open, reserve or execution port exists here.
      return await this.loadFinder({
        ...binding,
        ledgerStatus: "SETTLED",
        artifactReference: recovered.reference,
        originalReceipt: recovered.durableReceipt,
        expectedResultDigest: recovered.durableReceipt.resultDigest,
      });
    } catch {
      return { status: "UNAVAILABLE" };
    }
  }
  private usable(
    binding: EnrichmentOriginalResultBinding | null,
    stepId: string,
    context: EnrichmentResultReadContext,
  ): binding is EnrichmentOriginalResultBinding {
    if (!binding || binding.redacted) return false;
    const step = binding.step;
    const account = binding.currentAccount;
    if (
      step.stepId !== stepId ||
      step.workspaceId !== context.workspaceId ||
      step.companyId !== context.companyId ||
      ![
        stepId,
        step.workspaceId,
        step.companyId,
        step.contactId,
        step.authorityId,
        step.accountId,
      ].every(isCanonicalArtifactUuid) ||
      !Number.isSafeInteger(step.generation) ||
      step.generation < 1
    )
      return false;
    assertSupportedEnrichmentSlot(step);
    if (
      !account ||
      account.accountId !== step.accountId ||
      account.authorityId !== step.authorityId ||
      account.generation !== step.generation
    )
      return false;
    if (
      binding.originalOperationId !== null &&
      !isCanonicalArtifactUuid(binding.originalOperationId)
    )
      return false;
    if (
      step.budgetOperationId !== null &&
      step.budgetOperationId !== binding.originalOperationId
    )
      return false;
    // No open/expiry/current-time attestation for typed cold reads. Current generation must still match exactly.
    return true;
  }
  private async loadBound(
    binding: EnrichmentOriginalResultBinding,
  ): Promise<OriginalEnrichmentStepReadback> {
    if (binding.step.phase === "FINDER") {
      if (
        binding.ledgerStatus === "NOT_FOUND" &&
        binding.originalOperationId === null &&
        binding.step.budgetOperationId === null
      )
        return { status: "NOT_FOUND" };
      if (binding.ledgerStatus !== "SETTLED") return { status: "PENDING" };
      return this.loadFinder(binding);
    }
    const result = await this.readTypedBound(binding);
    return result.status === "SETTLED"
      ? { status: "SETTLED", reference: result.reference }
      : result;
  }
  private async readTypedBound(
    binding: EnrichmentOriginalResultBinding,
  ): Promise<
    | Readonly<{ status: "NOT_FOUND" | "PENDING" | "UNAVAILABLE" }>
    | Readonly<{
        status: "SETTLED";
        reference: SettledEnrichmentStepReference;
        restored: unknown;
      }>
  > {
    const step = binding.step;
    const schema =
      step.phase === "SMTP"
        ? "smtp-probe-verdict/v1"
        : step.provider === "millionverifier"
          ? CONTACT_EMAIL_VERIFICATION_SCHEMAS.millionverifier
          : step.provider === "emailable"
            ? CONTACT_EMAIL_VERIFICATION_SCHEMAS.emailable
            : step.provider === "zerobounce"
              ? CONTACT_EMAIL_VERIFICATION_SCHEMAS.zerobounce
              : null;
    if (
      !schema ||
      !isTypedProjectionSchema(schema) ||
      !this.deps.projections.has(schema) ||
      !this.deps.budgets.readOperationResult
    )
      return { status: "UNAVAILABLE" };
    const read = await this.deps.budgets.readOperationResult({
      scopeKey: step.workspaceId,
      authorityId: step.authorityId,
      accountKey: step.accountKey,
      accountGeneration: step.generation,
      operationKey: step.operationKey,
      resultSchema: schema,
    });
    if (read.status !== "SETTLED")
      return {
        status:
          read.status === "NOT_FOUND" &&
          binding.originalOperationId === null &&
          step.budgetOperationId === null &&
          binding.ledgerStatus === "NOT_FOUND"
            ? "NOT_FOUND"
            : "PENDING",
      };
    const projection = parseGenericOperationProjection(read.projection);
    if (projection.kind !== "tool" || projection.schema !== schema)
      return { status: "UNAVAILABLE" };
    const receipt = this.receipt(
      binding,
      read.receipt,
      schema,
      "typed_projection",
    );
    if (
      receipt.resultDigest !== projection.digest ||
      receipt.artifactId !== null
    )
      return { status: "UNAVAILABLE" };
    const restored = this.deps.projections.restore(projection.data);
    return {
      status: "SETTLED",
      reference: this.reference(step, receipt),
      restored,
    };
  }
  private finderMaterializerFor(schema: string) {
    if (this.deps.finderMaterializers && schema in this.deps.finderMaterializers) {
      const m = this.deps.finderMaterializers[schema];
      if (m?.resultSchema === schema) return m;
    }
    if (this.deps.finderMaterializer?.resultSchema === schema) {
      return this.deps.finderMaterializer;
    }
    return null;
  }
  private async loadFinder(
    binding: EnrichmentOriginalResultBinding,
  ): Promise<OriginalEnrichmentStepReadback> {
    const result = await this.readFinderBound(binding);
    return result
      ? { status: "SETTLED", reference: result.reference }
      : { status: "UNAVAILABLE" };
  }
  private async readFinderBound(
    binding: EnrichmentOriginalResultBinding,
  ): Promise<{
    reference: SettledEnrichmentStepReference;
    materialized: unknown;
  } | null> {
    const step = binding.step;
    const expectedSchema = "contact-email-find-" + step.provider + "/v1";
    const materializer = this.finderMaterializerFor(expectedSchema);
    if (
      !this.deps.artifacts ||
      !materializer ||
      !binding.artifactReference ||
      !binding.originalReceipt
    )
      return null;
    const reference = parseArtifactReference(binding.artifactReference);
    const receipt = this.receipt(
      binding,
      binding.originalReceipt,
      expectedSchema,
      "artifact_reference",
    );
    if (
      reference.resultSchema !== receipt.resultSchema ||
      reference.operationId !== receipt.operationId ||
      reference.artifactId !== receipt.artifactId ||
      reference.sha256 !== receipt.resultDigest
    )
      return null;
    const verified = await this.deps.artifacts.readVerified({
      scopeKind: "workspace",
      workspaceId: step.workspaceId,
      authorityId: step.authorityId,
      reference,
    });
    const manifest = verified.manifest;
    const now = (this.deps.now ?? (() => new Date()))();
    if (
      !Number.isFinite(now.getTime()) ||
      manifest.scopeKind !== "workspace" ||
      manifest.workspaceId !== step.workspaceId ||
      manifest.authorityId !== step.authorityId ||
      manifest.operationId !== reference.operationId ||
      manifest.artifactId !== reference.artifactId ||
      manifest.resultSchema !== reference.resultSchema ||
      manifest.sha256 !== reference.sha256 ||
      manifest.sizeBytes !== reference.sizeBytes ||
      manifest.mediaType !== "application/octet-stream" ||
      manifest.privacyClass !== "PERSONAL_DATA" ||
      manifest.expiresAt !== reference.expiresAt ||
      !Number.isFinite(Date.parse(manifest.expiresAt)) ||
      Date.parse(manifest.expiresAt) <= now.getTime() ||
      verified.expectedFacts !== undefined
    )
      return null;
    const materialized = await materializer.materialize(
      verified.body,
      manifest,
      verified.expectedFacts,
    );
    // Consume the original verifying stream to its terminal check. Never return object keys or provider/PII content.
    for await (const chunk of verified.body) {
      void chunk;
    }
    return { reference: this.reference(step, receipt), materialized };
  }
  private receipt(
    binding: EnrichmentOriginalResultBinding,
    value: unknown,
    schema: string,
    strategy: "typed_projection" | "artifact_reference",
  ): DurableExecutionReceipt {
    const step = binding.step;
    const receipt = parseDurableExecutionReceipt(value);
    if (
      receipt.scopeKey !== step.workspaceId ||
      receipt.authorityId !== step.authorityId ||
      receipt.accountId !== step.accountId ||
      receipt.operationKey !== step.operationKey ||
      receipt.resultSchema !== schema ||
      receipt.resultStrategy !== strategy ||
      (binding.originalOperationId !== null &&
        receipt.operationId !== binding.originalOperationId) ||
      (step.budgetOperationId !== null &&
        receipt.operationId !== step.budgetOperationId) ||
      (binding.expectedResultDigest !== null &&
        receipt.resultDigest !== binding.expectedResultDigest) ||
      receipt.usage.upperBoundMicrousd !== step.quoteMicrousd
    )
      throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
    return receipt;
  }
  private reference(
    step: BoundEnrichmentStep,
    receipt: DurableExecutionReceipt,
  ): SettledEnrichmentStepReference {
    return deepFreezeSafety({
      stepId: step.stepId,
      producerId: step.toolId,
      resultSchema: receipt.resultSchema,
      resultDigest: safetyDigest(receipt.resultDigest),
      durableReceipt: receipt,
    });
  }
}

interface OriginalEnrichmentBindingRow extends EnrichmentStepContextRow {
  current_account_id: string;
  current_authority_id: string;
  current_generation: number;
  original_operation_id: string | null;
  original_scope_key: string | null;
  original_account_id: string | null;
  original_generation: number | null;
  original_operation_key: string | null;
  ledger_status: string | null;
  amount_unit: string | null;
  reserved_microusd: bigint | null;
  result_schema_version: string | null;
  result_schema: string | null;
  result_digest: string | null;
  result_json: unknown;
  receipt_usage: unknown;
  receipt_cost_basis: string | null;
}
/** Parameterized scoped SELECT port only. Private fake tests do not establish actual SQL/RLS/immutability. */
export class EnrichmentOriginalResultRepository {
  constructor(private readonly transactions: WorkspaceEnrichmentTransactions) {}
  async loadBinding(
    stepId: string,
    context: EnrichmentResultReadContext,
  ): Promise<EnrichmentOriginalResultBinding | null> {
    try {
      if (
        ![stepId, context.workspaceId, context.companyId].every(
          isCanonicalArtifactUuid,
        )
      )
        return null;
      return await this.transactions.withWorkspace(
        context.workspaceId,
        async (tx) => {
          const rows = await tx.$queryRaw<OriginalEnrichmentBindingRow[]>`SELECT
          s.id::text,s.workspace_id::text,s.execution_id::text,s.contact_id::text,s.contact_ordinal,s.slot_key,s.phase,s.provider,s.tool_id,s.tool_version,
          s.quote_microusd,s.pricing_version,s.depends_on_slot_key,s.input_fingerprint,s.operation_key,s.budget_operation_id::text,s.candidate_ref,s.revision,s.dispatch_phase,s.domain_state,
          e.company_id::text,e.authority_id::text,e.account_id::text,e.generation,a.account_key,e.status AS execution_status,FALSE AS deadline_open,
          a.id::text AS current_account_id,a.authority_id::text AS current_authority_id,a.generation AS current_generation,
          o.id::text AS original_operation_id,o.scope_key AS original_scope_key,o.account_id::text AS original_account_id,o.generation AS original_generation,
          o.operation_key AS original_operation_key,o.status::text AS ledger_status,o.amount_unit,o.reserved_microusd,
          o.result_schema_version,o.result_schema,o.result_digest,o.result_json,o.receipt_usage,o.receipt_cost_basis
          FROM public.contact_enrichment_execution_step s
          JOIN public.contact_enrichment_execution e ON e.workspace_id=s.workspace_id AND e.id=s.execution_id
          JOIN public.tool_budget_account a ON a.scope_key=e.workspace_id::text AND a.id=e.account_id
          LEFT JOIN public.tool_budget_operation o ON o.scope_key=e.workspace_id::text AND o.account_id=e.account_id AND o.generation=e.generation AND o.operation_key=s.operation_key
          WHERE s.workspace_id=${context.workspaceId}::uuid AND e.company_id=${context.companyId}::uuid AND s.id=${stepId}::uuid`;
          if (rows.length !== 1 || !rows[0]) return null;
          const row = rows[0];
          if (
            row.id !== stepId ||
            row.workspace_id !== context.workspaceId ||
            row.company_id !== context.companyId ||
            row.contact_id === null ||
            row.execution_status === "REDACTED" ||
            row.domain_state === "REDACTED" ||
            row.dispatch_phase === "REDACTED"
          )
            return null;
          const step = parseBoundEnrichmentStepRow(row);
          assertSupportedEnrichmentSlot(step);
          if (
            row.current_account_id !== step.accountId ||
            !isCanonicalArtifactUuid(row.current_authority_id) ||
            !Number.isSafeInteger(row.current_generation) ||
            row.current_generation < 1
          )
            return null;
          const base = {
            step,
            redacted: false,
            currentAccount: {
              accountId: row.current_account_id,
              authorityId: row.current_authority_id,
              generation: row.current_generation,
            },
          };
          if (row.original_operation_id === null) {
            if (step.budgetOperationId !== null) return null;
            return deepFreezeSafety({
              ...base,
              originalOperationId: null,
              expectedResultDigest: null,
              ledgerStatus: "NOT_FOUND" as const,
              artifactReference: null,
              originalReceipt: null,
              originalReservation: null,
            });
          }
          if (!this.operationMatches(row, step)) return null;
          const status = row.ledger_status;
          if (
            status !== "RESERVED" &&
            status !== "RELEASED" &&
            status !== "RESULT_UNKNOWN" &&
            status !== "SETTLED"
          )
            return null;
          const expectedSchema =
            step.phase === "FINDER"
              ? "contact-email-find-" + step.provider + "/v1"
              : step.phase === "SMTP"
                ? "smtp-probe-verdict/v1"
                : "contact-email-verify-" + step.provider + "/v1";
          if (
            row.result_schema !== null &&
            row.result_schema !== expectedSchema
          )
            return null;
          let artifactReference: GenericOperationArtifactReference | null =
              null,
            originalReceipt: DurableExecutionReceipt | null = null;
          if (status === "SETTLED" && row.result_schema_version !== null) {
            if (step.phase === "FINDER") {
              artifactReference = parseArtifactReference(row.result_json);
              originalReceipt =
                durableReceiptFromLedgerRow({
                  scopeKey: step.workspaceId,
                  operationId: row.original_operation_id,
                  operationKey: step.operationKey,
                  accountId: step.accountId,
                  authorityId: step.authorityId,
                  resultSchemaVersion: row.result_schema_version,
                  resultSchema: row.result_schema,
                  resultDigest: row.result_digest,
                  resultJson: row.result_json,
                  receiptUsage: row.receipt_usage,
                  receiptCostBasis: row.receipt_cost_basis,
                }) ?? null;
              if (
                !originalReceipt ||
                artifactReference.operationId !== row.original_operation_id ||
                artifactReference.resultSchema !== expectedSchema ||
                artifactReference.sha256 !== row.result_digest
              )
                return null;
            } else {
              const projection = parseGenericOperationProjection(
                row.result_json,
              );
              if (
                projection.kind !== "tool" ||
                projection.schema !== expectedSchema
              )
                return null;
              originalReceipt = requireLedgerProjectionReceipt({
                scopeKey: step.workspaceId,
                expectedOperationId: row.original_operation_id,
                operationId: row.original_operation_id,
                operationKey: step.operationKey,
                accountId: step.accountId,
                authorityId: step.authorityId,
                resultSchemaVersion: row.result_schema_version,
                resultSchema: row.result_schema,
                resultDigest: row.result_digest,
                resultJson: row.result_json,
                receiptUsage: row.receipt_usage,
                receiptCostBasis: row.receipt_cost_basis,
                expectedProjection: projection,
              });
            }
            if (
              originalReceipt.usage.upperBoundMicrousd !== step.quoteMicrousd ||
              originalReceipt.resultSchema !== expectedSchema
            )
              return null;
          }
          return deepFreezeSafety({
            ...base,
            originalOperationId: row.original_operation_id,
            expectedResultDigest:
              row.result_digest === null
                ? null
                : safetyDigest(row.result_digest),
            ledgerStatus: status,
            artifactReference,
            originalReceipt,
            originalReservation: {
              workspaceId: step.workspaceId,
              accountKey: step.accountKey,
              operationId: row.original_operation_id,
              estimatedMicrousd: BigInt(step.quoteMicrousd),
              authorityId: step.authorityId,
              replay: true,
            },
          });
        },
      );
    } catch {
      return null;
    }
  }
  private operationMatches(
    row: OriginalEnrichmentBindingRow,
    step: BoundEnrichmentStep,
  ): boolean {
    return (
      isCanonicalArtifactUuid(row.original_operation_id) &&
      row.original_scope_key === step.workspaceId &&
      row.original_account_id === step.accountId &&
      row.original_generation === step.generation &&
      row.original_operation_key === step.operationKey &&
      row.amount_unit === "microusd" &&
      row.reserved_microusd === BigInt(step.quoteMicrousd) &&
      (step.budgetOperationId === null ||
        step.budgetOperationId === row.original_operation_id)
    );
  }
}
