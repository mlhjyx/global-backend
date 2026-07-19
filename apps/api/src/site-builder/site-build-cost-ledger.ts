import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE } from './agents/model-policy.registry';

export const SITE_BUILD_COST_SUMMARY_VERSION =
  'site-builder-cost-summary/v1' as const;

export type PaidCostBasis =
  | 'provider_reported'
  | 'token_pricing'
  | 'tool_reported'
  | 'legacy_estimate'
  | 'unknown'
  | 'not_incurred';

export interface PaidCostMeasurement {
  basis: PaidCostBasis;
  budgetChargeMicrousd: number;
  reportedCostMicrousd: number | null;
  calculatedCostMicrousd: number | null;
  estimatedCostMicrousd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  callCount: number;
  meta: Record<string, unknown>;
}

interface ModelMeasurementInput {
  taskId: string;
  requestedModel: string;
  resolvedModel?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  callCount?: number;
  reservationMicrousd: number;
}

type FrozenRate = { input: number; output: number };

function nonNegativeInt(value: number | undefined): number | null {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function knownBrandProfileRate(model: string): FrozenRate | null {
  const rates = BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.pricing.rates as Record<
    string,
    FrozenRate
  >;
  return rates[model] ?? null;
}

/**
 * Converts one model response into explicit accounting truth. A budget charge
 * may conservatively consume the reservation while all public cost fields stay
 * unknown; it is never relabelled as provider-reported or token-calculated.
 */
export function modelCostMeasurement(
  input: ModelMeasurementInput,
): PaidCostMeasurement {
  const inputTokens = nonNegativeInt(input.usage?.inputTokens);
  const outputTokens = nonNegativeInt(input.usage?.outputTokens);
  const callCount = Math.max(1, Math.floor(input.callCount ?? 1));
  const costUsd = input.usage?.costUsd;
  if (Number.isFinite(costUsd) && costUsd! >= 0) {
    const reportedCostMicrousd = Math.round(costUsd! * 1_000_000);
    return {
      basis: 'provider_reported',
      budgetChargeMicrousd: reportedCostMicrousd,
      reportedCostMicrousd,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens,
      outputTokens,
      callCount,
      meta: { reportedCostUsd: costUsd },
    };
  }

  const rate =
    input.taskId === 'site_builder.brand_profile' &&
    (!input.resolvedModel || input.resolvedModel === input.requestedModel)
      ? knownBrandProfileRate(input.requestedModel)
      : null;
  if (rate && inputTokens !== null && outputTokens !== null) {
    // USD / 1M tokens converts directly to micro-USD / token.
    const calculatedCostMicrousd = Math.round(
      inputTokens * rate.input + outputTokens * rate.output,
    );
    return {
      basis: 'token_pricing',
      budgetChargeMicrousd: calculatedCostMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd,
      estimatedCostMicrousd: null,
      inputTokens,
      outputTokens,
      callCount,
      meta: {
        pricingEvidenceId: BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.id,
        pricingSnapshot: {
          model: input.requestedModel,
          capturedAt:
            BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.pricing.capturedAt,
          source: BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.pricing.source,
          inputUsdPerMillionTokens: rate.input,
          outputUsdPerMillionTokens: rate.output,
        },
      },
    };
  }

  return {
    basis: 'unknown',
    budgetChargeMicrousd: input.reservationMicrousd,
    reportedCostMicrousd: null,
    calculatedCostMicrousd: null,
    estimatedCostMicrousd: null,
    inputTokens,
    outputTokens,
    callCount,
    meta: {
      reason: rate ? 'token_usage_incomplete' : 'no_verified_price',
      requestedModel: input.requestedModel,
      ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
    },
  };
}

/** Backward-compatible ToolResult.costCents is reserve guidance, not an invoice. */
export function legacyToolCostMeasurement(
  costCents: number,
  reservationMicrousd: number,
): PaidCostMeasurement {
  if (!Number.isFinite(costCents) || costCents < 0) {
    return {
      basis: 'unknown',
      budgetChargeMicrousd: reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: null,
      outputTokens: null,
      callCount: 1,
      meta: { reason: 'invalid_legacy_cost' },
    };
  }
  const estimatedCostMicrousd = Math.round(costCents * 10_000);
  return {
    basis: 'legacy_estimate',
    budgetChargeMicrousd: Math.min(
      reservationMicrousd,
      estimatedCostMicrousd,
    ),
    reportedCostMicrousd: null,
    calculatedCostMicrousd: null,
    estimatedCostMicrousd,
    inputTokens: null,
    outputTokens: null,
    callCount: 1,
    meta: { legacyCostCents: costCents },
  };
}

export function paidOperationKey(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'), 'utf8')
    .digest('hex');
}

interface SummaryBudgetRow {
  capMicrousd: bigint;
  reservedMicrousd: bigint;
  chargedMicrousd: bigint;
  paidCallsEnabled: boolean;
  disabledReason: string | null;
  exhaustedAt: Date | null;
}

interface SummarySpendRow {
  kind: string;
  status: string;
  costBasis?: string | null;
  budgetChargeMicrousd: bigint;
  reportedCostMicrousd: bigint | null;
  calculatedCostMicrousd: bigint | null;
  estimatedCostMicrousd: bigint | null;
  inputTokens: number | null;
  outputTokens: number | null;
  callCount: number | null;
}

function jsonInteger(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error('site build cost exceeds the stable JSON integer range');
  }
  return number;
}

