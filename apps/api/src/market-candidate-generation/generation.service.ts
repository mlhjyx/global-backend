import {
  Prisma,
  type MarketCandidateGeneration,
  type MarketCandidateGenerationAttempt,
} from "@prisma/client";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import { parseDurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import { applyDomainAckConsumerTransaction } from "../durable-results/domain-ack-consumer-bindings";
import { restoreModelResultFromReplay } from "../durable-results/model-result-replay";
import { modelBudgetOperationKey } from "../model-gateway/model-budget-operation-identity";
import { executeGrantedModelTask } from "../execution-budget/granted-model-task";
import { workspaceExecutionBudgetRequestScope } from "../execution-budget/execution-budget-request-scope";
import { parseExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from "../execution-budget/execution-budget-authority.types";
import { readBudgetOperationResult, type BudgetOperationResultReadback } from "../tools/budget-operation-result";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RequestContext } from "../auth/request-context";
import {
  MarketCandidateGenerationRepository,
  isGenerationSourceLockUnavailable,
  type GenerationConsumptionDecision,
} from "./generation.repository";
import { ExecutionBudgetAuthorityService } from "../execution-budget/execution-budget-authority.service";
import { TOOL_BUDGET_STORE, type BudgetStore } from "../tools/budget-store";
import { MarketCandidateSetsService } from "../market-candidates/market-candidate-sets.service";
import { ModelGateway } from "../model-gateway/model-gateway";
import { getTask } from "../ai-tasks/task-registry";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { GenerateStructuredInput } from "../model-gateway/types";
import { assertModelOutputSchemaCompiles } from "../model-gateway/schema-validate";
import { canonicalDigest } from "../model-runtime/context-engine";
import {
  executeStructuredTaskWithRuntime,
  prepareStructuredTaskRuntimeInput,
} from "../model-runtime/structured-task-runtime-bridge";
import {
  assertGenerationInput,
  normalizeGenerationPrepare,
  type GenerationBasisDescriptors,
  GENERATION_INPUT_SCHEMA,
  generationCanonicalJson,
  invalidGenerationInput,
  type PreparedGenerationBasis,
} from "./generation-basis";
import {
  GENERATION_OUTPUT_SCHEMA,
  generationOutputToDraft,
  type GenerationOutput,
  validateGenerationOutput,
} from "./generation-output";
import type { GenerationContractFingerprints } from "./generation.repository";

export const GENERATION_CONTRACT_VERSION =
  "market-candidate-generation-contract/v1";
export const GENERATION_LOGICAL_CAP_MICROUSD = 800_000n;
const SYSTEM =
  "Produce only bounded market-candidate hypotheses from the supplied structured seller material. Approved seller statements are not independently verified market facts. Preserve unknowns, conflicts, conditions and counter-evidence. Never invent named buyers, people, authoritative facts, approvals, ids, user feedback or rankings. Use only the supplied basis keys. A valid empty result is permitted; unsupported or malformed cards must not be silently dropped.";
const PREFIX =
  "Generate market-candidate hypotheses using the complete canonical structured material below. Declared target markets are seller preferences, not proof. Return only the registered closed JSON output.\n";

function generationTaskInput(
  basis: PreparedGenerationBasis,
): GenerateStructuredInput {
  const task = getTask("market.candidates.generate");
  if (
    !task ||
    !task.inputSchema ||
    task.maxCostCents !== 40 ||
    task.maxOutputTokens !== 16000 ||
    task.timeoutMs !== 180000 ||
    task.allowedTools?.length !== 0 ||
    task.cacheable === true ||
    task.humanGate !== true
  )
    throw new ExecutionControlError(
      "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    );
  assertGenerationInput(basis.inputMaterial, task.inputSchema);
  if (canonicalDigest(basis.inputMaterial) !== basis.inputMaterialDigest)
    invalidGenerationInput();
  assertModelOutputSchemaCompiles(GENERATION_OUTPUT_SCHEMA);
  return {
    task: task.id,
    model: task.model,
    prompt: PREFIX + generationCanonicalJson(basis.inputMaterial),
    system: SYSTEM,
    schema: GENERATION_OUTPUT_SCHEMA,
    maxTokens: task.maxOutputTokens,
    maxCostCents: task.maxCostCents,
    validateOutput: (value) => {
      validateGenerationOutput(value, basis.descriptors);
    },
  };
}

export function prepareGenerationModel(
  basis: PreparedGenerationBasis,
  generationId: string,
  workspaceId: string,
): {
  input: GenerateStructuredInput;
  fingerprints: GenerationContractFingerprints;
  contextDigest: string;
} {
  const input = generationTaskInput(basis);
  const prepared = prepareStructuredTaskRuntimeInput(
    input,
    { workspaceId, correlationId: generationId },
    { contractVersion: GENERATION_CONTRACT_VERSION },
  );
  const inputSchemaDigest = canonicalDigest(GENERATION_INPUT_SCHEMA),
    outputSchemaDigest = canonicalDigest(GENERATION_OUTPUT_SCHEMA);
  const contractDigest = canonicalDigest({
    version: GENERATION_CONTRACT_VERSION,
    system: SYSTEM,
    promptPrefix: PREFIX,
    inputSchemaDigest,
    outputSchemaDigest,
  });
  const promptDigest = canonicalDigest({
    system: input.system,
    user: input.prompt,
  });
  const modelPolicyDigest = canonicalDigest({
    task: input.task,
    model: input.model,
    maxCostCents: input.maxCostCents,
    maxOutputTokens: input.maxTokens,
    timeoutMs: 180000,
    allowedTools: [],
    humanGate: true,
    cacheable: false,
    structuredWireUpperBound: 2,
    logicalCapMicrousd: GENERATION_LOGICAL_CAP_MICROUSD.toString(),
    protocol: prepared.protocol,
    contextDigest: prepared.envelope.digest,
  });
  return {
    input: prepared.boundedInput,
    contextDigest: prepared.envelope.digest,
    fingerprints: {
      contractVersion: GENERATION_CONTRACT_VERSION,
      contractDigest,
      promptDigest,
      inputSchemaDigest,
      outputSchemaDigest,
      modelPolicyDigest,
    },
  };
}

export interface GenerationView {
  generationId: string;
  companyId: string;
  intentId: string;
  intentDigest: string;
  phase: string;
  reasonCode: string | null;
  preparedAt: string;
  updatedAt: string;
  set: { setId: string; revision: 1; documentHash: string } | null;
  execution: {
    operationId: string;
    resultSchema: string;
    resultDigest: string;
    ackId: string;
  } | null;
}

const GENERATION_RESULT_SCHEMA = "market-candidates-generation/v1" as const;
const terminal = (row: MarketCandidateGeneration) =>
  row.phase === "PERSISTED" || row.phase === "NOT_APPLIED";
function unavailable(): never {
  throw new ExecutionControlError("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");
}
function changed(): never {
  throw new ConflictException({
    error: {
      code: "VERSION_CONFLICT",
      message: "生成依据、政策或当前意图已变化",
    },
  });
}
function requester(ctx: RequestContext, row: MarketCandidateGeneration): void {
  if (row.requestedBy !== ctx.userId.toLowerCase())
    throw new ForbiddenException({
      error: {
        code: "SCOPE_REQUIRED",
        message: "只有本次明确意图的请求者可以执行或恢复",
      },
    });
}
function intentBody(body: unknown): string {
  const value = JSON.parse(generationCanonicalJson(body)) as Record<
    string,
    unknown
  >;
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof value.intentDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.intentDigest)
  )
    invalidGenerationInput();
  return value.intentDigest;
}
function frozenSelection(row: MarketCandidateGeneration) {
  return normalizeGenerationPrepare({
    intentId: row.intentId,
    ...(row.sourceSelection as object),
  });
}
function frameMatches(
  row: MarketCandidateGeneration,
  basis: PreparedGenerationBasis,
  frame: ReturnType<typeof prepareGenerationModel>,
): boolean {
  const fields = [
    "contractVersion",
    "contractDigest",
    "promptDigest",
    "inputSchemaDigest",
    "outputSchemaDigest",
    "modelPolicyDigest",
  ] as const;
  return (
    basis.inputMaterialDigest === row.inputMaterialDigest &&
    canonicalDigest(basis.descriptors) ===
      canonicalDigest(row.basisDescriptors) &&
    fields.every((key) => frame.fingerprints[key] === row[key])
  );
}
function bareView(row: MarketCandidateGeneration): GenerationView {
  return {
    generationId: row.id,
    companyId: row.companyId,
    intentId: row.intentId,
    intentDigest: row.intentDigest,
    phase: row.phase,
    reasonCode: row.reasonCode,
    preparedAt: row.preparedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    set: null,
    execution: terminal(row)
      ? {
          operationId: row.executionOperationId!,
          resultSchema: row.resultSchema!,
          resultDigest: row.resultDigest!,
          ackId: row.consumerAckId!,
        }
      : null,
  };
}
function receiptMatches(
  row: MarketCandidateGeneration,
  attempt: MarketCandidateGenerationAttempt,
  receipt: DurableExecutionReceipt,
): boolean {
  return (
    receipt.scopeKey === row.workspaceId &&
    receipt.authorityId === attempt.authorityId &&
    receipt.operationKey === attempt.expectedOperationKey &&
    receipt.resultSchema === GENERATION_RESULT_SCHEMA &&
    receipt.resultStrategy === "typed_projection" &&
    receipt.artifactId === null
  );
}
function storageFailure(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError
  );
}

