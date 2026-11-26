import { createHash } from "node:crypto";

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

export interface PaidOperationScope {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  taskAttemptId?: string;
  fenceToken?: string;
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