export function buildSiteBuildCostSummary(
  budget: SummaryBudgetRow,
  spends: readonly SummarySpendRow[],
) {
  const sumBigInt = (
    pick: (row: SummarySpendRow) => bigint | null,
  ): number => jsonInteger(spends.reduce((sum, row) => sum + (pick(row) ?? 0n), 0n));
  const operationCount = (status: string): number =>
    spends.filter((row) => row.status === status).length;
  const calls = (kind: string): number =>
    spends.reduce(
      (sum, row) => sum + (row.kind === kind ? (row.callCount ?? 0) : 0),
      0,
    );
  const cap = jsonInteger(budget.capMicrousd);
  const reserved = jsonInteger(budget.reservedMicrousd);
  const charged = jsonInteger(budget.chargedMicrousd);

  return {
    schemaVersion: SITE_BUILD_COST_SUMMARY_VERSION,
    currency: 'USD' as const,
    unit: 'microusd' as const,
    budget: {
      capMicrousd: cap,
      reservedMicrousd: reserved,
      chargedMicrousd: charged,
      remainingMicrousd: Math.max(0, cap - reserved - charged),
      paidCallsEnabled: budget.paidCallsEnabled,
      disabledReason: budget.disabledReason,
      exhaustedAt: budget.exhaustedAt?.toISOString() ?? null,
    },
    totals: {
      reportedCostMicrousd: sumBigInt(
        (row) => row.reportedCostMicrousd,
      ),
      calculatedCostMicrousd: sumBigInt(
        (row) => row.calculatedCostMicrousd,
      ),
      estimatedCostMicrousd: sumBigInt(
        (row) => row.estimatedCostMicrousd,
      ),
      unknownOperations: spends.filter(
        (row) => row.costBasis === 'unknown' || row.status === 'UNKNOWN',
      ).length,
    },
    usage: {
      inputTokens: spends.reduce(
        (sum, row) => sum + (row.inputTokens ?? 0),
        0,
      ),
      outputTokens: spends.reduce(
        (sum, row) => sum + (row.outputTokens ?? 0),
        0,
      ),
      modelCalls: calls('model'),
      toolCalls: calls('tool'),
    },
    operations: {
      succeeded: operationCount('SUCCEEDED'),
      failed: operationCount('FAILED'),
      unknown: operationCount('UNKNOWN'),
      released: operationCount('RELEASED'),
    },
  };
}

export type SiteBuildCostSummary = ReturnType<
  typeof buildSiteBuildCostSummary
>;

export class PaidCallDeniedError extends Error {
  constructor(public readonly decision: string) {
    super(`paid call denied: ${decision}`);
    this.name = 'PaidCallDeniedError';
  }
}

export class PaidOperationUnknownError extends Error {
  constructor(
    public readonly operationKey: string,
    public readonly errorCode = 'ACK_UNKNOWN',
  ) {
    super(`paid operation ${operationKey} has ambiguous acknowledgement`);
    this.name = 'PaidOperationUnknownError';
  }
}

export class PaidTaskBusyError extends Error {
  constructor(public readonly taskId: string) {
    super(`paid task ${taskId} already has a live fenced attempt`);
    this.name = 'PaidTaskBusyError';
  }
}

export class PaidTaskFenceError extends Error {
  constructor() {
    super('paid task fence is stale or expired');
    this.name = 'PaidTaskFenceError';
  }
}

