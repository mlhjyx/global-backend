/**
 * A deterministic, side-effect-free adviser for a possible next discovery round.
 *
 * It deliberately does not persist, confirm, execute, call a Provider, or call a
 * model. Its only executable-looking output is hard-coded to DRAFT and must pass
 * through the existing QueryPlan human confirmation gate before it can become
 * READY.
 */

export interface AdaptivePlanQuery {
  source_class: string;
  filters: Record<string, unknown>;
  keywords: string[];
  rationale?: string;
  priority: number;
  [key: string]: unknown;
}

export interface AdaptiveOriginalPlan {
  status: string;
  queries: AdaptivePlanQuery[];
}

export interface AdaptiveSourceStats {
  rawCount: number;
  quarantinedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  failedProviderCount: number;
  provider: string | null;
  /** Optional precomputed yield supplied by callers that already have one. */
  yieldCount?: number;
}

export interface AdaptiveIdentityQuality {
  acceptedRows: number;
  boundRows: number;
  uniqueCompanies: number;
  conflictRows: number;
}

export interface AdaptiveRoundStats {
  perSource: Record<string, AdaptiveSourceStats>;
  identityQuality: Record<string, AdaptiveIdentityQuality>;
}

export interface AdaptiveSuggestionInput {
  currentRound: number;
  maxRounds: number;
  originalPlan: AdaptiveOriginalPlan;
  stats: AdaptiveRoundStats;
}

export type AdaptiveReasonCode =
  | 'LOW_YIELD_BROADENED'
  | 'LOW_YIELD_NO_SAFE_CHANGE'
  | 'DUPLICATE_SATURATION'
  | 'SOURCE_FAILURE_PAUSED'
  | 'LOW_IDENTITY_QUALITY';

export interface AdaptiveSuggestionReason {
  sourceClass: string;
  code: AdaptiveReasonCode;
  detail: string;
}

export type AdaptiveQueryPlanSuggestion =
  | {
      outcome: 'DRAFT';
      nextRound: number;
      status: 'DRAFT';
      requiresHumanConfirmation: true;
      executable: false;
      queries: AdaptivePlanQuery[];
      reasons: AdaptiveSuggestionReason[];
    }
  | {
      outcome: 'CONVERGED';
      reason: 'MAX_ROUNDS_REACHED' | 'NO_SAFE_ADAPTATION' | 'NO_ADAPTATION_NEEDED';
      currentRound: number;
      maxRounds: number;
      draft: null;
    };

const DUPLICATE_SATURATION_RATIO = 0.75;
const LOW_YIELD_MAX = 1;
const LOW_IDENTITY_BINDING_RATIO = 0.3;
const HIGH_IDENTITY_CONFLICT_RATIO = 0.2;

// Removing these could change jurisdiction, identity or provider semantics, so
// the adviser never relaxes them automatically. A human can still edit the draft.
const PROTECTED_FILTER_KEYS = new Set([
  'country',
  'countries',
  'jurisdiction',
  'source',
  'provider',
  'source_hint',
  'provider_key',
  '_provider',
  'identifier',
  'identifier_type',
  'registration_number',
  'lei',
  'cik',
  'siren',
  'cpv',
  'cpv_code',
  'product_code',
]);

function finiteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sourceYield(stats: AdaptiveSourceStats): number {
  if (stats.yieldCount !== undefined) return finiteCount(stats.yieldCount);
  return Math.max(
    0,
    finiteCount(stats.rawCount)
      - finiteCount(stats.quarantinedCount)
      - finiteCount(stats.rejectedCount)
      - finiteCount(stats.duplicateCount),
  );
}

function duplicateRatio(stats: AdaptiveSourceStats): number {
  const duplicates = finiteCount(stats.duplicateCount);
  const observed = Math.max(finiteCount(stats.rawCount), duplicates);
  return observed === 0 ? 0 : duplicates / observed;
}

function identityQualityIsLow(quality: AdaptiveIdentityQuality | undefined): boolean {
  if (!quality || finiteCount(quality.acceptedRows) < 4) return false;
  const accepted = finiteCount(quality.acceptedRows);
  return finiteCount(quality.boundRows) / accepted < LOW_IDENTITY_BINDING_RATIO
    || finiteCount(quality.conflictRows) / accepted >= HIGH_IDENTITY_CONFLICT_RATIO;
}

function cloneQuery(query: AdaptivePlanQuery): AdaptivePlanQuery {
  return {
    ...query,
    filters: structuredClone(query.filters),
    keywords: [...query.keywords],
  };
}

