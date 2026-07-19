import { createHash } from 'node:crypto';
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
      unknownOperations: operationCount('UNKNOWN'),
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