export interface PaidOperationScope {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  taskAttemptId?: string;
  fenceToken?: string;
}

/** Stable logical namespace threaded through ModelGateway and ToolBroker. */
export interface PaidCostContext {
  siteId: string;
  scopeKey: string;
  taskAttemptId?: string;
  fenceToken?: string;
}

export interface PaidOperationReservation extends PaidOperationScope {
  operationKey: string;
  kind: 'model' | 'tool';
  taskId: string;
  subject: string;
  reservationMicrousd: number;
  meta?: Record<string, unknown>;
}

export type PaidOperationDecision =
  | { kind: 'execute' }
  | {
      kind: 'replay';
      status: string;
      result: Record<string, unknown> | null;
      meta: Record<string, unknown> | null;
      errorCode: string | null;
    };

interface ReserveRow {
  decision: string;
  spend_id: string | null;
  spend_status: string | null;
  cached_result: Record<string, unknown> | null;
  cached_meta: Record<string, unknown> | null;
  cached_error_code: string | null;
}

interface LedgerRuntimeDeps {
  now?: () => Date;
  randomUUID?: () => string;
}

export interface ClaimedTaskAttempt {
  id: string;
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  taskId: string;
  status: string;
  attemptNo: number;
  fenceToken: string;
  leaseUntil: Date;
  inputHash?: string | null;
  inputJson?: Prisma.JsonValue | null;
  outputJson?: Prisma.JsonValue | null;
  resultJson?: Prisma.JsonValue | null;
}

const TASK_LEASE_MS = 10 * 60 * 1_000;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  const canonical = canonicalJson(value);
  if (!canonical || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new Error('paid task payload must be a JSON object');
  }
  return canonical as Record<string, unknown>;
}

function asJsonText(value: Record<string, unknown> | null | undefined): string {
  return JSON.stringify(value ?? {});
}

/**
 * Application boundary for the database-level reserve/settle ledger. The SQL
 * functions own arithmetic and row locks; this class maps their decisions into
 * fail-closed runtime behavior and manages the logical BrandProfile fence.
 */
export class SiteBuildCostLedger {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(
    private readonly prisma: PrismaService,
    deps: LedgerRuntimeDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? nodeRandomUUID;
  }

  async reserveOperation(
    input: PaidOperationReservation,
  ): Promise<PaidOperationDecision> {
    if (!/^[0-9a-f]{64}$/.test(input.operationKey)) {
      throw new Error('paid operation key must be a lowercase SHA-256');
    }
    const rows = await this.prisma.withWorkspace(input.workspaceId, (tx) =>
      tx.$queryRaw<ReserveRow[]>`
        SELECT * FROM reserve_site_build_spend(
          ${input.workspaceId}::uuid,
          ${input.buildRunId}::uuid,
          ${input.taskAttemptId ?? null}::uuid,
          ${input.fenceToken ?? null}::uuid,
          ${input.operationKey}::varchar,
          ${input.kind}::text,
          ${input.taskId}::text,
          ${input.subject}::text,
          ${BigInt(input.reservationMicrousd)}::bigint,
          ${asJsonText(input.meta)}::jsonb
        )
      `,
    );
    const row = rows[0];
    if (!row) throw new PaidCallDeniedError('EMPTY_RESERVE_RESULT');
    if (row.decision === 'EXECUTE') return { kind: 'execute' };
    if (row.decision === 'REPLAY') {
      return {
        kind: 'replay',
        status: row.spend_status ?? 'UNKNOWN',
        result: row.cached_result,
        meta: row.cached_meta,
        errorCode: row.cached_error_code,
      };
    }
    if (row.decision === 'UNKNOWN') {
      throw new PaidOperationUnknownError(
        input.operationKey,
        row.cached_error_code ?? 'ACK_UNKNOWN',
      );
    }
    throw new PaidCallDeniedError(row.decision);
  }

