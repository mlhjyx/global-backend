/**
 * 存量重判批次的规划器（P3 J21；设计 §4.3.9 J21）。
 *
 * 只做确定性规划：给定候选（公司 × ACTIVE ICP）与预算参数，产出有界批次、
 * 估算成本、并按「有域名优先」排序。真正的模型调用由发车后的 worker 执行，
 * 本模块与 CLI 保证**执行前**就能回答：这一批会给谁判、多少钱、会不会超帽。
 */

export const REJUDGE_DEFAULT_BATCH_SIZE = 25;

/** 单次 L2 判定的成本估算（设计 §4.3.3.7 实测均值 $0.0099 ≈ 9900 micros，k=1）。 */
export const REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY = 9900n;

export class RejudgePlanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RejudgePlanError';
  }
}

export interface RejudgeCandidate {
  canonicalCompanyId: string;
  companyName: string;
  domain: null | string;
  icpId: string;
}

export interface RejudgeBatch {
  candidates: RejudgeCandidate[];
  estimatedCostMicros: bigint;
  index: number;
}

export interface PlanRejudgeOptions {
  batchSize?: number;
  costCapMicros: bigint;
  maxCompanies?: number;
}

export interface RejudgePlan {
  batches: RejudgeBatch[];
  estimatedCostMicros: bigint;
  skipped: number;
  totalCandidates: number;
}

/** 有域名的候选优先（设计：按 ACTIVE ICP/域名优先），同组按公司名稳定排序。 */
export function orderRejudgeCandidates(
  candidates: readonly RejudgeCandidate[],
): RejudgeCandidate[] {
  return [...candidates].sort((a, b) => {
    const aHasDomain = a.domain ? 1 : 0;
    const bHasDomain = b.domain ? 1 : 0;
    if (aHasDomain !== bHasDomain) return bHasDomain - aHasDomain;
    const byName = a.companyName.localeCompare(b.companyName);
    if (byName !== 0) return byName;
    return a.canonicalCompanyId.localeCompare(b.canonicalCompanyId);
  });
}

/**
 * 规划批次：总估算成本超帽时**拒绝规划**（RejudgePlanError），
 * 不静默截断——截断会让「重判完成率」变成假指标；要少判就显式调低 maxCompanies。
 */
export function planRejudgeBatches(
  candidates: readonly RejudgeCandidate[],
  options: PlanRejudgeOptions,
): RejudgePlan {
  const batchSize = options.batchSize ?? REJUDGE_DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 200) {
    throw new RejudgePlanError(
      'REJUDGE_BATCH_SIZE_INVALID',
      `batchSize must be 1..200 (got ${batchSize})`,
    );
  }
  if (options.costCapMicros <= 0n) {
    throw new RejudgePlanError(
      'REJUDGE_COST_CAP_INVALID',
      'costCapMicros must be positive',
    );
  }
  const ordered = orderRejudgeCandidates(candidates);
  const limited =
    options.maxCompanies === undefined ? ordered : ordered.slice(0, options.maxCompanies);
  const estimated = BigInt(limited.length) * REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY;
  if (estimated > options.costCapMicros) {
    throw new RejudgePlanError(
      'REJUDGE_COST_CAP_EXCEEDED',
      `estimated ${estimated} micros exceeds cap ${options.costCapMicros} micros ` +
        `(${limited.length} companies); lower --max-companies or raise the cap deliberately`,
    );
  }
  const batches: RejudgeBatch[] = [];
  for (let start = 0; start < limited.length; start += batchSize) {
    const slice = limited.slice(start, start + batchSize);
    batches.push({
      index: batches.length,
      candidates: slice,
      estimatedCostMicros:
        BigInt(slice.length) * REJUDGE_ESTIMATED_COST_MICROS_PER_COMPANY,
    });
  }
  return {
    batches,
    estimatedCostMicros: estimated,
    totalCandidates: limited.length,
    skipped: candidates.length - limited.length,
  };
}
