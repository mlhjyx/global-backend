import { Prisma } from '@prisma/client';

/**
 * 获客渠道真实合格率统计与动态查询配额分配器（Phase 3 Track 3B）。
 *
 * 将渠道评估口径从「早期召回数 / 粗判 FIT 数」收紧到「最终合格 Lead / 召回候选数」：
 * - 高产源按真实合格率加权获得更多查询配额；
 * - 连续零产噪音源（样本量达标且合格数 = 0）降权至最低探索下限，避免继续烧预算；
 * - 未测试/冷启动渠道通过贝叶斯先验与最低探索下限（默认 10%）获得保护，防止饿死新渠道。
 */

export interface SourceYieldInput {
  readonly providerKey: string;
  readonly recalledCandidates: number;
  readonly finalQualifiedLeads: number;
  readonly costMicrousd?: number;
}

export interface SourceYieldMetric {
  readonly providerKey: string;
  readonly recalledCandidates: number;
  readonly finalQualifiedLeads: number;
  readonly qualifiedRate: number;
  readonly costMicrousd: number;
  readonly costPerQualifiedLeadUsd: number | null;
}

export type SourceYieldTier = 'high_yield' | 'balanced' | 'low_yield_noise' | 'cold_start';

export interface SourceQuotaAllocation extends SourceYieldMetric {
  readonly effectiveWeight: number;
  readonly share: number;
  readonly allocatedQuota: number;
  readonly tier: SourceYieldTier;
}

export interface AllocateSourceQuotasInput {
  readonly sources: readonly SourceYieldInput[];
  readonly totalQuota: number;
  /** 保留给全渠道均匀探索的最低配额比例（默认 0.10 = 10%）。 */
  readonly minExplorationShare?: number;
  /** 冷启动/小样本渠道的先验合格率（默认 0.15）。 */
  readonly coldStartPriorRate?: number;
  /** 认定为「样本足够，可判定零产噪音」的最小召回样本数（默认 5）。 */
  readonly minSamplesForPenalty?: number;
}

export interface SourceQuotaAllocationPlan {
  readonly totalQuota: number;
  readonly minExplorationShare: number;
  readonly allocations: readonly SourceQuotaAllocation[];
}

function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function computeSourceYieldMetrics(
  rows: readonly SourceYieldInput[],
): SourceYieldMetric[] {
  return rows.map((row) => {
    const recalled = nonNegativeInt(row.recalledCandidates);
    const qualified = Math.min(nonNegativeInt(row.finalQualifiedLeads), recalled > 0 ? recalled : nonNegativeInt(row.finalQualifiedLeads));
    const costMicrousd = nonNegativeInt(row.costMicrousd);
    const qualifiedRate = recalled > 0 ? qualified / recalled : 0;
    const costPerQualifiedLeadUsd =
      qualified > 0
        ? Math.round((costMicrousd / 1_000_000 / qualified) * 1_000_000) / 1_000_000
        : null;
    return {
      providerKey: row.providerKey.trim(),
      recalledCandidates: recalled,
      finalQualifiedLeads: qualified,
      qualifiedRate,
      costMicrousd,
      costPerQualifiedLeadUsd,
    };
  });
}

function classifySourceTier(
  metric: SourceYieldMetric,
  minSamplesForPenalty: number,
): SourceYieldTier {
  if (metric.recalledCandidates < minSamplesForPenalty) return 'cold_start';
  if (metric.finalQualifiedLeads === 0 || metric.qualifiedRate < 0.03) return 'low_yield_noise';
  if (metric.qualifiedRate >= 0.2) return 'high_yield';
  return 'balanced';
}

function computeEffectiveWeight(
  metric: SourceYieldMetric,
  tier: SourceYieldTier,
  coldStartPriorRate: number,
  minSamplesForPenalty: number,
): number {
  if (tier === 'low_yield_noise') {
    return metric.finalQualifiedLeads === 0 ? 0 : metric.qualifiedRate * 0.25;
  }
  if (tier === 'cold_start') {
    const priorWeight = minSamplesForPenalty;
    return (metric.finalQualifiedLeads + priorWeight * coldStartPriorRate) /
      (metric.recalledCandidates + priorWeight);
  }
  return metric.qualifiedRate;
}