function broadenLowYieldQuery(query: AdaptivePlanQuery): AdaptivePlanQuery | null {
  const next = cloneQuery(query);
  const relaxableFilter = Object.keys(next.filters)
    .filter((key) => !PROTECTED_FILTER_KEYS.has(key.toLocaleLowerCase('en-US')))
    .sort((left, right) => left.localeCompare(right, 'en-US'))[0];
  if (relaxableFilter) {
    delete next.filters[relaxableFilter];
    return next;
  }
  if (next.keywords.length > 1) {
    next.keywords = next.keywords.slice(0, -1);
    return next;
  }
  return null;
}

function sortedQueries(queries: AdaptivePlanQuery[]): AdaptivePlanQuery[] {
  return queries.sort((left, right) =>
    left.priority - right.priority
      || left.source_class.localeCompare(right.source_class, 'en-US')
      || JSON.stringify(left).localeCompare(JSON.stringify(right), 'en-US'),
  );
}

export function suggestAdaptiveQueryPlan(
  input: AdaptiveSuggestionInput,
): AdaptiveQueryPlanSuggestion {
  if (!Number.isInteger(input.currentRound) || input.currentRound < 1) {
    throw new TypeError('currentRound must be a positive integer');
  }
  if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1) {
    throw new TypeError('maxRounds must be a positive integer');
  }
  if (input.currentRound >= input.maxRounds) {
    return {
      outcome: 'CONVERGED',
      reason: 'MAX_ROUNDS_REACHED',
      currentRound: input.currentRound,
      maxRounds: input.maxRounds,
      draft: null,
    };
  }

  const queries: AdaptivePlanQuery[] = [];
  const reasons: AdaptiveSuggestionReason[] = [];

  for (const original of input.originalPlan.queries) {
    const stats = input.stats.perSource[original.source_class];
    let query = cloneQuery(original);
    if (!stats) {
      queries.push(query);
      continue;
    }

    if (finiteCount(stats.failedProviderCount) > 0) {
      reasons.push({
        sourceClass: original.source_class,
        code: 'SOURCE_FAILURE_PAUSED',
        detail: '上一轮存在 Provider 失败；下一轮草案暂停该来源，等待人工检查连接或来源状态。',
      });
      continue;
    }

    if (duplicateRatio(stats) >= DUPLICATE_SATURATION_RATIO) {
      reasons.push({
        sourceClass: original.source_class,
        code: 'DUPLICATE_SATURATION',
        detail: '上一轮重复占比已达到饱和阈值；下一轮草案暂停重复搜索该来源。',
      });
      continue;
    }

    if (sourceYield(stats) <= LOW_YIELD_MAX) {
      const broadened = broadenLowYieldQuery(query);
      if (!broadened) {
        reasons.push({
          sourceClass: original.source_class,
          code: 'LOW_YIELD_NO_SAFE_CHANGE',
          detail: '上一轮有效产出过低，且没有可安全放宽的非身份条件；不自动编造新条件。',
        });
        continue;
      }
      query = broadened;
      reasons.push({
        sourceClass: original.source_class,
        code: 'LOW_YIELD_BROADENED',
        detail: '上一轮有效产出过低；草案仅放宽一个非身份条件，保留国家和强标识边界。',
      });
    }

    const qualityKey = stats.provider || original.source_class;
    if (identityQualityIsLow(input.stats.identityQuality[qualityKey])) {
      query.priority += 100;
      reasons.push({
        sourceClass: original.source_class,
        code: 'LOW_IDENTITY_QUALITY',
        detail: '上一轮身份绑定率偏低或冲突率偏高；草案将该来源降到其他来源之后。',
      });
    }
    queries.push(query);
  }

  if (queries.length === 0) {
    return {
      outcome: 'CONVERGED',
      reason: 'NO_SAFE_ADAPTATION',
      currentRound: input.currentRound,
      maxRounds: input.maxRounds,
      draft: null,
    };
  }
  if (reasons.length === 0) {
    return {
      outcome: 'CONVERGED',
      reason: 'NO_ADAPTATION_NEEDED',
      currentRound: input.currentRound,
      maxRounds: input.maxRounds,
      draft: null,
    };
  }

  return {
    outcome: 'DRAFT',
    nextRound: input.currentRound + 1,
    status: 'DRAFT',
    requiresHumanConfirmation: true,
    executable: false,
    queries: sortedQueries(queries),
    reasons,
  };
}
