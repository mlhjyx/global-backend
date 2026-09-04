import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { PaidModelPreflightEvidence } from "../model-gateway/paid-model-settlement";
import type { ModelUsage } from "../model-gateway/types";
import { BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE } from "./agents/model-policy.registry";

export const SITE_BUILD_COST_SUMMARY_VERSION =
  "site-builder-cost-summary/v2" as const;

export type PaidCostBasis =
  | "provider_reported"
  | "token_pricing"
  | "tool_reported"
  | "legacy_estimate"
  | "estimated_upper_bound"
  | "unknown"
  | "not_incurred";

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
  usage?: ModelUsage;
  settlementPreflight?: PaidModelPreflightEvidence;
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
  const gatewaySettlements = input.usage?.gatewaySettlements ?? [];
  if (input.settlementPreflight) {
    const settled = gatewaySettlements.filter(
      (observation) => observation.status === "settled",
    );
    const calculatedCostMicrousd = settled.reduce(
      (sum, observation) => sum + observation.costMicrousd,
      0,
    );
    const settledInputTokens = settled.reduce(
      (sum, observation) => sum + observation.inputTokens,
      0,
    );
    const settledOutputTokens = settled.reduce(
      (sum, observation) => sum + observation.outputTokens,
      0,
    );
    const complete =
      gatewaySettlements.length === callCount &&
      settled.length === callCount &&
      input.resolvedModel === input.requestedModel &&
      new Set(settled.map((observation) => observation.requestId)).size ===
        callCount &&
      calculatedCostMicrousd <=
        input.settlementPreflight.pricedMaximumMicrousd &&
      calculatedCostMicrousd <= input.reservationMicrousd &&
      settledOutputTokens <=
        input.settlementPreflight.maxOutputTokensPerCall * callCount &&
      settled.every(
        (observation) =>
          observation.resolverId === input.settlementPreflight!.resolverId &&
          observation.alias === input.settlementPreflight!.alias &&
          observation.protocol === input.settlementPreflight!.protocol &&
          observation.channelId ===
            input.settlementPreflight!.expectedChannelId &&
          observation.basis === "openox_catalog_token_pricing" &&
          observation.outputTokens <=
            input.settlementPreflight!.maxOutputTokensPerCall,
      );
    if (complete) {
      return {
        basis: "token_pricing",
        budgetChargeMicrousd: calculatedCostMicrousd,
        reportedCostMicrousd: null,
        calculatedCostMicrousd,
        estimatedCostMicrousd: null,
        inputTokens: settledInputTokens,
        outputTokens: settledOutputTokens,
        callCount,
        meta: {
          settlementPreflight: input.settlementPreflight,
          gatewaySettlements,
        },
      };
    }
    return {
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: input.reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: input.reservationMicrousd,
      inputTokens,
      outputTokens,
      callCount,
      meta: {
        reason: "gateway_settlement_incomplete_or_mismatched",
        requestedModel: input.requestedModel,
        ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
        settlementPreflight: input.settlementPreflight,
        gatewaySettlements,
      },
    };
  }
  if (
    gatewaySettlements.some((observation) => observation.status === "unknown")
  ) {
    return {
      basis: "estimated_upper_bound",
      budgetChargeMicrousd: input.reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: input.reservationMicrousd,
      inputTokens,
      outputTokens,
      callCount,
      meta: {
        reason: "gateway_exact_cost_unavailable",
        requestedModel: input.requestedModel,
        ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
        gatewaySettlements,
      },
    };
  }
  if (Number.isFinite(costUsd) && costUsd! >= 0) {
    const reportedCostMicrousd = Math.round(costUsd! * 1_000_000);
    return {
      basis: "provider_reported",
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
    input.taskId === "site_builder.brand_profile" &&
    (!input.resolvedModel || input.resolvedModel === input.requestedModel)
      ? knownBrandProfileRate(input.requestedModel)
      : null;
  if (rate && inputTokens !== null && outputTokens !== null) {
    // USD / 1M tokens converts directly to micro-USD / token.
    const calculatedCostMicrousd = Math.round(
      inputTokens * rate.input + outputTokens * rate.output,
    );
    return {
      basis: "token_pricing",
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
    basis: "estimated_upper_bound",
    budgetChargeMicrousd: input.reservationMicrousd,
    reportedCostMicrousd: null,
    calculatedCostMicrousd: null,
    estimatedCostMicrousd: input.reservationMicrousd,
    inputTokens,
    outputTokens,
    callCount,
    meta: {
      reason: rate ? "token_usage_incomplete" : "no_verified_price",
      requestedModel: input.requestedModel,
      ...(input.resolvedModel ? { resolvedModel: input.resolvedModel } : {}),
      ...(gatewaySettlements.length > 0 ? { gatewaySettlements } : {}),
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
      basis: "unknown",
      budgetChargeMicrousd: reservationMicrousd,
      reportedCostMicrousd: null,
      calculatedCostMicrousd: null,
      estimatedCostMicrousd: null,
      inputTokens: null,
      outputTokens: null,
      callCount: 1,
      meta: { reason: "invalid_legacy_cost" },
    };
  }
  const estimatedCostMicrousd = Math.round(costCents * 10_000);
  return {
    basis: "legacy_estimate",
    budgetChargeMicrousd: Math.min(reservationMicrousd, estimatedCostMicrousd),
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
  return createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"), "utf8")
    .digest("hex");
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
  id?: string;
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

interface SummaryReconciliationRow {
  spendId: string;
  status: string;
  exactCostMicrousd: bigint | null;
  createdAt: Date;
}

function jsonMicrousd(value: bigint): string {
  if (value < 0n) {
    throw new Error("site build cost cannot be negative");
  }
  return value.toString(10);
}

export function buildSiteBuildCostSummary(
  budget: SummaryBudgetRow,
  spends: readonly SummarySpendRow[],
  reconciliations: readonly SummaryReconciliationRow[] = [],
) {
  const sumBigInt = (pick: (row: SummarySpendRow) => bigint | null): string =>
    jsonMicrousd(spends.reduce((sum, row) => sum + (pick(row) ?? 0n), 0n));
  const operationCount = (status: string): number =>
    spends.filter((row) => row.status === status).length;
  const calls = (kind: string): number =>
    spends.reduce(
      (sum, row) => sum + (row.kind === kind ? (row.callCount ?? 0) : 0),
      0,
    );
  const cap = jsonMicrousd(budget.capMicrousd);
  const reserved = jsonMicrousd(budget.reservedMicrousd);
  const charged = jsonMicrousd(budget.chargedMicrousd);
  const resolvedBySpend = new Map(
    reconciliations
      .filter(
        (row) => row.status === "RESOLVED" && row.exactCostMicrousd !== null,
      )
      .map((row) => [row.spendId, row.exactCostMicrousd!] as const),
  );
  const exactCostMicrousd = jsonMicrousd(
    spends.reduce((sum, row) => {
      const reconciled = row.id ? resolvedBySpend.get(row.id) : undefined;
      return (
        sum +
        (reconciled ??
          row.reportedCostMicrousd ??
          row.calculatedCostMicrousd ??
          0n)
      );
    }, 0n),
  );
  const upperBoundCostMicrousd = sumBigInt((row) =>
    row.costBasis === "estimated_upper_bound"
      ? row.estimatedCostMicrousd
      : null,
  );
  const reconcilableSpendIds = new Set(
    spends
      .filter(
        (row) =>
          row.id &&
          (row.costBasis === "estimated_upper_bound" ||
            row.costBasis === "unknown"),
      )
      .map((row) => row.id!),
  );
  const terminalReconciliations = new Set(
    reconciliations
      .filter((row) => ["RESOLVED", "CONFLICT", "EXPIRED"].includes(row.status))
      .map((row) => row.spendId),
  );
  const asOf = reconciliations.reduce<Date | null>(
    (latest, row) =>
      !latest || row.createdAt > latest ? row.createdAt : latest,
    null,
  );

  return {
    schemaVersion: SITE_BUILD_COST_SUMMARY_VERSION,
    currency: "USD" as const,
    unit: "microusd" as const,
    budget: {
      authorizedCapMicrousd: cap,
      conservativeChargedMicrousd: charged,
      capMicrousd: cap,
      reservedMicrousd: reserved,
      chargedMicrousd: charged,
      remainingMicrousd: jsonMicrousd(
        budget.capMicrousd - budget.reservedMicrousd - budget.chargedMicrousd,
      ),
      paidCallsEnabled: budget.paidCallsEnabled,
      disabledReason: budget.disabledReason,
      exhaustedAt: budget.exhaustedAt?.toISOString() ?? null,
    },
    totals: {
      reportedCostMicrousd: sumBigInt((row) => row.reportedCostMicrousd),
      calculatedCostMicrousd: sumBigInt((row) => row.calculatedCostMicrousd),
      estimatedCostMicrousd: sumBigInt((row) => row.estimatedCostMicrousd),
      unknownOperations: spends.filter(
        (row) => row.costBasis === "unknown" || row.status === "UNKNOWN",
      ).length,
      exactCostMicrousd,
      upperBoundCostMicrousd,
    },
    usage: {
      inputTokens: spends.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0),
      outputTokens: spends.reduce(
        (sum, row) => sum + (row.outputTokens ?? 0),
        0,
      ),
      modelCalls: calls("model"),
      toolCalls: calls("tool"),
    },
    operations: {
      succeeded: operationCount("SUCCEEDED"),
      failed: operationCount("FAILED"),
      unknown: operationCount("UNKNOWN"),
      released: operationCount("RELEASED"),
    },
    reconciliation: {
      pendingOperations: [...reconcilableSpendIds].filter(
        (spendId) => !terminalReconciliations.has(spendId),
      ).length,
      resolvedOperations: reconciliations.filter(
        (row) => row.status === "RESOLVED",
      ).length,
      conflictOperations: reconciliations.filter(
        (row) => row.status === "CONFLICT",
      ).length,
      asOf: asOf?.toISOString() ?? null,
      revision: reconciliations.length,
    },
  };
}

export type SiteBuildCostSummary = ReturnType<typeof buildSiteBuildCostSummary>;

export interface SiteBuildReconciliationObservation {
  status: "UNRESOLVED" | "RESOLVED" | "CONFLICT" | "EXPIRED";
  resolverId: string;
  requestId?: string | null;
  receiptDigest?: string | null;
  costBasis?: "provider_reported" | "token_pricing";
  exactCostMicrousd?: string;
  inputTokens?: number;
  outputTokens?: number;
  observedAt: Date;
  meta?: Record<string, unknown>;
}

const RECONCILIATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;
const RECONCILIATION_EXPIRY_MS = 24 * 60 * 60_000;
const RECONCILIATION_META_MAX_BYTES = 4_096;
const FORBIDDEN_RECONCILIATION_META_KEY =
  /credential|secret|token|authorization|prompt|response|body|content|cookie|api.?key|personal|email|phone/i;

export function reconciliationDueAction(input: {
  now: Date;
  spendCreatedAt: Date;
  observations: ReadonlyArray<{ status: string; observedAt: Date }>;
}): "WAIT" | "RESOLVE" | "EXPIRE" | "TERMINAL" {
  if (
    input.observations.some((row) =>
      ["RESOLVED", "CONFLICT", "EXPIRED"].includes(row.status),
    )
  ) {
    return "TERMINAL";
  }
  if (
    input.now.getTime() - input.spendCreatedAt.getTime() >=
    RECONCILIATION_EXPIRY_MS
  ) {
    return "EXPIRE";
  }
  const attempts = input.observations.filter(
    (row) => row.status === "UNRESOLVED",
  );
  if (attempts.length >= RECONCILIATION_RETRY_DELAYS_MS.length) return "WAIT";
  const base =
    attempts.length === 0
      ? input.spendCreatedAt
      : attempts.reduce(
          (latest, row) => (row.observedAt > latest ? row.observedAt : latest),
          attempts[0]!.observedAt,
        );
  return input.now.getTime() - base.getTime() >=
    RECONCILIATION_RETRY_DELAYS_MS[attempts.length]!
    ? "RESOLVE"
    : "WAIT";
}

export function boundedReconciliationMeta(
  meta: Record<string, unknown> | undefined,
): Prisma.InputJsonObject | undefined {
  if (!meta) return undefined;
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 128 || depth > 4)
      throw new Error("reconciliation meta is too complex");
    if (typeof value === "string" && value.length > 512) {
      throw new Error("reconciliation meta string is too long");
    }
    if (Array.isArray(value)) {
      if (value.length > 32)
        throw new Error("reconciliation meta array is too large");
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > 32)
        throw new Error("reconciliation meta has too many keys");
      for (const [key, item] of entries) {
        if (key.length > 64 || FORBIDDEN_RECONCILIATION_META_KEY.test(key)) {
          throw new Error("reconciliation meta contains a forbidden key");
        }
        visit(item, depth + 1);
      }
    }
  };
  const canonical = jsonObject(meta);
  visit(canonical, 0);
  if (
    Buffer.byteLength(JSON.stringify(canonical), "utf8") >
    RECONCILIATION_META_MAX_BYTES
  ) {
    throw new Error("reconciliation meta exceeds the size limit");
  }
  return canonical as Prisma.InputJsonObject;
}