  async settleOperation(input: {
    scope: PaidOperationReservation;
    status: 'SUCCEEDED' | 'FAILED' | 'RELEASED';
    measurement: PaidCostMeasurement;
    result?: Record<string, unknown> | null;
    meta?: Record<string, unknown>;
    errorCode?: string;
  }): Promise<string> {
    const { scope, measurement } = input;
    const rows = await this.prisma.withWorkspace(scope.workspaceId, (tx) =>
      tx.$queryRaw<Array<{ decision: string }>>`
        SELECT settle_site_build_spend(
          ${scope.workspaceId}::uuid,
          ${scope.buildRunId}::uuid,
          ${scope.operationKey}::varchar,
          ${scope.fenceToken ?? null}::uuid,
          ${input.status}::text,
          ${BigInt(measurement.budgetChargeMicrousd)}::bigint,
          ${measurement.basis}::text,
          ${measurement.reportedCostMicrousd === null ? null : BigInt(measurement.reportedCostMicrousd)}::bigint,
          ${measurement.calculatedCostMicrousd === null ? null : BigInt(measurement.calculatedCostMicrousd)}::bigint,
          ${measurement.estimatedCostMicrousd === null ? null : BigInt(measurement.estimatedCostMicrousd)}::bigint,
          ${measurement.inputTokens}::integer,
          ${measurement.outputTokens}::integer,
          ${measurement.callCount}::integer,
          ${input.result ? asJsonText(input.result) : null}::jsonb,
          ${asJsonText({ ...scope.meta, ...measurement.meta, ...input.meta })}::jsonb,
          ${input.errorCode ?? null}::text
        ) AS decision
      `,
    );
    return rows[0]?.decision ?? 'MISSING';
  }

