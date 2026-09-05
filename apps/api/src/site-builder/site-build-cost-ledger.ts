import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type {
  GatewaySettlementObservation,
  PaidModelPhysicalWireRuntime,
  PaidModelPreflightEvidence,
} from "../model-gateway/paid-model-settlement";
import type { SettlementWireIdentity } from "../model-gateway/settlement-wire-identity";
import type { NewApiSettlementReadbackProbe } from "../model-gateway/new-api-request-bound-settlement";
import { createProviderTransportObservation } from "../model-gateway/provider-transport-observation";
import type { ModelUsage } from "../model-gateway/types";
import { boundedModelTokenCount, MODEL_USAGE_TOKEN_MAXIMUM } from "../model-gateway/model-usage-boundary";
import { BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE } from "./agents/model-policy.registry";
import type { SiteBuildProviderWireWorkspaceDatabase } from "./site-build-provider-wire.database";

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

export const SITE_BUILD_DURABLE_TOKEN_MAXIMUM = MODEL_USAGE_TOKEN_MAXIMUM;

function nonNegativeInt(value: number | undefined): number | null {
  return boundedModelTokenCount(value) ?? null;
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
      new Set(
        settled.map(
          (observation) =>
            (observation as unknown as { requestId?: string }).requestId,
        ),
      ).size === callCount &&
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
  const v1Settled = gatewaySettlements.filter(
    (observation) => observation.status === "settled",
  );
  if (
    gatewaySettlements.length === callCount &&
    v1Settled.length === callCount &&
    input.resolvedModel === input.requestedModel &&
    new Set(v1Settled.map((observation) => observation.physicalWireAttempt))
      .size === callCount &&
    v1Settled.every(
      (observation) =>
        observation.resolverId === "new-api-request-bound-reconciliation-v1" &&
        observation.basis === "openox_catalog_token_pricing" &&
        observation.transportObservation.schemaVersion ===
          "site-build-provider-transport-observation/v1",
    )
  ) {
    const calculatedCostMicrousd = v1Settled.reduce(
      (sum, observation) => sum + observation.costMicrousd,
      0,
    );
    if (
      Number.isSafeInteger(calculatedCostMicrousd) &&
      calculatedCostMicrousd >= 0 &&
      calculatedCostMicrousd <= input.reservationMicrousd
    ) {
      return {
        basis: "token_pricing",
        budgetChargeMicrousd: calculatedCostMicrousd,
        reportedCostMicrousd: null,
        calculatedCostMicrousd,
        estimatedCostMicrousd: null,
        inputTokens: v1Settled.reduce(
          (sum, observation) => sum + observation.inputTokens,
          0,
        ),
        outputTokens: v1Settled.reduce(
          (sum, observation) => sum + observation.outputTokens,
          0,
        ),
        callCount,
        meta: { gatewaySettlements },
      };
    }
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
  costBasis?: "provider_reported" | "token_pricing" | "not_incurred";
  exactCostMicrousd?: string;
  inputTokens?: number;
  outputTokens?: number;
  observedAt: Date;
  meta?: Record<string, unknown>;
}

export interface SiteBuildProviderReconciliationCandidate {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  spendId: string;
  wireAttemptId: string;
  operationKey: string;
  physicalWireAttempt: 1 | 2;
  derivationKeyId: string;
  settlementRequestId: string;
  settlementNonceSha256: string;
  resolverId: string;
  alias: string;
  protocol:
    "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  expectedChannelId: number;
  actualMaxOutputTokens: number;
  maximumQuotaPoints: number;
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
  wireState:
    | "ALLOCATED"
    | "DISPATCH_STARTED"
    | "OBSERVED"
    | "UNKNOWN"
    | "NOT_DISPATCHED";
  receiptRecorded: boolean;
  action: "RESOLVE" | "EXPIRE";
}

const RECONCILIATION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;
const RECONCILIATION_EXPIRY_MS = 24 * 60 * 60_000;
// 300s maximum provider transport + 30s synchronous readback + bounded DB ACK
// retries, connection-pool scheduling, and event-loop delay. Ten minutes keeps
// recovery conservative without approaching the 24-hour terminal expiry.
export const SITE_BUILD_PROVIDER_WIRE_OWNER_LEASE_MS = 10 * 60_000;
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
  /** Preallocated before reserve; plaintext nonces remain transient. */
  settlementWireIdentities?: readonly SettlementWireIdentity[];
  /** Exactly one identity selected by the caller for the next physical send. */
  settlementPhysicalWire?: PaidModelPhysicalWireRuntime;
  /** Allocates attempt 2 only after attempt 1 was durably finalized exact. */
  allocateSettlementRepairWire?: () => Promise<PaidModelPhysicalWireRuntime>;
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

export interface PaidModelWireReservationContext {
  wireIdentity: SettlementWireIdentity;
  protocol:
    "openai-chat-completions" | "openai-responses" | "anthropic-messages";
  requestedAlias: string;
  expectedChannelId: number;
  promptUtf8Bytes: number;
  maximumWireCalls: 1 | 2;
  actualMaxOutputTokens: number;
  catalogMaxOutputTokens: number;
  maximumQuotaPoints: number;
  catalogId: string;
  catalogSha256: string;
  pricingSnapshotSha256: string;
  inputPriceMicrounitsPerMillionTokens: number;
  outputPriceMicrounitsPerMillionTokens: number;
  ledgerMicrousdPerPricingUnit: number;
}

export interface PaidModelExecuteDecision {
  kind: "execute";
  spendId: string;
  wireAttemptId: string;
  physicalWireAttempt: 1 | 2;
}

interface ReserveRow {
  decision: string;
  spend_id: string | null;
  spend_status: string | null;
  cached_result: Record<string, unknown> | null;
  cached_meta: Record<string, unknown> | null;
  cached_error_code: string | null;
}

interface ModelReserveRow extends ReserveRow {
  wire_attempt_id: string | null;
  physical_wire_attempt: number | null;
  wire_state: string | null;
}

interface LedgerRuntimeDeps {
  now?: () => Date;
  randomUUID?: () => string;
  providerWireDatabase?: SiteBuildProviderWireWorkspaceDatabase;
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
  private readonly providerWireDatabase?: SiteBuildProviderWireWorkspaceDatabase;

  constructor(
    private readonly prisma: PrismaService,
    deps: LedgerRuntimeDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
    this.randomUUID = deps.randomUUID ?? nodeRandomUUID;
    this.providerWireDatabase = deps.providerWireDatabase;
  }

  private requireProviderWireDatabase(): SiteBuildProviderWireWorkspaceDatabase {
    if (!this.providerWireDatabase) {
      throw new PaidCallDeniedError("MODEL_WIRE_DATABASE_UNAVAILABLE");
    }
    return this.providerWireDatabase;
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

  async reserveModelOperation(
    input: PaidOperationReservation & {
      kind: "model";
      wire: PaidModelWireReservationContext;
    },
  ): Promise<
    | PaidModelExecuteDecision
    | Exclude<PaidOperationDecision, { kind: "execute" }>
  > {
    if (!/^[0-9a-f]{64}$/.test(input.operationKey)) {
      throw new Error("paid operation key must be a lowercase SHA-256");
    }
    const wire = input.wire;
    const rows = await this.requireProviderWireDatabase().withWorkspace(
      input.workspaceId,
      (tx) =>
        tx.$queryRaw<ModelReserveRow[]>`
        SELECT * FROM reserve_site_build_model_spend_v1(
          ${input.workspaceId}::uuid,
          ${input.buildRunId}::uuid,
          ${input.taskAttemptId ?? null}::uuid,
          ${input.fenceToken ?? null}::uuid,
          ${input.operationKey}::varchar,
          ${input.taskId}::text,
          ${input.subject}::text,
          ${BigInt(input.reservationMicrousd)}::bigint,
          ${asJsonText(input.meta)}::jsonb,
          ${wire.wireIdentity.derivationKeyId}::varchar,
          ${wire.wireIdentity.requestId}::varchar,
          ${wire.wireIdentity.nonceSha256}::varchar,
          ${"new-api-request-bound-reconciliation-v1"}::varchar,
          ${wire.protocol}::varchar,
          ${wire.requestedAlias}::varchar,
          ${wire.expectedChannelId}::integer,
          ${wire.promptUtf8Bytes}::integer,
          ${wire.maximumWireCalls}::integer,
          ${wire.actualMaxOutputTokens}::integer,
          ${wire.catalogMaxOutputTokens}::integer,
          ${BigInt(wire.maximumQuotaPoints)}::bigint,
          ${wire.catalogId}::varchar,
          ${wire.catalogSha256}::varchar,
          ${wire.pricingSnapshotSha256}::varchar,
          ${BigInt(wire.inputPriceMicrounitsPerMillionTokens)}::bigint,
          ${BigInt(wire.outputPriceMicrounitsPerMillionTokens)}::bigint,
          ${BigInt(wire.ledgerMicrousdPerPricingUnit)}::bigint
        )
      `,
    );
    const row = rows[0];
    if (!row) throw new PaidCallDeniedError("EMPTY_MODEL_RESERVE_RESULT");
    if (row.decision === "EXECUTE") {
      if (
        !row.spend_id ||
        !row.wire_attempt_id ||
        row.physical_wire_attempt !== 1
      ) {
        throw new PaidCallDeniedError("MODEL_WIRE_RESERVE_RESULT_INVALID");
      }
      return {
        kind: "execute",
        spendId: row.spend_id,
        wireAttemptId: row.wire_attempt_id,
        physicalWireAttempt: 1,
      };
    }
    if (row.decision === "REPLAY") {
      if (
        row.spend_status === "RESERVED" &&
        row.spend_id &&
        row.wire_attempt_id &&
        row.physical_wire_attempt === 1 &&
        row.wire_state === "ALLOCATED"
      ) {
        return {
          kind: "execute",
          spendId: row.spend_id,
          wireAttemptId: row.wire_attempt_id,
          physicalWireAttempt: 1,
        };
      }
      if (row.spend_status === "UNKNOWN" || row.spend_status === "RESERVED") {
        throw new PaidOperationUnknownError(
          input.operationKey,
          row.cached_error_code ?? "MODEL_WIRE_ALREADY_ALLOCATED",
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
    if (row.decision === "LEGACY_MODEL_SPEND" || row.decision === "UNKNOWN") {
      throw new PaidOperationUnknownError(
        input.operationKey,
        row.cached_error_code ?? row.decision,
      );
    }
    throw new PaidCallDeniedError(row.decision);
  }

  async allocateModelPhysicalWire(input: {
    scope: PaidOperationReservation;
    spendId: string;
    wireIdentity: SettlementWireIdentity;
  }): Promise<PaidModelExecuteDecision> {
    type AllocationRow = {
      decision: string;
      wire_attempt_id: string | null;
      physical_wire_attempt: number | null;
      wire_state: string | null;
    };
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.scope.workspaceId,
        (tx) =>
          tx.$queryRaw<AllocationRow[]>`
        SELECT * FROM allocate_site_build_provider_wire_v1(
          ${input.scope.workspaceId}::uuid,
          ${input.scope.buildRunId}::uuid,
          ${input.spendId}::uuid,
          ${input.scope.operationKey}::varchar,
          ${input.scope.fenceToken ?? null}::uuid,
          ${input.wireIdentity.derivationKeyId}::varchar,
          ${input.wireIdentity.requestId}::varchar,
          ${input.wireIdentity.nonceSha256}::varchar
        )
      `,
      );
    let rows: AllocationRow[];
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    const row = rows[0];
    if (
      (row?.decision !== "EXECUTE" && row?.decision !== "REPLAY") ||
      !row.wire_attempt_id ||
      row.physical_wire_attempt !== 2 ||
      row.wire_state !== "ALLOCATED"
    ) {
      throw new PaidOperationUnknownError(
        input.scope.operationKey,
        row?.decision ?? "MODEL_WIRE_ALLOCATION_UNAVAILABLE",
      );
    }
    return {
      kind: "execute",
      spendId: input.spendId,
      wireAttemptId: row.wire_attempt_id,
      physicalWireAttempt: 2,
    };
  }

  async beginModelPhysicalWire(input: {
    workspaceId: string;
    wireAttemptId: string;
    fenceToken?: string;
  }): Promise<"DISPATCH" | "READBACK_ONLY"> {
    const rows = await this.requireProviderWireDatabase().withWorkspace(
      input.workspaceId,
      (tx) =>
        tx.$queryRaw<Array<{ decision: string }>>`
        SELECT begin_site_build_provider_wire_v1(
          ${input.workspaceId}::uuid,
          ${input.wireAttemptId}::uuid,
          ${input.fenceToken ?? null}::uuid
        ) AS decision
      `,
    );
    const decision = rows[0]?.decision;
    if (decision !== "DISPATCH" && decision !== "READBACK_ONLY") {
      throw new PaidCallDeniedError("MODEL_WIRE_SEND_CUT_UNAVAILABLE");
    }
    return decision;
  }

  async claimModelReadbackProbe(input: {
    workspaceId: string;
    wireAttemptId: string;
    sequence: 1 | 2;
  }): Promise<string | null> {
    const rows = await this.requireProviderWireDatabase().withWorkspace(
      input.workspaceId,
      (tx) =>
        tx.$queryRaw<Array<{ decision: string; probe_id: string | null }>>`
        SELECT * FROM claim_site_build_provider_readback_probe_v1(
          ${input.workspaceId}::uuid,
          ${input.wireAttemptId}::uuid,
          ${input.sequence}::integer
        )
      `,
    );
    const row = rows[0];
    return row?.decision === "CLAIMED" && row.probe_id ? row.probe_id : null;
  }

  async recordModelReadbackProbe(input: {
    workspaceId: string;
    probeId: string;
    probe: NewApiSettlementReadbackProbe;
    observedAt: Date;
  }): Promise<void> {
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<Array<{ decision: string }>>`
          SELECT record_site_build_provider_readback_probe_v1(
            ${input.workspaceId}::uuid,
            ${input.probeId}::uuid,
            ${input.probe.phase}::varchar,
            ${input.probe.httpStatusClass}::integer,
            ${input.observedAt}::timestamptz
          ) AS decision
        `,
      );
    let rows;
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    if (!new Set(["RECORDED", "REPLAY"]).has(rows[0]?.decision ?? "")) {
      throw new PaidOperationUnknownError(
        input.probeId,
        "MODEL_READBACK_PROBE_ACK_UNKNOWN",
      );
    }
  }

  async finalizeModelPhysicalWire(input: {
    workspaceId: string;
    wireAttemptId: string;
    observation: GatewaySettlementObservation;
    observedAt: Date;
  }): Promise<void> {
    const transport = input.observation.transportObservation;
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<Array<{ decision: string }>>`
          SELECT finalize_site_build_provider_wire_v1(
            ${input.workspaceId}::uuid,
            ${input.wireAttemptId}::uuid,
            ${input.observation.status === "settled" ? "SETTLED" : "UNKNOWN"}::varchar,
            ${transport.finalPhase}::varchar,
            ${transport.gatewayIdState}::varchar,
            ${transport.upstreamIdState}::varchar,
            ${transport.payloadState}::varchar,
            ${input.observedAt}::timestamptz
          ) AS decision
        `,
      );
    let rows;
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    if (!new Set(["FINALIZED", "REPLAY"]).has(rows[0]?.decision ?? "")) {
      throw new PaidOperationUnknownError(
        input.wireAttemptId,
        "MODEL_WIRE_OBSERVATION_ACK_UNKNOWN",
      );
    }
  }

  async recordModelPhysicalWireReceipt(input: {
    workspaceId: string;
    wireAttemptId: string;
    observation: Extract<GatewaySettlementObservation, { status: "settled" }>;
    receiptDigest: string;
    observedAt: Date;
  }): Promise<void> {
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<Array<{ decision: string }>>`
          SELECT record_site_build_provider_wire_receipt_v1(
            ${input.workspaceId}::uuid,
            ${input.wireAttemptId}::uuid,
            ${input.receiptDigest}::varchar,
            ${input.observation.alias}::varchar,
            ${input.observation.protocol}::varchar,
            ${input.observation.channelId}::integer,
            ${BigInt(input.observation.quota)}::bigint,
            ${input.observation.inputTokens}::integer,
            ${input.observation.outputTokens}::integer,
            ${BigInt(input.observation.costMicrousd)}::bigint,
            ${input.observation.upstreamIdState}::varchar,
            ${input.observedAt}::timestamptz
          ) AS decision
        `,
      );
    let rows;
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    if (!new Set(["RECORDED", "REPLAY"]).has(rows[0]?.decision ?? "")) {
      throw new PaidOperationUnknownError(
        input.wireAttemptId,
        "MODEL_WIRE_RECEIPT_ACK_UNKNOWN",
      );
    }
  }

  async finalizeModelPhysicalWireFromReceipt(input: {
    workspaceId: string;
    wireAttemptId: string;
  }): Promise<void> {
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<Array<{ decision: string }>>`
          SELECT finalize_site_build_provider_wire_from_receipt_v1(
            ${input.workspaceId}::uuid,
            ${input.wireAttemptId}::uuid
          ) AS decision
        `,
      );
    let rows;
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    if (!new Set(["FINALIZED", "REPLAY"]).has(rows[0]?.decision ?? "")) {
      throw new PaidOperationUnknownError(
        input.wireAttemptId,
        "MODEL_WIRE_OBSERVATION_ACK_UNKNOWN",
      );
    }
  }

  async finalizeModelPhysicalWireNotDispatched(input: {
    workspaceId: string;
    wireAttemptId: string;
  }): Promise<void> {
    const execute = () =>
      this.requireProviderWireDatabase().withWorkspace(
        input.workspaceId,
        (tx) =>
          tx.$queryRaw<Array<{ decision: string }>>`
          SELECT finalize_site_build_provider_wire_not_dispatched_v1(
            ${input.workspaceId}::uuid,
            ${input.wireAttemptId}::uuid
          ) AS decision
        `,
      );
    let rows;
    try {
      rows = await execute();
    } catch {
      rows = await execute();
    }
    if (!new Set(["FINALIZED", "REPLAY"]).has(rows[0]?.decision ?? "")) {
      throw new PaidOperationUnknownError(
        input.wireAttemptId,
        "MODEL_WIRE_NOT_DISPATCHED_ACK_UNKNOWN",
      );
    }
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
    const database =
      scope.kind === "model" ? this.requireProviderWireDatabase() : this.prisma;
    const persistedCallCount =
      measurement.basis === "not_incurred" ? null : measurement.callCount;
    return database.withWorkspace(scope.workspaceId, async (tx) => {
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
          ${persistedCallCount}::integer,
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
          ${persistedCallCount}::integer,
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

    const database = this.providerWireDatabase ?? this.prisma;
    return database.withWorkspace(input.workspaceId, async (tx) => {
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

  async completeProviderSpendReconciliation(input: {
    workspaceId: string;
    siteId: string;
    buildRunId: string;
    spendId: string;
    resolverId: string;
    observedAt: Date;
  }): Promise<SiteBuildReconciliationObservation> {
    return this.requireProviderWireDatabase().withWorkspace(
      input.workspaceId,
      async (tx) => {
        const [spend, wires, receipts] = await Promise.all([
          tx.siteBuildSpend.findFirst({
            where: {
              id: input.spendId,
              workspaceId: input.workspaceId,
              siteId: input.siteId,
              buildRunId: input.buildRunId,
            },
            select: {
              status: true,
              operationKey: true,
              fenceToken: true,
              reservationMicrousd: true,
            },
          }),
          tx.siteBuildProviderWireAttempt.findMany({
            where: {
              workspaceId: input.workspaceId,
              siteId: input.siteId,
              buildRunId: input.buildRunId,
              spendId: input.spendId,
            },
            select: { id: true, physicalWireAttempt: true, state: true },
            orderBy: { physicalWireAttempt: "asc" },
          }),
          tx.siteBuildProviderWireReceipt.findMany({
            where: {
              workspaceId: input.workspaceId,
              siteId: input.siteId,
              buildRunId: input.buildRunId,
              spendId: input.spendId,
            },
            select: {
              wireAttemptId: true,
              receiptDigest: true,
              exactCostMicrousd: true,
              inputTokens: true,
              outputTokens: true,
            },
            orderBy: { wireAttemptId: "asc" },
          }),
        ]);
        if (!spend || wires.length === 0) {
          return {
            status: "UNRESOLVED",
            resolverId: input.resolverId,
            observedAt: input.observedAt,
            meta: { reason: "provider_wire_scope_unavailable" },
          };
        }
        const physicalWires = wires.filter(
          (wire) => wire.state === "OBSERVED" || wire.state === "UNKNOWN",
        );
        const allAttemptsFinal = wires.every((wire) =>
          ["OBSERVED", "UNKNOWN", "NOT_DISPATCHED"].includes(wire.state),
        );
        const physicalWireIds = new Set(physicalWires.map((wire) => wire.id));
        const receiptWireIds = new Set(
          receipts.map((receipt) => receipt.wireAttemptId),
        );
        const receiptsComplete =
          receipts.length === physicalWires.length &&
          receiptWireIds.size === receipts.length &&
          receipts.every((receipt) =>
            physicalWireIds.has(receipt.wireAttemptId),
          );
        const exactCost = receipts.reduce(
          (sum, receipt) => sum + receipt.exactCostMicrousd,
          0n,
        );
        const inputTokens = receipts.reduce(
          (sum, receipt) => sum + receipt.inputTokens,
          0,
        );
        const outputTokens = receipts.reduce(
          (sum, receipt) => sum + receipt.outputTokens,
          0,
        );
        const aggregateValid =
          exactCost <= 9_223_372_036_854_775_807n &&
          Number.isSafeInteger(inputTokens) &&
          Number.isSafeInteger(outputTokens);

        if (spend.status === "RESERVED") {
          if (!allAttemptsFinal) {
            return {
              status: "UNRESOLVED",
              resolverId: input.resolverId,
              observedAt: input.observedAt,
              meta: { reason: "provider_wire_observation_incomplete" },
            };
          }
          const recoveryMeta = asJsonText({
            schemaVersion: "site-build-provider-spend-ack-recovery/v1",
            reason:
              physicalWires.length === 0
                ? "all_attempts_not_dispatched"
                : "database_ack_recovery_after_send_cut",
            physicalWireCount: physicalWires.length,
            notDispatchedCount: wires.length - physicalWires.length,
            exactReceiptCount: receipts.length,
          });
          let rows: Array<{ decision: string }>;
          if (physicalWires.length === 0) {
            rows = await tx.$queryRaw<Array<{ decision: string }>>`
              SELECT settle_site_build_spend(
                ${input.workspaceId}::uuid,
                ${input.buildRunId}::uuid,
                ${spend.operationKey}::varchar,
                ${spend.fenceToken}::uuid,
                ${"RELEASED"}::text,
                ${0n}::bigint,
                ${"not_incurred"}::text,
                ${null}::bigint, ${null}::bigint, ${null}::bigint,
                ${null}::integer, ${null}::integer, ${null}::integer,
                ${null}::jsonb,
                ${recoveryMeta}::jsonb,
                ${"MODEL_WIRE_NOT_DISPATCHED"}::text
              ) AS decision
            `;
          } else if (
            physicalWires.some((wire) => wire.state === "UNKNOWN") ||
            !receiptsComplete ||
            !aggregateValid
          ) {
            rows = await tx.$queryRaw<Array<{ decision: string }>>`
              SELECT settle_unknown_site_build_spend(
                ${input.workspaceId}::uuid,
                ${input.buildRunId}::uuid,
                ${spend.operationKey}::varchar,
                ${spend.fenceToken}::uuid,
                ${spend.reservationMicrousd}::bigint,
                ${receipts.length === 0 ? null : inputTokens}::integer,
                ${receipts.length === 0 ? null : outputTokens}::integer,
                ${physicalWires.length}::integer,
                ${recoveryMeta}::jsonb,
                ${"MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN"}::text,
                ${"MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN"}::text
              ) AS decision
            `;
          } else {
            rows = await tx.$queryRaw<Array<{ decision: string }>>`
              SELECT settle_site_build_spend(
                ${input.workspaceId}::uuid,
                ${input.buildRunId}::uuid,
                ${spend.operationKey}::varchar,
                ${spend.fenceToken}::uuid,
                ${"FAILED"}::text,
                ${exactCost}::bigint,
                ${"token_pricing"}::text,
                ${null}::bigint, ${exactCost}::bigint, ${null}::bigint,
                ${inputTokens}::integer,
                ${outputTokens}::integer,
                ${physicalWires.length}::integer,
                ${null}::jsonb,
                ${recoveryMeta}::jsonb,
                ${"MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY"}::text
              ) AS decision
            `;
          }
          if (
            !new Set(["SETTLED", "REPLAY", "OVER_RESERVATION"]).has(
              rows[0]?.decision ?? "",
            )
          ) {
            return {
              status: "UNRESOLVED",
              resolverId: input.resolverId,
              observedAt: input.observedAt,
              meta: { reason: "provider_spend_ack_recovery_unavailable" },
            };
          }
        }
        if (physicalWires.length === 0) {
          const receiptDigest = createHash("sha256")
            .update(
              JSON.stringify(
                wires.map((wire) => ({
                  id: wire.id,
                  physicalWireAttempt: wire.physicalWireAttempt,
                  state: wire.state,
                })),
              ),
            )
            .digest("hex");
          return {
            status: "RESOLVED",
            resolverId: input.resolverId,
            receiptDigest,
            costBasis: "not_incurred",
            exactCostMicrousd: "0",
            inputTokens: 0,
            outputTokens: 0,
            observedAt: input.observedAt,
            meta: {
              schemaVersion: "site-build-provider-wire-reconciliation/v1",
              reason: "provider_wire_not_dispatched",
              physicalWireCount: 0,
              notDispatchedCount: wires.length,
              resolvedWireCount: 0,
            },
          };
        }
        if (!receiptsComplete) {
          return {
            status: "UNRESOLVED",
            resolverId: input.resolverId,
            observedAt: input.observedAt,
            meta: { reason: "provider_wire_receipts_incomplete" },
          };
        }
        if (!aggregateValid) {
          return {
            status: "UNRESOLVED",
            resolverId: input.resolverId,
            observedAt: input.observedAt,
            meta: { reason: "provider_wire_receipt_aggregate_invalid" },
          };
        }
        const receiptDigest = createHash("sha256")
          .update(
            JSON.stringify(
              receipts.map((receipt) => ({
                wireAttemptId: receipt.wireAttemptId,
                receiptDigest: receipt.receiptDigest,
              })),
            ),
          )
          .digest("hex");
        return {
          status: "RESOLVED",
          resolverId: input.resolverId,
          receiptDigest,
          costBasis: "token_pricing",
          exactCostMicrousd: exactCost.toString(10),
          inputTokens,
          outputTokens,
          observedAt: input.observedAt,
          meta: {
            schemaVersion: "site-build-provider-wire-reconciliation/v1",
            physicalWireCount: physicalWires.length,
            notDispatchedCount: wires.length - physicalWires.length,
            resolvedWireCount: receipts.length,
          },
        };
      },
    );
  }

  async listPendingReconciliations(
    workspaceId: string,
    limit = 50,
  ): Promise<SiteBuildProviderReconciliationCandidate[]> {
    const take = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const rows = await tx.siteBuildProviderWireAttempt.findMany({
        where: {
          workspaceId,
          state: {
            in: [
              "ALLOCATED",
              "DISPATCH_STARTED",
              "OBSERVED",
              "UNKNOWN",
              "NOT_DISPATCHED",
            ],
          },
          spend: {
            OR: [
              { status: "RESERVED" },
              {
                status: "FAILED",
                errorCode: "MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY",
              },
              {
                status: "RELEASED",
                errorCode: "MODEL_WIRE_NOT_DISPATCHED",
              },
              { costBasis: { in: ["estimated_upper_bound", "unknown"] } },
            ],
            reconciliations: {
              none: {
                status: { in: ["RESOLVED", "CONFLICT", "EXPIRED"] },
              },
            },
          },
        },
        select: {
          id: true,
          workspaceId: true,
          siteId: true,
          buildRunId: true,
          spendId: true,
          operationKey: true,
          physicalWireAttempt: true,
          derivationKeyId: true,
          settlementRequestId: true,
          settlementNonceSha256: true,
          resolverId: true,
          protocol: true,
          requestedAlias: true,
          expectedChannelId: true,
          actualMaxOutputTokens: true,
          maximumQuotaPoints: true,
          inputPriceMicrounitsPerMillion: true,
          outputPriceMicrounitsPerMillion: true,
          ledgerMicrousdPerPricingUnit: true,
          state: true,
          createdAt: true,
          dispatchStartedAt: true,
          observedAt: true,
          receipt: { select: { id: true } },
          spend: {
            select: {
              status: true,
              costBasis: true,
              createdAt: true,
              reconciliations: {
                select: { status: true, observedAt: true },
                orderBy: { attemptNo: "asc" },
              },
            },
          },
        },
        orderBy: [{ createdAt: "asc" }, { physicalWireAttempt: "asc" }],
        take: take * 2,
      });
      const selectedRows = new Map<string, (typeof rows)[number]>();
      const priority = (row: (typeof rows)[number]): number => {
        if (row.state === "ALLOCATED" || row.state === "NOT_DISPATCHED")
          return 0;
        if (!row.receipt && row.state === "DISPATCH_STARTED") return 0;
        if (!row.receipt && row.state === "UNKNOWN") return 1;
        if (row.receipt && row.state === "DISPATCH_STARTED") return 2;
        return 3;
      };
      for (const row of rows) {
        const selected = selectedRows.get(row.spendId);
        if (!selected || priority(row) < priority(selected)) {
          selectedRows.set(row.spendId, row);
        }
      }
      const candidates: SiteBuildProviderReconciliationCandidate[] = [];
      const now = this.now();
      for (const row of selectedRows.values()) {
        if (candidates.length >= take) continue;
        if (
          row.state === "DISPATCH_STARTED" &&
          (!(row.dispatchStartedAt instanceof Date) ||
            now.getTime() <
              row.dispatchStartedAt.getTime() +
                SITE_BUILD_PROVIDER_WIRE_OWNER_LEASE_MS)
        ) {
          continue;
        }
        const recoveryStartedAt =
          row.state === "ALLOCATED"
            ? row.createdAt
            : row.state === "DISPATCH_STARTED"
              ? row.dispatchStartedAt
              : (row.observedAt ??
                row.dispatchStartedAt ??
                row.createdAt ??
                row.spend.createdAt);
        if (!(recoveryStartedAt instanceof Date)) continue;
        const action = reconciliationDueAction({
          now,
          spendCreatedAt: recoveryStartedAt,
          observations: row.spend.reconciliations,
        });
        if (action !== "RESOLVE" && action !== "EXPIRE") continue;
        if (row.state === "ALLOCATED" && action !== "EXPIRE") continue;
        const numeric = [
          row.maximumQuotaPoints,
          row.inputPriceMicrounitsPerMillion,
          row.outputPriceMicrounitsPerMillion,
          row.ledgerMicrousdPerPricingUnit,
        ];
        if (numeric.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) {
          continue;
        }
        candidates.push({
          workspaceId: row.workspaceId,
          siteId: row.siteId,
          buildRunId: row.buildRunId,
          spendId: row.spendId,
          wireAttemptId: row.id,
          operationKey: row.operationKey,
          physicalWireAttempt: row.physicalWireAttempt as 1 | 2,
          derivationKeyId: row.derivationKeyId,
          settlementRequestId: row.settlementRequestId,
          settlementNonceSha256: row.settlementNonceSha256,
          resolverId: row.resolverId,
          alias: row.requestedAlias,
          protocol:
            row.protocol as SiteBuildProviderReconciliationCandidate["protocol"],
          expectedChannelId: row.expectedChannelId,
          actualMaxOutputTokens: row.actualMaxOutputTokens,
          maximumQuotaPoints: Number(row.maximumQuotaPoints),
          inputPriceMicrounitsPerMillionTokens: Number(
            row.inputPriceMicrounitsPerMillion,
          ),
          outputPriceMicrounitsPerMillionTokens: Number(
            row.outputPriceMicrounitsPerMillion,
          ),
          ledgerMicrousdPerPricingUnit: Number(
            row.ledgerMicrousdPerPricingUnit,
          ),
          wireState:
            row.state as SiteBuildProviderReconciliationCandidate["wireState"],
          receiptRecorded: row.receipt !== null,
          action,
        });
      }
      return candidates;
    });
  }

  async runReconciliationSweep(input: {
    workspaceId: string;
    limit?: number;
    resolve: (
      candidate: SiteBuildProviderReconciliationCandidate,
    ) => Promise<SiteBuildReconciliationObservation>;
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
            ? await this.expireProviderReconciliation(candidate)
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

  private async expireProviderReconciliation(
    candidate: SiteBuildProviderReconciliationCandidate,
  ): Promise<SiteBuildReconciliationObservation> {
    const observedAt = this.now();
    try {
      if (candidate.wireState === "ALLOCATED") {
        await this.finalizeModelPhysicalWireNotDispatched({
          workspaceId: candidate.workspaceId,
          wireAttemptId: candidate.wireAttemptId,
        });
        const exact = await this.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: candidate.resolverId,
          observedAt,
        });
        if (exact.status === "RESOLVED") return exact;
        return {
          status: "EXPIRED",
          resolverId: "reconciliation-sweep-v1",
          observedAt,
          meta: { reason: "not_dispatched_recovery_window_expired" },
        };
      }
      if (candidate.receiptRecorded) {
        if (candidate.wireState === "DISPATCH_STARTED") {
          await this.finalizeModelPhysicalWireFromReceipt({
            workspaceId: candidate.workspaceId,
            wireAttemptId: candidate.wireAttemptId,
          });
        }
        const exact = await this.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: candidate.resolverId,
          observedAt,
        });
        if (exact.status === "RESOLVED") return exact;
      } else {
        if (candidate.wireState === "DISPATCH_STARTED") {
          await this.finalizeModelPhysicalWire({
            workspaceId: candidate.workspaceId,
            wireAttemptId: candidate.wireAttemptId,
            observation: {
              status: "unknown",
              physicalWireAttempt: candidate.physicalWireAttempt,
              resolverId: candidate.resolverId,
              reason: "gateway_log_missing",
              transportObservation: createProviderTransportObservation({
                physicalWireAttempt: candidate.physicalWireAttempt,
                finalPhase: "gateway_log_missing",
                gatewayIdState: "not_observable",
                upstreamIdState: "unknown",
                payloadState: "unavailable",
                readbackProbes: [],
              }),
            },
            observedAt,
          });
        }
        await this.completeProviderSpendReconciliation({
          workspaceId: candidate.workspaceId,
          siteId: candidate.siteId,
          buildRunId: candidate.buildRunId,
          spendId: candidate.spendId,
          resolverId: candidate.resolverId,
          observedAt,
        });
      }
      return {
        status: "EXPIRED",
        resolverId: "reconciliation-sweep-v1",
        observedAt,
        meta: { reason: "reconciliation_window_expired" },
      };
    } catch {
      return {
        status: "UNRESOLVED",
        resolverId: "reconciliation-sweep-v1",
        observedAt,
        meta: { reason: "database_ack_unknown" },
      };
    }
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