export class PaidCallDeniedError extends Error {
  constructor(public readonly decision: string) {
    super(`paid call denied: ${decision}`);
    this.name = "PaidCallDeniedError";
  }
}

export class PaidOperationUnknownError extends Error {
  constructor(
    public readonly operationKey: string,
    public readonly errorCode = "ACK_UNKNOWN",
  ) {
    super(`paid operation ${operationKey} has ambiguous acknowledgement`);
    this.name = "PaidOperationUnknownError";
  }
}

export class PaidTaskBusyError extends Error {
  constructor(public readonly taskId: string) {
    super(`paid task ${taskId} already has a live fenced attempt`);
    this.name = "PaidTaskBusyError";
  }
}

export class PaidTaskFenceError extends Error {
  constructor() {
    super("paid task fence is stale or expired");
    this.name = "PaidTaskFenceError";
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
  /** Installed by RouterModelGateway only after the paid preflight succeeds. */
  settlementPreflight?: PaidModelPreflightEvidence;
  /**
   * Explicit domain persistence gate for model replay. The gateway never
   * stores a raw provider result when this projection is absent.
   */
  durableReplayResult?: (
    result: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface PaidOperationReservation extends PaidOperationScope {
  operationKey: string;
  kind: "model" | "tool";
  taskId: string;
  subject: string;
  reservationMicrousd: number;
  meta?: Record<string, unknown>;
}

export type PaidOperationDecision =
  | { kind: "execute" }
  | {
      kind: "replay";
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
  if (value && typeof value === "object") {
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
  if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
    throw new Error("paid task payload must be a JSON object");
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
      throw new Error("paid operation key must be a lowercase SHA-256");
    }
    const rows = await this.prisma.withWorkspace(
      input.workspaceId,
      (tx) =>
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
    if (!row) throw new PaidCallDeniedError("EMPTY_RESERVE_RESULT");
    if (row.decision === "EXECUTE") return { kind: "execute" };
    if (row.decision === "REPLAY") {
      if (row.spend_status === "UNKNOWN") {
        throw new PaidOperationUnknownError(
          input.operationKey,
          row.cached_error_code ?? "RECORDED_UNKNOWN",
        );
      }
      return {
        kind: "replay",
        status: row.spend_status ?? "UNKNOWN",
        result: row.cached_result,
        meta: row.cached_meta,
        errorCode: row.cached_error_code,
      };
    }
    if (row.decision === "UNKNOWN") {
      throw new PaidOperationUnknownError(
        input.operationKey,
        row.cached_error_code ?? "ACK_UNKNOWN",
      );
    }
    throw new PaidCallDeniedError(row.decision);
  }

  async settleOperation(input: {
    scope: PaidOperationReservation;
    status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "RELEASED";
    measurement: PaidCostMeasurement;
    result?: Record<string, unknown> | null;
    meta?: Record<string, unknown>;
    errorCode?: string;
    /**
     * When present, settlement and the BuildRun paid-call kill switch commit
     * in the same workspace transaction. This is required for unknown
     * settlement: a replay must never observe FAILED before the kill switch.
     */
    disablePaidCallsReason?: string;
  }): Promise<string> {
    const { scope, measurement } = input;
    const disableReason = input.disablePaidCallsReason?.trim().slice(0, 80);
    if ((input.status === "UNKNOWN") !== (measurement.basis === "unknown")) {
      throw new Error("UNKNOWN spend status and cost basis must be paired");
    }
    if (input.status === "UNKNOWN" && (input.result || !disableReason)) {
      throw new Error(
        "UNKNOWN settlement requires no result and an atomic paid-call disable",
      );
    }
    if (
      input.disablePaidCallsReason !== undefined &&
      (!disableReason || measurement.basis !== "unknown")
    ) {
      throw new Error("atomic paid-call disable requires unknown settlement");
    }
    return this.prisma.withWorkspace(scope.workspaceId, async (tx) => {
      const rows =
        input.status === "UNKNOWN"
          ? await tx.$queryRaw<Array<{ decision: string }>>`
        SELECT settle_unknown_site_build_spend(
          ${scope.workspaceId}::uuid,
          ${scope.buildRunId}::uuid,
          ${scope.operationKey}::varchar,
          ${scope.fenceToken ?? null}::uuid,
          ${BigInt(measurement.budgetChargeMicrousd)}::bigint,
          ${measurement.inputTokens}::integer,
          ${measurement.outputTokens}::integer,
          ${measurement.callCount}::integer,
          ${asJsonText({ ...scope.meta, ...measurement.meta, ...input.meta })}::jsonb,
          ${input.errorCode ?? null}::text,
          ${disableReason!}::text
        ) AS decision
      `
          : await tx.$queryRaw<Array<{ decision: string }>>`
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
      `;
      const decision = rows[0]?.decision ?? "MISSING";
      if (decision === "OVER_RESERVATION") {
        const [budget, spends, reconciliations] = await Promise.all([
          tx.siteBuildBudget.findUnique({
            where: { buildRunId: scope.buildRunId },
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
            where: { buildRunId: scope.buildRunId },
            select: {
              id: true,
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
          }),
          tx.siteBuildSpendReconciliation.findMany({
            where: { buildRunId: scope.buildRunId },
            select: {
              spendId: true,
              status: true,
              exactCostMicrousd: true,
              createdAt: true,
            },
          }),
        ]);
        if (!budget) throw new PaidCallDeniedError("DENIED_NO_BUDGET");
        const summary = buildSiteBuildCostSummary(
          budget,
          spends,
          reconciliations,
        );
        await tx.siteBuildRun.update({
          where: { id: scope.buildRunId },
          data: { costSummary: summary as unknown as Prisma.InputJsonObject },
        });
        await tx.outboxEvent.create({
          data: {
            workspaceId: scope.workspaceId,
            eventType: "SiteBuildCostSummaryUpdated",
            schemaVersion: 1,
            aggregateType: "SiteBuildRun",
            aggregateId: scope.buildRunId,
            privacyClassification: "INTERNAL",
            payload: {
              workspaceId: scope.workspaceId,
              siteId: scope.siteId,
              buildRunId: scope.buildRunId,
              revision: summary.reconciliation.revision,
              summaryDigest: createHash("sha256")
                .update(JSON.stringify(summary))
                .digest("hex"),
              budget: summary.budget,
              totals: summary.totals,
              reconciliation: summary.reconciliation,
            } as Prisma.InputJsonObject,
          },
        });
      }
      if (
        decision === "SETTLED" &&
        disableReason &&
        input.status !== "UNKNOWN"
      ) {
        const disabled = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT disable_site_build_paid_calls(
            ${scope.workspaceId}::uuid,
            ${scope.buildRunId}::uuid,
            ${disableReason}::text
          ) AS count
        `;
        if (disabled[0]?.count !== 1) {
          throw new Error("atomic paid-call disable target missing");
        }
      }
      return decision;
    });
  }

  async assertAuthorizedBudget(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
  }): Promise<void> {
    await this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const [budget, grant] = await Promise.all([
        tx.siteBuildBudget.findUnique({
          where: { buildRunId: input.buildRunId },
          select: { workspaceId: true, siteId: true, capMicrousd: true },
        }),
        tx.siteBuildBudgetGrant.findUnique({
          where: { buildRunId: input.buildRunId },
          select: { workspaceId: true, siteId: true, capMicrousd: true },
        }),
      ]);
      if (
        !budget ||
        !grant ||
        budget.workspaceId !== input.workspaceId ||
        grant.workspaceId !== input.workspaceId ||
        budget.siteId !== input.siteId ||
        grant.siteId !== input.siteId ||
        budget.capMicrousd !== grant.capMicrousd
      ) {
        throw new PaidCallDeniedError("DENIED_BUDGET_AUTHORIZATION");
      }
    });
  }

  async disablePaidCalls(
    workspaceId: string,
    buildRunId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.withWorkspace(workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-progress-${buildRunId}`}))`;
      await tx.$queryRaw`
        SELECT disable_site_build_paid_calls(
          ${workspaceId}::uuid,
          ${buildRunId}::uuid,
          ${reason.slice(0, 80)}::text
        )
      `;
    });
  }

  async closeAndSummarize(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    reason: string;
  }): Promise<SiteBuildCostSummary> {
    const reason = input.reason.trim().slice(0, 80);
    if (!reason) throw new Error("terminal paid-call reason is required");

    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$queryRaw<Array<{ reconciled: number }>>`
        SELECT reconcile_site_build_spend(
          ${input.workspaceId}::uuid,
          ${input.buildRunId}::uuid
        ) AS reconciled
      `;
      await tx.$queryRaw`
        SELECT disable_site_build_paid_calls(
          ${input.workspaceId}::uuid,
          ${input.buildRunId}::uuid,
          ${reason}::text
        )
      `;
      const [budget, spends, reconciliations] = await Promise.all([
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
            id: true,
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
          orderBy: { operationKey: "asc" },
        }),
        tx.siteBuildSpendReconciliation.findMany({
          where: { buildRunId: input.buildRunId },
          select: {
            spendId: true,
            status: true,
            exactCostMicrousd: true,
            createdAt: true,
          },
          orderBy: [{ spendId: "asc" }, { attemptNo: "asc" }],
        }),
      ]);
      if (!budget) {
        throw new PaidCallDeniedError("DENIED_NO_BUDGET");
      }
      return buildSiteBuildCostSummary(budget, spends, reconciliations);
    });
  }

  async listPendingReconciliations(
    workspaceId: string,
    limit = 50,
  ): Promise<
    Array<{
      workspaceId: string;
      siteId: string;
      buildRunId: string;
      spendId: string;
      operationKey: string;
      meta: Record<string, unknown> | null;
      action: "RESOLVE" | "EXPIRE";
    }>
  > {
    const take = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx.siteBuildSpend.findMany({
        where: {
          workspaceId,
          costBasis: { in: ["estimated_upper_bound", "unknown"] },
          reconciliations: {
            none: { status: { in: ["RESOLVED", "CONFLICT", "EXPIRED"] } },
          },
        },
        select: {
          id: true,
          workspaceId: true,
          siteId: true,
          buildRunId: true,
          operationKey: true,
          meta: true,
          createdAt: true,
          reconciliations: {
            select: { status: true, observedAt: true },
            orderBy: { attemptNo: "asc" },
          },
        },
        orderBy: { createdAt: "asc" },
        take,
      });
      return rows.flatMap((row) => {
        const action = reconciliationDueAction({
          now: this.now(),
          spendCreatedAt: row.createdAt,
          observations: row.reconciliations,
        });
        if (action !== "RESOLVE" && action !== "EXPIRE") return [];
        return [
          {
            workspaceId: row.workspaceId,
            siteId: row.siteId,
            buildRunId: row.buildRunId,
            operationKey: row.operationKey,
            meta:
              row.meta &&
              typeof row.meta === "object" &&
              !Array.isArray(row.meta)
                ? (row.meta as Record<string, unknown>)
                : null,
            spendId: row.id,
            action,
          },
        ];
      });
    });
  }

  async runReconciliationSweep(input: {
    workspaceId: string;
    limit?: number;
    resolve: (candidate: {
      spendId: string;
      operationKey: string;
      meta: Record<string, unknown> | null;
    }) => Promise<SiteBuildReconciliationObservation>;
  }): Promise<{ attempted: number; resolved: number }> {
    const candidates = await this.listPendingReconciliations(
      input.workspaceId,
      input.limit,
    );
    let resolved = 0;
    for (const candidate of candidates) {
      let observation: SiteBuildReconciliationObservation;
      try {
        observation =
          candidate.action === "EXPIRE"
            ? {
                status: "EXPIRED",
                resolverId: "reconciliation-sweep-v1",
                observedAt: this.now(),
                meta: { reason: "reconciliation_window_expired" },
              }
            : await input.resolve(candidate);
      } catch {
        observation = {
          status: "UNRESOLVED",
          resolverId: "reconciliation-sweep-v1",
          observedAt: this.now(),
          meta: { reason: "resolver_unavailable" },
        };
      }
      await this.appendReconciliation({
        ...candidate,
        observation,
      });
      if (observation.status === "RESOLVED") resolved += 1;
    }
    return { attempted: candidates.length, resolved };
  }

  async appendReconciliation(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    spendId: string;
    observation: SiteBuildReconciliationObservation;
  }): Promise<SiteBuildCostSummary> {
    const { observation } = input;
    const resolverId = observation.resolverId.trim();
    if (!resolverId || resolverId.length > 191) {
      throw new Error("reconciliation resolver id is invalid");
    }
    const receiptDigest = observation.receiptDigest ?? null;
    if (receiptDigest !== null && !/^[0-9a-f]{64}$/.test(receiptDigest)) {
      throw new Error("reconciliation receipt digest is invalid");
    }
    const exact = observation.exactCostMicrousd;
    if (
      observation.status === "RESOLVED"
        ? !receiptDigest ||
          !observation.costBasis ||
          typeof exact !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(exact) ||
          BigInt(exact) > 9_223_372_036_854_775_807n
        : exact !== undefined || observation.costBasis !== undefined
    ) {
      throw new Error("reconciliation observation shape is invalid");
    }
    const safeMeta = boundedReconciliationMeta(observation.meta);

    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-build-reconciliation-${input.spendId}`}))`;
      const spend = await tx.siteBuildSpend.findFirst({
        where: {
          id: input.spendId,
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          buildRunId: input.buildRunId,
        },
        select: { id: true, reservationMicrousd: true },
      });
      if (!spend) throw new Error("reconciliation spend scope is invalid");
      const prior = receiptDigest
        ? await tx.siteBuildSpendReconciliation.findFirst({
            where: { spendId: input.spendId, receiptDigest },
          })
        : null;
      if (!prior) {
        const existingResolved =
          observation.status === "RESOLVED"
            ? await tx.siteBuildSpendReconciliation.findFirst({
                where: { spendId: input.spendId, status: "RESOLVED" },
                select: { receiptDigest: true },
              })
            : null;
        const effectiveObservation: SiteBuildReconciliationObservation =
          existingResolved &&
          existingResolved.receiptDigest !== observation.receiptDigest
            ? {
                status: "CONFLICT",
                resolverId,
                requestId: observation.requestId,
                receiptDigest: observation.receiptDigest,
                observedAt: observation.observedAt,
                meta: { reason: "conflicting_resolved_receipt" },
              }
            : observation;
        const last = await tx.siteBuildSpendReconciliation.findFirst({
          where: { spendId: input.spendId },
          select: { attemptNo: true },
          orderBy: { attemptNo: "desc" },
        });
        await tx.siteBuildSpendReconciliation.create({
          data: {
            workspaceId: input.workspaceId,
            siteId: input.siteId,
            buildRunId: input.buildRunId,
            spendId: input.spendId,
            attemptNo: (last?.attemptNo ?? 0) + 1,
            status: effectiveObservation.status,
            resolverId,
            requestId: effectiveObservation.requestId ?? null,
            receiptDigest: effectiveObservation.receiptDigest ?? null,
            costBasis: effectiveObservation.costBasis ?? null,
            exactCostMicrousd:
              effectiveObservation.exactCostMicrousd === undefined
                ? null
                : BigInt(effectiveObservation.exactCostMicrousd),
            inputTokens: effectiveObservation.inputTokens ?? null,
            outputTokens: effectiveObservation.outputTokens ?? null,
            observedAt: effectiveObservation.observedAt,
            meta:
              effectiveObservation === observation
                ? safeMeta
                : ({
                    reason: "conflicting_resolved_receipt",
                  } as Prisma.InputJsonObject),
          },
        });
        if (
          effectiveObservation.status === "RESOLVED" &&
          BigInt(effectiveObservation.exactCostMicrousd!) >
            spend.reservationMicrousd
        ) {
          await tx.siteBuildSpendReconciliation.create({
            data: {
              workspaceId: input.workspaceId,
              siteId: input.siteId,
              buildRunId: input.buildRunId,
              spendId: input.spendId,
              attemptNo: (last?.attemptNo ?? 0) + 2,
              status: "CONFLICT",
              resolverId: "site-build-cap-variance-v1",
              requestId: effectiveObservation.requestId ?? null,
              receiptDigest: null,
              costBasis: null,
              exactCostMicrousd: null,
              inputTokens: null,
              outputTokens: null,
              observedAt: effectiveObservation.observedAt,
              meta: {
                reason: "CAP_VARIANCE",
                observedMicrousd: effectiveObservation.exactCostMicrousd!,
                authorizedMicrousd: spend.reservationMicrousd.toString(10),
              },
            },
          });
          await tx.$queryRaw`
            SELECT disable_site_build_paid_calls(
              ${input.workspaceId}::uuid,
              ${input.buildRunId}::uuid,
              ${"reconciliation_cap_variance"}::text
            )
          `;
        }
      }

      const [budget, spends, reconciliations] = await Promise.all([
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
            id: true,
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
        }),
        tx.siteBuildSpendReconciliation.findMany({
          where: { buildRunId: input.buildRunId },
          select: {
            spendId: true,
            status: true,
            exactCostMicrousd: true,
            createdAt: true,
          },
        }),
      ]);
      if (!budget) throw new PaidCallDeniedError("DENIED_NO_BUDGET");
      const summary = buildSiteBuildCostSummary(
        budget,
        spends,
        reconciliations,
      );
      if (prior) return summary;
      const summaryJson = summary as unknown as Prisma.InputJsonObject;
      await tx.siteBuildRun.update({
        where: { id: input.buildRunId },
        data: { costSummary: summaryJson },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: input.workspaceId,
          eventType: "SiteBuildCostSummaryUpdated",
          schemaVersion: 1,
          aggregateType: "SiteBuildRun",
          aggregateId: input.buildRunId,
          privacyClassification: "INTERNAL",
          payload: {
            workspaceId: input.workspaceId,
            siteId: input.siteId,
            buildRunId: input.buildRunId,
            revision: summary.reconciliation.revision,
            summaryDigest: createHash("sha256")
              .update(JSON.stringify(summary))
              .digest("hex"),
            budget: summary.budget,
            totals: summary.totals,
            reconciliation: summary.reconciliation,
          } as Prisma.InputJsonObject,
        },
      });
      return summary;
    });
  }

  async claimTaskAttempt(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    taskId: string;
  }): Promise<
    | { kind: "completed"; result: Record<string, unknown> }
    | { kind: "claimed"; attempt: ClaimedTaskAttempt }
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
      if (existing?.status === "SUCCEEDED") {
        if (
          !existing.resultJson ||
          typeof existing.resultJson !== "object" ||
          Array.isArray(existing.resultJson)
        ) {
          throw new Error("completed paid task has no stable result");
        }
        return {
          kind: "completed",
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
      if (!run || run.status !== "running") {
        throw new PaidCallDeniedError("DENIED_STATE");
      }
      if (!budget?.paidCallsEnabled && existing?.status !== "MODEL_SUCCEEDED") {
        throw new PaidCallDeniedError("DENIED_KILL_SWITCH");
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
        kind: "claimed",
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
      const inputHash = createHash("sha256")
        .update(JSON.stringify(input), "utf8")
        .digest("hex");
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
          status: "INPUT_READY",
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
      status: "MODEL_SUCCEEDED",
    });
  }

  async completeTask(
    fence: { workspaceId: string; attemptId: string; fenceToken: string },
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.updateFencedTask(fence, {
      resultJson: jsonObject(result) as Prisma.InputJsonObject,
      status: "SUCCEEDED",
      leaseUntil: this.now(),
    });
  }

  async releaseTask(fence: {
    workspaceId: string;
    attemptId: string;
    fenceToken: string;
  }): Promise<void> {
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
