import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import type { DomainAckRecord } from "../durable-results/domain-ack";
import { Prisma, type MarketCandidateGeneration } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestContext } from "../auth/request-context";
import {
  buildGenerationBasis,
  generationCanonicalJson,
  invalidGenerationInput,
  type GenerationPrepareInput,
  type GenerationBasisRows,
  type PreparedGenerationBasis,
} from "./generation-basis";
import { documentHash } from "../market-candidates/market-candidate-set.document";
import {
  normalizeGenerationPrepare,
  type GenerationBasisDescriptors,
} from "./generation-basis";

export interface GenerationIntentMaterial {
  readonly generationId: string;
  readonly workspaceId: string;
  readonly companyId: string;
  readonly requestedBy: string;
  readonly intentId: string;
  readonly intentSequence: string;
  readonly prepareRequestHash: string;
  readonly inputMaterialDigest: string;
  readonly basisDescriptors: GenerationBasisDescriptors;
  readonly contractVersion: string;
  readonly contractDigest: string;
  readonly promptDigest: string;
  readonly inputSchemaDigest: string;
  readonly outputSchemaDigest: string;
  readonly modelPolicyDigest: string;
  readonly expectedCurrentSetId: string | null;
  readonly expectedCurrentRevision: number | null;
}

export function generationIntentDigest(
  material: GenerationIntentMaterial,
): string {
  const {
    generationId,
    workspaceId,
    companyId,
    requestedBy,
    intentId,
    intentSequence,
    prepareRequestHash,
    inputMaterialDigest,
    basisDescriptors,
    contractVersion,
    contractDigest,
    promptDigest,
    inputSchemaDigest,
    outputSchemaDigest,
    modelPolicyDigest,
    expectedCurrentSetId,
    expectedCurrentRevision,
  } = material;
  return documentHash({
    generationId,
    workspaceId,
    companyId,
    requestedBy,
    intentId,
    intentSequence,
    prepareRequestHash,
    inputMaterialDigest,
    basisDescriptors,
    contractVersion,
    contractDigest,
    promptDigest,
    inputSchemaDigest,
    outputSchemaDigest,
    modelPolicyDigest,
    expectedCurrentSetId,
    expectedCurrentRevision,
  });
}

export function generationPrepareRequestHash(body: unknown): string {
  return documentHash(normalizeGenerationPrepare(body));
}

export type GenerationContractFingerprints = Pick<
  GenerationIntentMaterial,
  | "contractVersion"
  | "contractDigest"
  | "promptDigest"
  | "inputSchemaDigest"
  | "outputSchemaDigest"
  | "modelPolicyDigest"
>;

export type GenerationConsumptionDecision =
  | { phase: "PERSISTED"; reasonCode: null; setId: string }
  | {
      phase: "NOT_APPLIED";
      reasonCode:
        | "BASIS_UNAVAILABLE"
        | "BASIS_CHANGED"
        | "SUPERSEDED"
        | "VERSION_CONFLICT";
      setId: null;
    };

type Tx = Prisma.TransactionClient;
const transactionOptions = { maxWait: 20_000, timeout: 30_000 };
const companySelect = {
  id: true,
  workspaceId: true,
  version: true,
  name: true,
  website: true,
  industry: true,
  industryCode: true,
  summary: true,
  targetMarkets: true,
  deletedAt: true,
} as const;
const offeringSelect = {
  id: true,
  workspaceId: true,
  companyId: true,
  name: true,
  description: true,
  attributes: true,
} as const;
const claimSelect = {
  id: true,
  workspaceId: true,
  companyId: true,
  version: true,
  status: true,
  type: true,
  statement: true,
  validUntil: true,
  verifiedAt: true,
  verificationMethod: true,
} as const;