@Injectable()
export class MarketCandidateGenerationService {
  constructor(
    @Inject(MarketCandidateGenerationRepository)
    private readonly repository: MarketCandidateGenerationRepository,
    @Inject(ExecutionBudgetAuthorityService)
    private readonly authorities: ExecutionBudgetAuthorityService,
    @Inject(TOOL_BUDGET_STORE) private readonly budget: BudgetStore,
    @Inject(MarketCandidateSetsService)
    private readonly sets: MarketCandidateSetsService,
    @Inject(ModelGateway) private readonly gateway: ModelGateway,
  ) {}

  private async present(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
  ): Promise<GenerationView> {
    const view = bareView(row);
    if (!terminal(row)) return view;
    if (
      !(await this.repository.transaction(ctx.workspaceId, (tx) =>
        this.repository.terminalValid(tx, row),
      ))
    )
      unavailable();
    if (row.phase === "NOT_APPLIED") return view;
    const initial = await this.sets.getRevision(ctx, row.setId!, 1);
    if (
      initial.document.setId !== row.setId ||
      initial.document.companyId !== row.companyId ||
      initial.document.revision !== 1
    )
      unavailable();
    return {
      ...view,
      set: {
        setId: row.setId!,
        revision: 1,
        documentHash: initial.documentHash,
      },
    };
  }
  async prepare(
    ctx: RequestContext,
    companyId: string,
    body: unknown,
  ): Promise<GenerationView> {
    const row = await this.repository.prepare(
      ctx,
      companyId,
      body,
      (basis, id) =>
        prepareGenerationModel(basis, id, ctx.workspaceId).fingerprints,
    );
    return this.present(ctx, row);
  }
  async get(
    ctx: RequestContext,
    generationId: string,
  ): Promise<GenerationView> {
    return this.present(ctx, await this.repository.find(ctx, generationId));
  }
  private async active(row: MarketCandidateGeneration) {
    if (!row.activeAttemptId) return null;
    const attempts = await this.repository.transaction(row.workspaceId, (tx) =>
      this.repository.attempts(tx, row),
    );
    const attempt = attempts.find((a) => a.id === row.activeAttemptId);
    if (!attempt) unavailable();
    return attempt;
  }
  private async inspect(
    row: MarketCandidateGeneration,
    attempt: MarketCandidateGenerationAttempt,
  ): Promise<BudgetOperationResultReadback> {
    if (typeof this.budget.readOperationResult !== "function") unavailable();
    return this.budget.readOperationResult({
      scopeKey: row.workspaceId,
      authorityId: attempt.authorityId,
      accountKey: attempt.accountKey,
      accountGeneration: attempt.accountGeneration,
      operationKey: attempt.expectedOperationKey,
      resultSchema: GENERATION_RESULT_SCHEMA,
    });
  }
  private async progress(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
    phase: string,
    reason: string | null,
  ) {
    return this.repository.transaction(ctx.workspaceId, async (tx) => {
      const current = await this.repository.lockGeneration(tx, ctx, row, true);
      if (terminal(current) || current.activeAttemptId !== row.activeAttemptId)
        return current;
      if (current.phase === phase && current.reasonCode === reason) return current;
      const permitted: Readonly<Record<string, readonly string[]>> = {
        PREPARED: ["FAILED"],
        RUNNING: ["RESULT_UNKNOWN", "RESULT_READY", "FAILED"],
        RESULT_UNKNOWN: ["RESULT_READY", "FAILED"],
        RESULT_READY: [],
        FAILED: ["RESULT_READY"],
      };
      if (current.phase !== phase && !permitted[current.phase]?.includes(phase))
        return current;
      return this.repository.progress(tx, current, phase, reason);
    });
  }
  private async preflight(ctx: RequestContext, row: MarketCandidateGeneration) {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        return await this.repository.transaction(
          ctx.workspaceId,
          async (tx) => {
            const current = await this.repository.lockGeneration(tx, ctx, row);
            if (terminal(current)) return null;
            requester(ctx, current);
            const head = await this.repository.head(tx, current);
            if (head?.latestGenerationId !== current.id) changed();
            const basis = await this.repository.loadBasis(
              tx,
              ctx,
              current.companyId,
              frozenSelection(current),
            );
            const frame = prepareGenerationModel(
              basis,
              current.id,
              current.workspaceId,
            );
            if (!frameMatches(current, basis, frame)) changed();
            return { row: current, basis, frame };
          },
        );
      } catch (error) {
        if (!isGenerationSourceLockUnavailable(error)) throw error;
      }
    }
    return changed();
  }
  private async admit(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
    authority: VerifiedExecutionBudgetAuthority,
  ) {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        return await this.repository.transaction(
          ctx.workspaceId,
          async (tx) => {
            // The existing grant/account protocol acquires authority first, before any company/generation locks.
            const binding = parseExecutionBudgetBinding(
              await this.authorities.consumeVerifiedWorkspaceGrantInTransaction(
                authority,
                tx,
              ),
              {
                scopeKey: ctx.workspaceId,
                purpose: "market.candidates.generate",
                subjectType: "market_candidate_generation",
              },
            );
            if (binding.subjectId !== row.id) unavailable();
            const current = await this.repository.lockGeneration(tx, ctx, row);
            requester(ctx, current);
            if (terminal(current))
              throw new ExecutionBudgetGrantError(
                "EXECUTION_BUDGET_GRANT_REUSED",
              );
            if (
              (await this.repository.head(tx, current))?.latestGenerationId !==
              current.id
            )
              changed();
            await this.repository.assertNoForeignRisk(tx, current);
            await this.repository.assertAttemptFamilyClear(tx, current);
            if (current.phase === "RESULT_UNKNOWN") {
              const active = (await this.repository.attempts(tx, current)).find(
                (attempt) => attempt.id === current.activeAttemptId,
              );
              if (!active) unavailable();
              // The existing consume protocol has fenced the old account; inspect inside its locks.
              const previous = await readBudgetOperationResult(tx, {
                scopeKey: current.workspaceId,
                authorityId: active.authorityId,
                accountKey: active.accountKey,
                accountGeneration: active.accountGeneration,
                operationKey: active.expectedOperationKey,
                resultSchema: GENERATION_RESULT_SCHEMA,
              });
              if (previous.status !== "RELEASED") unavailable();
              await this.repository.progress(tx, current, "FAILED", "EXECUTION_REJECTED");
            }
            const basis = await this.repository.loadBasis(
                tx,
                ctx,
                current.companyId,
                frozenSelection(current),
              ),
              frame = prepareGenerationModel(
                basis,
                current.id,
                current.workspaceId,
              );
            if (!frameMatches(current, basis, frame)) changed();
            const operationKey = modelBudgetOperationKey(
              "generateStructured",
              frame.input,
              {
                workspaceId: ctx.workspaceId,
                runId: binding.accountKey,
                correlationId: current.id,
              },
            );
            const admitted = await this.repository.appendAttempt(
              tx,
              current,
              binding,
              operationKey,
            );
            return { ...admitted, binding, frame };
          },
        );
      } catch (error) {
        if (!isGenerationSourceLockUnavailable(error)) throw error;
      }
    }
    return changed();
  }
  async execute(
    ctx: RequestContext,
    generationId: string,
    body: unknown,
    compactJws?: string,
  ): Promise<GenerationView> {
    const digest = intentBody(body),
      row = await this.repository.find(ctx, generationId);
    requester(ctx, row);
    if (digest !== row.intentDigest) changed();
    if (terminal(row)) return this.present(ctx, row);
    if (typeof this.budget.readOperationResult !== "function") unavailable();
    const active = await this.active(row);
    if (active) {
      const prior = await this.inspect(row, active);
      if (
        prior.status === "SETTLED" ||
        prior.status === "SETTLED_NO_RESULT" ||
        prior.status === "RESERVED" ||
        prior.status === "RESULT_UNKNOWN"
      )
        return this.recover(ctx, row.id);
    }
    if (!(await this.preflight(ctx, row))) return this.get(ctx, row.id);
    const scope = workspaceExecutionBudgetRequestScope({
      operation: "POST /market-candidate-generations/:generationId/execute",
      generationId: row.id,
      body: { intentDigest: row.intentDigest },
    });
    const authority = await this.authorities.verifyWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope,
    });
    if (authority.capMicrousd !== GENERATION_LOGICAL_CAP_MICROUSD)
      throw new ExecutionBudgetGrantError(
        "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
      );
    let admitted: Awaited<
      ReturnType<MarketCandidateGenerationService["admit"]>
    >;
    try {
      admitted = await this.admit(ctx, row, authority);
    } catch (error) {
      if (
        error instanceof ExecutionBudgetGrantError &&
        error.code === "EXECUTION_BUDGET_GRANT_REUSED"
      )
        return this.recover(ctx, row.id);
      throw error;
    }
    try {
      const result = await executeGrantedModelTask({
        budgetStore: this.budget,
        binding: admitted.binding,
        durableResultSchema: GENERATION_RESULT_SCHEMA,
        execute: (execution) =>
          executeStructuredTaskWithRuntime(
            this.gateway,
            { ...admitted.frame.input, signal: AbortSignal.timeout(180000) },
            {
              workspaceId: row.workspaceId,
              userId: ctx.userId,
              correlationId: row.id,
              ...execution,
            },
            { contractVersion: GENERATION_CONTRACT_VERSION },
          ),
      });
      if (
        result.durableReceipt &&
        !receiptMatches(
          row,
          admitted.attempt,
          parseDurableExecutionReceipt(result.durableReceipt),
        )
      )
        unavailable();
    } catch (error) {
      const state = await this.inspect(admitted.row, admitted.attempt);
      if (state.status === "NOT_FOUND" || state.status === "RELEASED") {
        const failed = await this.progress(
          ctx,
          admitted.row,
          "FAILED",
          "EXECUTION_REJECTED",
        );
        return this.present(ctx, failed);
      }
      if (
        !storageFailure(error) &&
        error instanceof ExecutionControlError &&
        state.status !== "SETTLED" &&
        state.status !== "SETTLED_NO_RESULT"
      )
        throw error;
    }
    return this.recoverAdmitted(ctx, admitted.row);
  }
  private async recoverAdmitted(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
  ): Promise<GenerationView> {
    // Only an already admitted in-flight call owns this internal audit context.
    const current = await this.repository.transaction(ctx.workspaceId, (tx) =>
      this.repository.readInTransaction(tx, row.id),
    );
    requester(ctx, current);
    const result = await this.recoverRecord(ctx, current);
    // Completing an audit does not restore current domain visibility or return a deleted parent's payload.
    await this.repository.find(ctx, row.id);
    return result;
  }
  private async decision(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    row: MarketCandidateGeneration,
    output: GenerationOutput,
  ): Promise<GenerationConsumptionDecision> {
    const current = await this.repository.lockGeneration(tx, ctx, row, true);
    if (terminal(current)) unavailable();
    const reject = (
      reasonCode: Extract<
        GenerationConsumptionDecision,
        { phase: "NOT_APPLIED" }
      >["reasonCode"],
    ): GenerationConsumptionDecision => ({
      phase: "NOT_APPLIED",
      reasonCode,
      setId: null,
    });
    const head = await this.repository.head(tx, current);
    if (head?.latestGenerationId !== current.id) return reject("SUPERSEDED");
    const anchor = await this.repository.currentAnchor(
      tx,
      ctx,
      current.companyId,
    );
    if (
      (anchor?.id ?? null) !== current.expectedCurrentSetId ||
      (anchor?.currentRevision ?? null) !== current.expectedCurrentRevision
    )
      return reject("VERSION_CONFLICT");
    let basis: PreparedGenerationBasis;
    try {
      basis = await this.repository.loadBasis(
        tx,
        ctx,
        current.companyId,
        frozenSelection(current),
      );
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      )
        return reject("BASIS_UNAVAILABLE");
      throw error;
    }
    if (
      basis.inputMaterialDigest !== current.inputMaterialDigest ||
      canonicalDigest(basis.descriptors) !==
        canonicalDigest(current.basisDescriptors)
    )
      return reject("BASIS_CHANGED");
    if (
      !frameMatches(
        current,
        basis,
        prepareGenerationModel(basis, current.id, current.workspaceId),
      )
    )
      return reject("BASIS_CHANGED");
    const saved = await this.sets.persistInitialInTransaction(
      tx,
      ctx,
      current.companyId,
      generationOutputToDraft(
        output,
        current.basisDescriptors as unknown as GenerationBasisDescriptors,
      ),
      current.id,
    );
    return { phase: "PERSISTED", reasonCode: null, setId: saved.setId };
  }
  private async apply(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
    output: GenerationOutput,
    receipt: DurableExecutionReceipt,
  ) {
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        return await this.repository.transaction(
          ctx.workspaceId,
          async (tx) => {
            const result = await applyDomainAckConsumerTransaction({
              transaction: tx,
              producerId: "market.candidates.generate",
              receipt,
              domainAckKey: row.id,
              domainRevision: "1",
              apply: (transaction) =>
                this.decision(transaction, ctx, row, output),
            });
            if (result.status === "UNRECEIPTED") unavailable();
            if (result.status === "REPLAYED") {
              const terminalRow = await this.repository.readInTransaction(
                tx,
                row.id,
              );
              if (
                !terminal(terminalRow) ||
                terminalRow.consumerAckId !== result.ack.ackId ||
                terminalRow.executionOperationId !== receipt.operationId ||
                terminalRow.resultDigest !== receipt.resultDigest ||
                terminalRow.resultSchema !== receipt.resultSchema
              )
                unavailable();
              return terminalRow;
            }
            if (!result.value) unavailable();
            return this.repository.consumeTerminal(
              tx,
              row,
              result.value,
              receipt,
              result.ack,
            );
          },
        );
      } catch (error) {
        if (!isGenerationSourceLockUnavailable(error)) throw error;
      }
    }
    throw new ConflictException({
      error: {
        code: "VERSION_CONFLICT",
        message: "依据锁繁忙，保留原结果等待恢复",
      },
    });
  }
  async recover(
    ctx: RequestContext,
    generationId: string,
  ): Promise<GenerationView> {
    const row = await this.repository.find(ctx, generationId);
    requester(ctx, row);
    return this.recoverRecord(ctx, row);
  }
  private async recoverRecord(
    ctx: RequestContext,
    row: MarketCandidateGeneration,
  ): Promise<GenerationView> {
    if (terminal(row)) return this.present(ctx, row);
    const attempt = await this.active(row);
    if (!attempt) return this.present(ctx, row);
    const snapshot = await this.inspect(row, attempt);
    if (snapshot.status === "SETTLED_NO_RESULT")
      return this.present(ctx, await this.progress(ctx, row, "FAILED", "EXECUTION_FAILED"));
    if (snapshot.status !== "SETTLED") {
      if (
        snapshot.status === "RESULT_UNKNOWN" ||
        snapshot.status === "RESERVED"
      )
        return this.present(
          ctx,
          await this.progress(ctx, row, "RESULT_UNKNOWN", "RESULT_UNKNOWN"),
        );
      if (snapshot.status === "RELEASED")
        return this.present(
          ctx,
          await this.progress(ctx, row, "FAILED", "EXECUTION_REJECTED"),
        );
      return this.present(ctx, row);
    }
    const receipt = parseDurableExecutionReceipt(snapshot.receipt);
    if (
      !receiptMatches(row, attempt, receipt) ||
      receipt.resultDigest !== snapshot.projection.digest
    )
      unavailable();
    const result = restoreModelResultFromReplay(
      GENERATION_RESULT_SCHEMA,
      snapshot.projection,
    );
    const output = validateGenerationOutput(
      result.data,
      row.basisDescriptors as unknown as GenerationBasisDescriptors,
    );
    const ready = await this.progress(ctx, row, "RESULT_READY", "SAVE_PENDING");
    if (terminal(ready)) return this.present(ctx, ready);
    try {
      return this.present(ctx, await this.apply(ctx, ready, output, receipt));
    } catch (error) {
      if (
        storageFailure(error) ||
        isGenerationSourceLockUnavailable(error) ||
        error instanceof ConflictException
      )
        return this.present(
          ctx,
          await this.progress(ctx, ready, "RESULT_READY", "SAVE_PENDING"),
        );
      throw error;
    }
  }
}
