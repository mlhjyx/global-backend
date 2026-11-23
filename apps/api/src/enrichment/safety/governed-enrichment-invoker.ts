import type {
  SmtpProbeInput,
  SmtpProbeOutput,
} from "../../tools/builtin-tools";
import type { ToolContext, ToolResult } from "../../tools/tool-contract";
import { originalSmtpBudgetOperationKey } from "../../tools/contact-enrichment-safety-tools";
import { smtpPhysicalInputFingerprint } from "./enrichment-target-snapshot";
import { TypedProjectionRegistry } from "../../durable-results/typed-projection.registry";
import { SOURCE_RESULT_PROJECTION_DEFINITIONS } from "../../durable-results/source-result-projections";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../../execution-budget/execution-control-error";
import { parseDurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import {
  ExternalToolActionDeniedError,
  isTerminalExternalActionPolicyDenied,
} from "../../tools/tool-contract";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { assertSupportedEnrichmentSlot } from "./enrichment-call-plan";
import {
  canonicalSafetyJson,
  closedSafetyRecord,
  deepFreezeSafety,
  parseQuotedEnrichmentSlot,
  parseEnrichmentCandidateRef,
  safetyDigest,
} from "./enrichment-safety.contract";
import type { ExecutionBroker } from "../../tools/tool-contract";
import type {
  BoundEnrichmentStep,
  OriginalEnrichmentStepReadback,
  SettledEnrichmentStepReference,
} from "./enrichment-safety.contract";
export interface TrustedEnrichmentExecutionContext {
  readonly workspaceId: string;
  readonly companyId: string;
  readonly authorizeExternalAction: () => Promise<boolean>;
}
export interface EnrichmentStepExecutionState {
  readonly step: BoundEnrichmentStep;
  readonly dispatchPhase:
    | "ADMITTED"
    | "RESERVED"
    | "RESULT_UNKNOWN"
    | "SETTLED_WAITING_APPLY"
    | "SETTLED"
    | "RELEASED"
    | "REDACTED";
  readonly domainState: "PENDING" | "SAVE_PENDING" | "APPLIED" | "REDACTED";
}
/** Existing original-ledger/result and narrow metadata ports only, never a second budget store. */
export interface GovernedEnrichmentInvokerDeps {
  readonly broker: ExecutionBroker;
  readSmtpResult?(
    step: BoundEnrichmentStep,
    reference: SettledEnrichmentStepReference,
  ): Promise<
    | import("../../tools/tool-contract").ToolResult<
        import("../../tools/builtin-tools").SmtpProbeOutput
      >
    | null
  >;

  loadCurrentStep(
    stepId: string,
    context: TrustedEnrichmentExecutionContext,
  ): Promise<EnrichmentStepExecutionState>;
  readOriginalResult(
    step: BoundEnrichmentStep,
  ): Promise<OriginalEnrichmentStepReadback>;
  claimBeforePhysicalWire(
    step: BoundEnrichmentStep,
  ): Promise<BoundEnrichmentStep>;
  linkSettledReference(
    step: BoundEnrichmentStep,
    reference: SettledEnrichmentStepReference,
  ): Promise<void>;
  hold(
    step: BoundEnrichmentStep,
    reason: "PRE_WIRE_HOLD" | "PENDING_OR_UNKNOWN",
  ): Promise<void>;
}
export class GovernedEnrichmentInvoker {
  constructor(private readonly deps: GovernedEnrichmentInvokerDeps) {}
  /** Proxy used only by the original SmtpProbeProvider, never a second producer or consumer. */
  createStepBoundSmtpBroker(
    step: BoundEnrichmentStep,
    context: TrustedEnrichmentExecutionContext,
  ): ExecutionBroker {
    this.assertContext(step, context);
    if (step.phase !== "SMTP") this.mismatch();
    let attempted = false;
    return {
      checkSourcePolicy: async (toolId, domain, purpose) => {
        if (toolId !== "smtp.rcpt_probe") this.mismatch();
        return this.deps.broker.checkSourcePolicy(toolId, domain, purpose);
      },
      invoke: async <I, O>(
        toolId: string,
        input: I,
        caller: ToolContext,
      ): Promise<ToolResult<O>> => {
        if (attempted) this.holdError();
        attempted = true;
        const source = closedSafetyRecord(caller, [
          "workspaceId",
          "runId",
          "correlationId",
          "authorizeExternalAction",
        ]);
        const originalInput = this.checkedSmtpInput(step, input);
        if (
          toolId !== "smtp.rcpt_probe" ||
          source.workspaceId !== step.workspaceId ||
          source.runId !== step.accountKey ||
          source.correlationId !== "smtp-probe:" + originalInput.domain ||
          source.authorizeExternalAction !== context.authorizeExternalAction
        )
          this.mismatch();
        const outcome = await this.invokeBound(step, context, originalInput);
        const result =
          outcome.toolResult ??
          (await this.deps.readSmtpResult?.(step, outcome.reference));
        if (!result) this.holdError();
        return this.smtpResult(result, outcome.reference) as ToolResult<O>;
      },
    };
  }
  async invoke(
    step: BoundEnrichmentStep,
    context: TrustedEnrichmentExecutionContext,
  ): Promise<SettledEnrichmentStepReference> {
    return (await this.invokeBound(step, context)).reference;
  }
  private async invokeBound(
    step: BoundEnrichmentStep,
    context: TrustedEnrichmentExecutionContext,
    originalSmtpInput?: SmtpProbeInput,
  ): Promise<{
    reference: SettledEnrichmentStepReference;
    toolResult?: ToolResult<unknown>;
  }> {
    this.assertContext(step, context);
    let current = step;
    let callbackAttempts = 0;
    let claimed: BoundEnrichmentStep | null = null;
    let callbackFailure: unknown;
    try {
      const state = await this.deps.loadCurrentStep(step.stepId, context);
      current = state.step;
      if (this.identity(current) !== this.identity(step)) this.mismatch();
      if (
        state.dispatchPhase === "REDACTED" ||
        state.domainState === "REDACTED"
      )
        throw new ExecutionControlError(
          "GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID",
        );
      if (!(await context.authorizeExternalAction()))
        throw new ExternalToolActionDeniedError();
      const original = await this.deps.readOriginalResult(current);
      if (original.status === "SETTLED") {
        const reference = this.reference(current, original.reference);
        await this.deps.linkSettledReference(current, reference);
        return { reference };
      }
      if (
        original.status !== "NOT_FOUND" ||
        state.dispatchPhase !== "ADMITTED" ||
        state.domainState !== "PENDING" ||
        current.budgetOperationId !== null
      )
        this.holdError();
      // SMTP keeps the exact original provider-generated input and key, never a step-only rewrite.
      if (current.phase === "SMTP" && !originalSmtpInput) this.holdError();
      const physicalInput =
        current.phase === "SMTP"
          ? this.checkedSmtpInput(current, originalSmtpInput)
          : { stepId: current.stepId };
      const beforePhysicalWire = async (): Promise<void> => {
        callbackAttempts += 1;
        try {
          if (callbackAttempts !== 1) this.holdError();
          if (!(await context.authorizeExternalAction()))
            throw new ExternalToolActionDeniedError();
          const candidate = await this.deps.claimBeforePhysicalWire(current);
          if (
            this.identity(candidate) !== this.identity(current) ||
            !isCanonicalArtifactUuid(candidate.budgetOperationId) ||
            candidate.revision !== current.revision + 1
          )
            this.mismatch();
          claimed = candidate; // Port resolved only after its short transaction committed; no network transaction here.
        } catch (error) {
          callbackFailure = error;
          throw error;
        }
      };
      const result = await this.deps.broker.invoke(
        current.toolId,
        physicalInput,
        {
          workspaceId: current.workspaceId,
          runId: current.accountKey,
          purpose: "enrichment",
          artifactSubject: {
            subjectType: "contact",
            subjectId: current.contactId,
          },
          authorizeExternalAction: context.authorizeExternalAction,
          beforePhysicalWire,
        },
      );
      if (callbackFailure !== undefined) throw callbackFailure;
      if (callbackAttempts !== 1 || claimed === null) this.holdError();
      const receipt = this.parseReceipt(result.durableReceipt);
      const reference = this.reference(claimed, {
        stepId: current.stepId,
        producerId: current.toolId,
        resultSchema: receipt.resultSchema,
        resultDigest: receipt.resultDigest,
        durableReceipt: receipt,
      });
      await this.deps.linkSettledReference(claimed, reference);
      return { reference, toolResult: result };
    } catch (error) {
      try {
        await this.deps.hold(
          current,
          claimed !== null || callbackAttempts > 0
            ? "PENDING_OR_UNKNOWN"
            : "PRE_WIRE_HOLD",
        );
      } catch {
        /* Metadata ACK failure cannot authorize another purchase or alter the original spend. */
      }
      if (
        isExecutionControlError(error) ||
        isTerminalExternalActionPolicyDenied(error)
      )
        throw error;
      return this.holdError();
    }
  }
  private checkedSmtpInput(
    step: BoundEnrichmentStep,
    value: unknown,
  ): SmtpProbeInput {
    if (step.phase !== "SMTP" || step.candidateRef === null) this.mismatch();
    parseEnrichmentCandidateRef(step.candidateRef);
    const originalInput = value as SmtpProbeInput;
    if (
      smtpPhysicalInputFingerprint({
        workspaceId: step.workspaceId,
        contactId: step.contactId,
        originalInput,
      }) !== step.inputFingerprint ||
      originalSmtpBudgetOperationKey(
        step.accountKey,
        originalInput,
        step.toolVersion,
      ) !== step.operationKey
    )
      this.mismatch();
    return deepFreezeSafety({
      domain: originalInput.domain,
      mxHost: originalInput.mxHost,
      rcptTo: [...originalInput.rcptTo],
    });
  }
  private smtpResult(
    value: unknown,
    reference: SettledEnrichmentStepReference,
  ): ToolResult<SmtpProbeOutput> {
    const row = closedSafetyRecord(value, [
      "data",
      "costCents",
      "durableReceipt",
    ]);
    const receipt = this.parseReceipt(row.durableReceipt);
    if (
      row.costCents !== 0 ||
      canonicalSafetyJson(receipt) !==
        canonicalSafetyJson(reference.durableReceipt)
    )
      this.mismatch();
    const definition = SOURCE_RESULT_PROJECTION_DEFINITIONS.find(
      (entry) => entry.schema === "smtp-probe-verdict/v1",
    );
    if (!definition) this.holdError();
    const registry = new TypedProjectionRegistry().register(definition);
    const projection = registry.project("smtp-probe-verdict/v1", {
      data: row.data,
      costCents: row.costCents,
    });
    const restored = registry.restore(
      projection,
    ) as ToolResult<SmtpProbeOutput>;
    return deepFreezeSafety({
      data: restored.data,
      costCents: 0,
      durableReceipt: receipt,
    });
  }
  private holdError(): never {
    throw new ExecutionControlError("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
  }
  private mismatch(): never {
    throw new ExecutionControlError(
      "DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH",
    );
  }
  private assertContext(
    step: BoundEnrichmentStep,
    context: TrustedEnrichmentExecutionContext,
  ): void {
    try {
      const row = closedSafetyRecord(context, [
        "workspaceId",
        "companyId",
        "authorizeExternalAction",
      ]);
      if (
        row.workspaceId !== step.workspaceId ||
        row.companyId !== step.companyId ||
        typeof row.authorizeExternalAction !== "function"
      )
        this.mismatch();
      this.identity(step);
    } catch {
      return this.mismatch();
    }
  }
  private identity(step: BoundEnrichmentStep): string {
    const slot = parseQuotedEnrichmentSlot({
      slotKey: step.slotKey,
      contactId: step.contactId,
      contactOrdinal: step.contactOrdinal,
      phase: step.phase,
      provider: step.provider,
      toolId: step.toolId,
      toolVersion: step.toolVersion,
      quoteMicrousd: step.quoteMicrousd,
      pricingVersion: step.pricingVersion,
      dependsOnSlotKey: step.dependsOnSlotKey,
    });
    assertSupportedEnrichmentSlot(slot);
    if (
      ![
        step.stepId,
        step.executionId,
        step.workspaceId,
        step.companyId,
        step.contactId,
        step.authorityId,
        step.accountId,
      ].every(isCanonicalArtifactUuid) ||
      !Number.isSafeInteger(step.generation) ||
      step.generation < 1 ||
      typeof step.accountKey !== "string" ||
      step.accountKey.length < 1 ||
      step.accountKey.length > 200 ||
      typeof step.operationKey !== "string" ||
      !/^[A-Za-z0-9:._/-]{1,200}$/.test(step.operationKey)
    )
      this.mismatch();
    return canonicalSafetyJson({
      ...slot,
      stepId: step.stepId,
      executionId: step.executionId,
      workspaceId: step.workspaceId,
      companyId: step.companyId,
      authorityId: step.authorityId,
      accountId: step.accountId,
      generation: step.generation,
      accountKey: step.accountKey,
      inputFingerprint: safetyDigest(step.inputFingerprint),
      operationKey: step.operationKey,
      candidateRef: step.candidateRef,
    });
  }
  private parseReceipt(value: unknown) {
    try {
      return parseDurableExecutionReceipt(value);
    } catch {
      return this.mismatch();
    }
  }
  private reference(
    step: BoundEnrichmentStep,
    value: unknown,
  ): SettledEnrichmentStepReference {
    try {
      const row = closedSafetyRecord(value, [
        "stepId",
        "producerId",
        "resultSchema",
        "resultDigest",
        "durableReceipt",
      ]);
      const receipt = this.parseReceipt(row.durableReceipt);
      const schema =
        step.phase === "FINDER"
          ? "contact-email-find-hunter/v1"
          : step.phase === "SMTP"
            ? "smtp-probe-verdict/v1"
            : "contact-email-verify-" + step.provider + "/v1";
      if (
        row.stepId !== step.stepId ||
        row.producerId !== step.toolId ||
        row.resultSchema !== schema ||
        row.resultDigest !== receipt.resultDigest ||
        receipt.scopeKey !== step.workspaceId ||
        receipt.authorityId !== step.authorityId ||
        receipt.accountId !== step.accountId ||
        receipt.operationKey !== step.operationKey ||
        receipt.resultSchema !== schema ||
        (step.budgetOperationId !== null &&
          receipt.operationId !== step.budgetOperationId) ||
        receipt.usage.upperBoundMicrousd !== step.quoteMicrousd
      )
        this.mismatch();
      if (
        step.phase === "FINDER"
          ? receipt.resultStrategy !== "artifact_reference" ||
            receipt.artifactId === null
          : receipt.resultStrategy !== "typed_projection" ||
            receipt.artifactId !== null
      )
        this.mismatch();
      return deepFreezeSafety({
        stepId: step.stepId,
        producerId: step.toolId,
        resultSchema: schema,
        resultDigest: receipt.resultDigest,
        durableReceipt: receipt,
      });
    } catch {
      return this.mismatch();
    }
  }
}