function allocateByLargestRemainder(
  shares: readonly number[],
  totalSlots: number,
  baseQuotas: readonly number[],
): number[] {
  if (totalSlots <= 0) return [...baseQuotas];
  const raw = shares.map((share) => share * totalSlots);
  const floors = raw.map((val) => Math.floor(val));
  const quotas = baseQuotas.map((base, idx) => base + floors[idx]!);
  let remaining = totalSlots - floors.reduce((sum, val) => sum + val, 0);
  const ranked = raw
    .map((val, idx) => ({ idx, frac: val - floors[idx]!, share: shares[idx]! }))
    .sort((a, b) => b.frac - a.frac || b.share - a.share || a.idx - b.idx);
  for (let i = 0; i < ranked.length && remaining > 0; i++) {
    quotas[ranked[i]!.idx]! += 1;
    remaining -= 1;
  }
  return quotas;
}

/**
 * 动态重分配各发现渠道的查询配额：
 * 1. 先按 `minExplorationShare` 保障每个渠道的最低探索额度（配额充足时每渠道至少 1 条）；
 * 2. 剩余配额严格按 `finalQualifiedLeads / recalledCandidates`（小样本平滑、0 产噪音源归零）比例分配；
 * 3. 保证各渠道整数配额之和严格等于 `totalQuota`。
 */
export function allocateSourceQueryQuotas(
  input: AllocateSourceQuotasInput,
): SourceQuotaAllocationPlan {
  const totalQuota = nonNegativeInt(input.totalQuota);
  const minExplorationShare = clampUnit(input.minExplorationShare ?? 0.1, 0.1);
  const coldStartPriorRate = clampUnit(input.coldStartPriorRate ?? 0.15, 0.15);
  const minSamplesForPenalty = Math.max(1, nonNegativeInt(input.minSamplesForPenalty ?? 5));

  const metrics = computeSourceYieldMetrics(input.sources).filter((m) => m.providerKey.length > 0);
  if (metrics.length === 0 || totalQuota === 0) {
    return { totalQuota, minExplorationShare, allocations: [] };
  }

  const enriched = metrics.map((metric) => {
    const tier = classifySourceTier(metric, minSamplesForPenalty);
    const effectiveWeight = computeEffectiveWeight(
      metric,
      tier,
      coldStartPriorRate,
      minSamplesForPenalty,
    );
    return { metric, tier, effectiveWeight };
  });

  const weightSum = enriched.reduce((sum, item) => sum + item.effectiveWeight, 0);
  const exploitShares = enriched.map((item) =>
    weightSum > 0 ? item.effectiveWeight / weightSum : 1 / enriched.length,
  );
  const explorationPerSource = minExplorationShare / enriched.length;
  const blendedShares = exploitShares.map(
    (exploit) => explorationPerSource + (1 - minExplorationShare) * exploit,
  );

  // Guarantee minimum 1 slot per enabled source whenever totalQuota covers all sources
  const minFloorPerSource = totalQuota >= enriched.length ? 1 : 0;
  const baseQuotas = enriched.map(() => minFloorPerSource);
  const remainingSlots = totalQuota - minFloorPerSource * enriched.length;
  const finalQuotas = allocateByLargestRemainder(
    weightSum > 0 ? exploitShares : blendedShares,
    remainingSlots,
    baseQuotas,
  );

  const allocations: SourceQuotaAllocation[] = enriched
    .map((item, idx) => ({
      ...item.metric,
      effectiveWeight: Math.round(item.effectiveWeight * 10_000) / 10_000,
      share: totalQuota > 0 ? Math.round((finalQuotas[idx]! / totalQuota) * 10_000) / 10_000 : 0,
      allocatedQuota: finalQuotas[idx]!,
      tier: item.tier,
    }))
    .sort((a, b) => b.allocatedQuota - a.allocatedQuota || b.qualifiedRate - a.qualifiedRate || a.providerKey.localeCompare(b.providerKey));

  return {
    totalQuota,
    minExplorationShare,
    allocations,
  };
}