function generationUuid(value: unknown): string {
  if (typeof value !== "string" || !isUUID(value))
    return invalidGenerationInput();
  return value.toLowerCase();
}
function generationContext(ctx: RequestContext): RequestContext {
  if (!ctx || !isUUID(ctx.workspaceId) || !isUUID(ctx.userId))
    throw new ForbiddenException({
      error: {
        code: "AUTH_CONTEXT_MISSING",
        message: "需要可信租户与用户上下文",
      },
    });
  return {
    ...ctx,
    workspaceId: ctx.workspaceId.toLowerCase(),
    userId: ctx.userId.toLowerCase(),
  };
}
function generationNotFound(): never {
  throw new NotFoundException({
    error: { code: "NOT_FOUND", message: "生成意图或公司不可用" },
  });
}
function generationConflict(
  code: "IDEMPOTENCY_CONFLICT" | "VERSION_CONFLICT",
): never {
  throw new ConflictException({
    error: { code, message: "生成意图或依据已变化，请核对原操作" },
  });
}
export function generationRecordIntent(
  row: MarketCandidateGeneration,
): GenerationIntentMaterial {
  return {
    generationId: row.id,
    workspaceId: row.workspaceId,
    companyId: row.companyId,
    requestedBy: row.requestedBy,
    intentId: row.intentId,
    intentSequence: row.intentSequence.toString(),
    prepareRequestHash: row.prepareRequestHash,
    inputMaterialDigest: row.inputMaterialDigest,
    basisDescriptors:
      row.basisDescriptors as unknown as GenerationBasisDescriptors,
    contractVersion: row.contractVersion,
    contractDigest: row.contractDigest,
    promptDigest: row.promptDigest,
    inputSchemaDigest: row.inputSchemaDigest,
    outputSchemaDigest: row.outputSchemaDigest,
    modelPolicyDigest: row.modelPolicyDigest,
    expectedCurrentSetId: row.expectedCurrentSetId,
    expectedCurrentRevision: row.expectedCurrentRevision,
  };
}
function checkedGeneration(
  row: MarketCandidateGeneration,
): MarketCandidateGeneration {
  generationCanonicalJson(row.basisDescriptors);
  if (generationIntentDigest(generationRecordIntent(row)) !== row.intentDigest)
    throw new Error("MARKET_CANDIDATE_GENERATION_INTENT_INTEGRITY");
  return row;
}
export function isGenerationSourceLockUnavailable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2010" &&
    error.meta?.code === "55P03"
  );
}