  async ensureBudget(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    capMicrousd: number;
  }): Promise<void> {
    await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.siteBuildBudget.upsert({
        where: { buildRunId: input.buildRunId },
        create: {
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          buildRunId: input.buildRunId,
          capMicrousd: BigInt(input.capMicrousd),
        },
        update: {},
      });
    });
  }

  async disablePaidCalls(
    workspaceId: string,
    buildRunId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      await tx.siteBuildBudget.updateMany({
        where: { buildRunId },
        data: {
          paidCallsEnabled: false,
          disabledReason: reason.slice(0, 80),
        },
      });
    });
  }

  async closeAndSummarize(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    reason: string;
  }): Promise<SiteBuildCostSummary> {
    const reason = input.reason.trim().slice(0, 80);
    if (!reason) throw new Error('terminal paid-call reason is required');

    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$queryRaw<Array<{ reconciled: number }>>`
        SELECT reconcile_site_build_spend(
          ${input.workspaceId}::uuid,
          ${input.buildRunId}::uuid
        ) AS reconciled
      `;
      await tx.siteBuildBudget.updateMany({
        where: {
          buildRunId: input.buildRunId,
          OR: [
            { paidCallsEnabled: true },
            {
              disabledReason: {
                in: ['run_succeeded', 'run_failed', 'run_cancelled'],
              },
            },
          ],
        },
        data: {
          paidCallsEnabled: false,
          disabledReason: reason,
        },
      });
      const [budget, spends] = await Promise.all([
        tx.siteBuildBudget.findUnique({
          where: { buildRunId: input.buildRunId },
          select: {
            capMicrousd: true,
            reservedMicrousd: true,
            chargedMicrousd: true,
            paidCallsEnabled: true,
            disabledReason: true,
            exhaustedAt: true,
          },
        }),
        tx.siteBuildSpend.findMany({
          where: { buildRunId: input.buildRunId },
          select: {
            kind: true,
            status: true,
            costBasis: true,
            budgetChargeMicrousd: true,
            reportedCostMicrousd: true,
            calculatedCostMicrousd: true,
            estimatedCostMicrousd: true,
            inputTokens: true,
            outputTokens: true,
            callCount: true,
          },
          orderBy: { operationKey: 'asc' },
        }),
      ]);
      if (!budget) {
        throw new PaidCallDeniedError('DENIED_NO_BUDGET');
      }
      return buildSiteBuildCostSummary(budget, spends);
    });
  }

  async claimTaskAttempt(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    taskId: string;
  }): Promise<
    | { kind: 'completed'; result: Record<string, unknown> }
    | { kind: 'claimed'; attempt: ClaimedTaskAttempt }
  > {
    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-task-${input.buildRunId}-${input.taskId}`}))`;
      const existing = await tx.siteBuildTaskAttempt.findUnique({
        where: {
          buildRunId_taskId: {
            buildRunId: input.buildRunId,
            taskId: input.taskId,
          },
        },
      });
      if (existing?.status === 'SUCCEEDED') {
        if (
          !existing.resultJson ||
          typeof existing.resultJson !== 'object' ||
          Array.isArray(existing.resultJson)
        ) {
          throw new Error('completed paid task has no stable result');
        }
        return {
          kind: 'completed',
          result: existing.resultJson as Record<string, unknown>,
        };
      }

      const now = this.now();
      if (existing && existing.leaseUntil > now) {
        throw new PaidTaskBusyError(input.taskId);
      }
      const [run, budget] = await Promise.all([
        tx.siteBuildRun.findUnique({
          where: { id: input.buildRunId },
          select: { status: true },
        }),
        tx.siteBuildBudget.findUnique({
          where: { buildRunId: input.buildRunId },
          select: { paidCallsEnabled: true },
        }),
      ]);
      if (!run || run.status !== 'running') {
        throw new PaidCallDeniedError('DENIED_STATE');
      }
      if (!budget?.paidCallsEnabled && existing?.status !== 'MODEL_SUCCEEDED') {
        throw new PaidCallDeniedError('DENIED_KILL_SWITCH');
      }

      const fenceToken = this.randomUUID();
      const leaseUntil = new Date(now.getTime() + TASK_LEASE_MS);
      const attempt = existing
        ? await tx.siteBuildTaskAttempt.update({
            where: { id: existing.id },
            data: {
              attemptNo: existing.attemptNo + 1,
              fenceToken,
              leaseUntil,
            },
          })
        : await tx.siteBuildTaskAttempt.create({
            data: {
              workspaceId: input.workspaceId,
              siteId: input.siteId,
              buildRunId: input.buildRunId,
              taskId: input.taskId,
              fenceToken,
              leaseUntil,
            },
          });
      return {
        kind: 'claimed',
        attempt: attempt as ClaimedTaskAttempt,
      };
    });
  }

  async freezeTaskInput<T extends Record<string, unknown>>(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    candidate: T,
  ): Promise<{ inputHash: string; input: T; replayed: boolean }> {
    return this.prisma.withWorkspace(fence.workspaceId, async (tx) => {
      const attempt = await tx.siteBuildTaskAttempt.findUnique({
        where: { id: fence.attemptId },
      });
      const now = this.now();
      if (
        !attempt ||
        attempt.fenceToken !== fence.fenceToken ||
        attempt.leaseUntil <= now
      ) {
        throw new PaidTaskFenceError();
      }
      if (attempt.inputHash && attempt.inputJson) {
        return {
          inputHash: attempt.inputHash,
          input: attempt.inputJson as T,
          replayed: true,
        };
      }
      const input = jsonObject(candidate) as T;
      const inputHash = createHash('sha256')
        .update(JSON.stringify(input), 'utf8')
        .digest('hex');
      const written = await tx.siteBuildTaskAttempt.updateMany({
        where: {
          id: fence.attemptId,
          fenceToken: fence.fenceToken,
          leaseUntil: { gt: now },
          inputHash: null,
        },
        data: {
          inputHash,
          inputJson: input as Prisma.InputJsonObject,
          status: 'INPUT_READY',
        },
      });
      if (written.count !== 1) throw new PaidTaskFenceError();
      return { inputHash, input, replayed: false };
    });
  }

  async storeTaskOutput(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    output: Record<string, unknown>,
  ): Promise<void> {
    await this.updateFencedTask(fence, {
      outputJson: jsonObject(output) as Prisma.InputJsonObject,
      status: 'MODEL_SUCCEEDED',
    });
  }

  async completeTask(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.updateFencedTask(fence, {
      resultJson: jsonObject(result) as Prisma.InputJsonObject,
      status: 'SUCCEEDED',
      leaseUntil: this.now(),
    });
  }

  async releaseTask(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
  ): Promise<void> {
    await this.prisma.withWorkspace(fence.workspaceId, async (tx) => {
      await tx.siteBuildTaskAttempt.updateMany({
        where: { id: fence.attemptId, fenceToken: fence.fenceToken },
        data: { leaseUntil: this.now() },
      });
    });
  }

  private async updateFencedTask(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    data: Prisma.SiteBuildTaskAttemptUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.withWorkspace(fence.workspaceId, async (tx) => {
      const written = await tx.siteBuildTaskAttempt.updateMany({
        where: {
          id: fence.attemptId,
          fenceToken: fence.fenceToken,
          leaseUntil: { gt: this.now() },
        },
        data,
      });
      if (written.count !== 1) throw new PaidTaskFenceError();
    });
  }
}