/**
 * 面向查询规划器的可读配额建议摘要（无历史样本时返回 null）。
 */
export function formatSourceYieldAllocationNote(plan: SourceQuotaAllocationPlan): string | null {
  if (plan.allocations.length === 0) return null;
  const lines = plan.allocations.map(
    (row) =>
      `- ${row.providerKey}：建议配额 ${row.allocatedQuota}/${plan.totalQuota}（最终合格率 ${(row.qualifiedRate * 100).toFixed(1)}%，${row.finalQualifiedLeads}/${row.recalledCandidates}，档位=${row.tier}）`,
  );
  return ['按最终合格 Lead 产出动态分配的渠道查询配额建议：', ...lines].join('\n');
}

type RawQueryExecutor = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * 从 `source_yield_ledger` 与真实 `lead` 表对齐读取各渠道的最终合格 Lead 产出：
 * 仅将 `queue = 'recommended'` 或已进入 `QUALIFIED`/`CONTACTED`/`CONVERTED` 且非 `REJECTED`/`SUPPRESSED`
 * 的线索计为最终合格产出，避免把早期空洞召回误当高产源。
 */
export async function loadFinalLeadAlignedSourceYields(
  db: RawQueryExecutor,
  scope: {
    readonly workspaceId: string;
    readonly icpId?: string;
    readonly windowDays?: number;
  },
): Promise<SourceYieldMetric[]> {
  const windowDays = Math.max(1, Math.min(365, nonNegativeInt(scope.windowDays ?? 30)));
  const rows = await db.$queryRaw<
    Array<{
      provider_key: string;
      recalled_candidates: bigint;
      final_qualified_leads: bigint;
      cost_microusd: bigint;
    }>
  >(Prisma.sql`
    WITH ledger_agg AS (
      SELECT
        provider_key,
        COALESCE(SUM(record_count), 0)::bigint AS recalled_candidates,
        COALESCE(SUM(cost_microusd), 0)::bigint AS cost_microusd
      FROM source_yield_ledger
      WHERE workspace_id = ${scope.workspaceId}::uuid
        AND computed_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      GROUP BY provider_key
    ),
    first_source AS (
      SELECT DISTINCT ON (mo.canonical_company_id)
        mo.canonical_company_id,
        mo.provider_key
      FROM discovery_company_materialization_outcome mo
      WHERE mo.workspace_id = ${scope.workspaceId}::uuid
        AND mo.outcome = 'CANONICALIZED'
        AND mo.canonical_company_id IS NOT NULL
        AND mo.created_at >= NOW() - (${windowDays}::int * INTERVAL '1 day')
      ORDER BY mo.canonical_company_id, mo.created_at ASC, mo.provider_key ASC
    ),
    qualified_agg AS (
      SELECT
        fs.provider_key,
        COUNT(DISTINCT l.id)::bigint AS final_qualified_leads
      FROM first_source fs
      JOIN lead l
        ON l.workspace_id = ${scope.workspaceId}::uuid
       AND l.canonical_company_id = fs.canonical_company_id
       AND (${scope.icpId ?? null}::uuid IS NULL OR l.icp_id = ${scope.icpId ?? null}::uuid)
       AND l.status NOT IN ('REJECTED', 'SUPPRESSED')
       AND (l.queue = 'recommended' OR l.status IN ('QUALIFIED', 'CONTACTED', 'CONVERTED'))
      GROUP BY fs.provider_key
    )
    SELECT
      l.provider_key,
      l.recalled_candidates,
      COALESCE(q.final_qualified_leads, 0)::bigint AS final_qualified_leads,
      l.cost_microusd
    FROM ledger_agg l
    LEFT JOIN qualified_agg q ON q.provider_key = l.provider_key
    ORDER BY l.provider_key ASC
  `);

  return computeSourceYieldMetrics(
    rows.map((r) => ({
      providerKey: r.provider_key,
      recalledCandidates: Number(r.recalled_candidates),
      finalQualifiedLeads: Number(r.final_qualified_leads),
      costMicrousd: Number(r.cost_microusd),
    })),
  );
}