@Injectable()
export class MarketCandidateGenerationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  transaction<T>(workspaceId: string, run: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.withWorkspace(workspaceId, run, transactionOptions);
  }
  async company(tx: Tx, ctx: RequestContext, companyId: string, write = false) {
    if (write)
      await tx.$queryRaw`SELECT id FROM company_profile WHERE id=${companyId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR UPDATE`;
    const company = await tx.companyProfile.findFirst({
      where: { id: companyId, workspaceId: ctx.workspaceId },
      select: companySelect,
    });
    if (!company || company.deletedAt) return generationNotFound();
    return company;
  }
  async readInTransaction(
    tx: Tx,
    generationId: string,
  ): Promise<MarketCandidateGeneration> {
    const row = await tx.marketCandidateGeneration.findUnique({
      where: { id: generationId },
    });
    if (!row) return generationNotFound();
    return checkedGeneration(row);
  }
  async find(
    ctx: RequestContext,
    generationId: string,
  ): Promise<MarketCandidateGeneration> {
    ctx = generationContext(ctx);
    generationId = generationUuid(generationId);
    return this.transaction(ctx.workspaceId, async (tx) => {
      const row = await this.readInTransaction(tx, generationId);
      await this.company(tx, ctx, row.companyId);
      return row;
    });
  }
  private async selectedRows(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    selection: GenerationPrepareInput,
  ) {
    const where = { workspaceId: ctx.workspaceId, companyId };
    const offerings = await tx.offering.findMany({
      where: {
        ...where,
        ...(selection.offeringIds === undefined
          ? {}
          : { id: { in: selection.offeringIds } }),
      },
      select: offeringSelect,
      orderBy: { id: "asc" },
      take: 201,
    });
    const claims = await tx.claim.findMany({
      where: {
        ...where,
        ...(selection.claimIds === undefined
          ? {
              status: "APPROVED" as const,
              OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
            }
          : { id: { in: selection.claimIds } }),
      },
      select: claimSelect,
      orderBy: { id: "asc" },
      take: 201,
    });
    if (
      selection.offeringIds !== undefined &&
      offerings.length !== selection.offeringIds.length
    )
      invalidGenerationInput();
    if (
      selection.claimIds !== undefined &&
      claims.length !== selection.claimIds.length
    )
      invalidGenerationInput();
    return { offerings, claims };
  }
  async loadBasis(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    selection: GenerationPrepareInput,
  ): Promise<PreparedGenerationBasis> {
    const company = await this.company(tx, ctx, companyId, true);
    const initial = await this.selectedRows(tx, ctx, companyId, selection);
    if (initial.offerings.length + initial.claims.length > 200)
      invalidGenerationInput();
    const references = [
      ...initial.offerings.map((row) => ({ kind: "OFFERING", id: row.id })),
      ...initial.claims.map((row) => ({ kind: "CLAIM", id: row.id })),
    ].sort((a, b) =>
      `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`, "en"),
    );
    for (const source of references) {
      if (source.kind === "CLAIM")
        await tx.$queryRaw`SELECT id FROM claim WHERE id=${source.id}::uuid AND company_id=${companyId}::uuid FOR SHARE NOWAIT`;
      else
        await tx.$queryRaw`SELECT id FROM offering WHERE id=${source.id}::uuid AND company_id=${companyId}::uuid FOR SHARE`;
    }
    const locked = await this.selectedRows(tx, ctx, companyId, {
      ...selection,
      offeringIds: initial.offerings.map((row) => row.id),
      claimIds: initial.claims.map((row) => row.id),
    });
    return buildGenerationBasis({ workspaceId: ctx.workspaceId, companyId }, {
      company,
      ...locked,
    } satisfies GenerationBasisRows);
  }
  currentAnchor(tx: Tx, ctx: RequestContext, companyId: string) {
    return tx.marketCandidateSet.findFirst({
      where: { workspaceId: ctx.workspaceId, companyId },
      select: { id: true, currentRevision: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }
  private async allocate(
    tx: Tx,
    ctx: RequestContext,
    companyId: string,
    selection: GenerationPrepareInput,
    freeze: (
      basis: PreparedGenerationBasis,
      generationId: string,
    ) => GenerationContractFingerprints,
  ) {
    const basis = await this.loadBasis(tx, ctx, companyId, selection),
      id = randomUUID();
    const fingerprints = freeze(basis, id),
      anchor = await this.currentAnchor(tx, ctx, companyId);
    const headKey = { workspaceId: ctx.workspaceId, companyId };
    const head = await tx.marketCandidateGenerationHead.findUnique({
      where: { workspaceId_companyId: headKey },
    });
    const intentSequence = (head?.intentSequence ?? 0n) + 1n;
    const identity: GenerationIntentMaterial = {
      generationId: id,
      workspaceId: ctx.workspaceId,
      companyId,
      requestedBy: ctx.userId,
      intentId: selection.intentId,
      intentSequence: intentSequence.toString(),
      prepareRequestHash: generationPrepareRequestHash(selection),
      inputMaterialDigest: basis.inputMaterialDigest,
      basisDescriptors: basis.descriptors,
      ...fingerprints,
      expectedCurrentSetId: anchor?.id ?? null,
      expectedCurrentRevision: anchor?.currentRevision ?? null,
    };
    const { intentId: _intentId, ...sourceSelection } = selection;
    const row = await tx.marketCandidateGeneration.create({
      data: {
        id,
        workspaceId: ctx.workspaceId,
        companyId,
        requestedBy: ctx.userId,
        intentId: selection.intentId,
        intentSequence,
        prepareRequestHash: identity.prepareRequestHash,
        intentDigest: generationIntentDigest(identity),
        sourceSelection: sourceSelection as Prisma.InputJsonValue,
        basisDescriptors: basis.descriptors as unknown as Prisma.InputJsonValue,
        inputMaterialDigest: basis.inputMaterialDigest,
        ...fingerprints,
        expectedCurrentSetId: identity.expectedCurrentSetId,
        expectedCurrentRevision: identity.expectedCurrentRevision,
      },
    });
    if (head)
      await tx.marketCandidateGenerationHead.update({
        where: { workspaceId_companyId: headKey },
        data: { latestGenerationId: id, intentSequence },
      });
    else
      await tx.marketCandidateGenerationHead.create({
        data: { ...headKey, latestGenerationId: id, intentSequence },
      });
    return checkedGeneration(row);
  }
  async prepare(
    ctx: RequestContext,
    companyId: string,
    body: unknown,
    freeze: (
      basis: PreparedGenerationBasis,
      generationId: string,
    ) => GenerationContractFingerprints,
  ): Promise<MarketCandidateGeneration> {
    ctx = generationContext(ctx);
    companyId = generationUuid(companyId);
    const selection = normalizeGenerationPrepare(body),
      requestHash = generationPrepareRequestHash(selection);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.transaction(ctx.workspaceId, async (tx) => {
          await this.company(tx, ctx, companyId, true);
          const prior = await tx.marketCandidateGeneration.findUnique({
            where: {
              workspaceId_companyId_requestedBy_intentId: {
                workspaceId: ctx.workspaceId,
                companyId,
                requestedBy: ctx.userId,
                intentId: selection.intentId,
              },
            },
          });
          if (prior) {
            if (prior.prepareRequestHash !== requestHash)
              return generationConflict("IDEMPOTENCY_CONFLICT");
            return checkedGeneration(prior);
          }
          return this.allocate(tx, ctx, companyId, selection, freeze);
        });
      } catch (error) {
        if (!isGenerationSourceLockUnavailable(error)) throw error;
      }
    }
    return generationConflict("VERSION_CONFLICT");
  }
  async lockGeneration(
    tx: Tx,
    ctx: RequestContext,
    row: MarketCandidateGeneration,
    includeDeleted = false,
  ) {
    if (includeDeleted)
      await tx.$queryRaw`SELECT id FROM company_profile WHERE id=${row.companyId}::uuid AND workspace_id=${ctx.workspaceId}::uuid FOR UPDATE`;
    else await this.company(tx, ctx, row.companyId, true);
    await tx.$queryRaw`SELECT company_id FROM market_candidate_generation_head WHERE workspace_id=${ctx.workspaceId}::uuid AND company_id=${row.companyId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM market_candidate_generation WHERE id=${row.id}::uuid FOR UPDATE`;
    return this.readInTransaction(tx, row.id);
  }
  head(tx: Tx, row: MarketCandidateGeneration) {
    return tx.marketCandidateGenerationHead.findUnique({
      where: {
        workspaceId_companyId: {
          workspaceId: row.workspaceId,
          companyId: row.companyId,
        },
      },
    });
  }
  attempts(tx: Tx, row: MarketCandidateGeneration) {
    return tx.marketCandidateGenerationAttempt.findMany({
      where: {
        workspaceId: row.workspaceId,
        companyId: row.companyId,
        generationId: row.id,
      },
      orderBy: [{ admittedAt: "asc" }, { id: "asc" }],
    });
  }
  async assertNoForeignRisk(
    tx: Tx,
    row: MarketCandidateGeneration,
  ): Promise<void> {
    const risk = await tx.$queryRaw<Array<{ unsafe: boolean }>>`SELECT EXISTS(
      SELECT 1 FROM market_candidate_generation_attempt a
      JOIN tool_budget_account b ON b.scope_key=a.scope_key AND b.account_key=a.account_key
      LEFT JOIN tool_budget_operation o ON o.scope_key=b.scope_key AND o.account_id=b.id AND o.generation=a.account_generation
      WHERE a.workspace_id=${row.workspaceId}::uuid AND a.company_id=${row.companyId}::uuid AND a.generation_id<>${row.id}::uuid
      AND (o.status IN('RESERVED','RESULT_UNKNOWN') OR (o.id IS NULL AND b.closed_at IS NULL))
    ) AS unsafe`;
    if (risk[0]?.unsafe !== false)
      throw new ExecutionControlError(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
  }
  async assertAttemptFamilyClear(
    tx: Tx,
    row: MarketCandidateGeneration,
  ): Promise<void> {
    const risk = await tx.$queryRaw<Array<{ unsafe: boolean }>>`SELECT EXISTS(
      SELECT 1 FROM market_candidate_generation_attempt a
      JOIN tool_budget_account b ON b.scope_key=a.scope_key AND b.account_key=a.account_key
      LEFT JOIN tool_budget_operation o ON o.scope_key=b.scope_key AND o.account_id=b.id AND o.generation=a.account_generation
      WHERE a.workspace_id=${row.workspaceId}::uuid AND a.generation_id=${row.id}::uuid
      AND (b.charged_microusd<>0 OR b.reserved_microusd<>0 OR (o.id IS NOT NULL AND o.status<>'RELEASED'))
    ) AS unsafe`;
    if (risk[0]?.unsafe !== false)
      throw new ExecutionControlError(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
  }
  async appendAttempt(
    tx: Tx,
    row: MarketCandidateGeneration,
    binding: ExecutionBudgetBinding,
    expectedOperationKey: string,
  ) {
    const account = await tx.toolBudgetAccount.findUnique({
      where: {
        scopeKey_accountKey: {
          scopeKey: row.workspaceId,
          accountKey: binding.accountKey,
        },
      },
    });
    if (
      !account ||
      account.authorityId !== binding.authorityId ||
      account.authorizedCapMicrousd !== 800000n ||
      account.closedAt
    )
      throw new ExecutionControlError(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
    const attempt = await tx.marketCandidateGenerationAttempt.create({
      data: {
        id: randomUUID(),
        workspaceId: row.workspaceId,
        companyId: row.companyId,
        generationId: row.id,
        scopeKey: row.workspaceId,
        authorityId: binding.authorityId,
        accountKey: binding.accountKey,
        accountGeneration: account.generation,
        expectedOperationKey,
        requestSha256: binding.requestSha256,
      },
    });
    const updated = await tx.marketCandidateGeneration.update({
      where: { id: row.id },
      data: { phase: "RUNNING", reasonCode: null, activeAttemptId: attempt.id },
    });
    return { row: checkedGeneration(updated), attempt };
  }
  async progress(
    tx: Tx,
    row: MarketCandidateGeneration,
    phase: string,
    reasonCode: string | null,
  ) {
    await tx.marketCandidateGeneration.updateMany({
      where: { id: row.id, phase: { notIn: ["PERSISTED", "NOT_APPLIED"] } },
      data: { phase, reasonCode },
    });
    return this.readInTransaction(tx, row.id);
  }
  async consumeTerminal(
    tx: Tx,
    row: MarketCandidateGeneration,
    decision: GenerationConsumptionDecision,
    receipt: DurableExecutionReceipt,
    ack: DomainAckRecord,
  ) {
    const updated = await tx.marketCandidateGeneration.update({
      where: { id: row.id },
      data: {
        ...decision,
        executionOperationId: receipt.operationId,
        resultSchema: receipt.resultSchema,
        resultDigest: receipt.resultDigest,
        consumerAckId: ack.ackId,
        consumedAt: new Date(),
      },
    });
    return checkedGeneration(updated);
  }
  async terminalValid(
    tx: Tx,
    row: MarketCandidateGeneration,
  ): Promise<boolean> {
    const result = await tx.$queryRaw<
      Array<{ valid: boolean }>
    >`SELECT market_candidate_generation_terminal_v1(g) AS valid
      FROM market_candidate_generation g WHERE g.id=${row.id}::uuid`;
    return result.length === 1 && result[0].valid === true;
  }
}
