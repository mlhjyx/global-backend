export interface FitTotals {
  judged?: number;
  verdicts: Record<string, number>;
  skippedForBudget?: number;
  unjudged?: number;
  unreplayable?: number;
}

export interface WebsiteProfileTotals {
  /** The run's own companies profiled (W5-f: backfill companies are counted in `backfilled`). */
  profiled: number;
  matched: number;
  skippedSubjects?: number;
  budgetTruncated?: boolean;
  unclassified?: number;
  unreplayable?: number;
  /** Workspace companies outside the run whose contact paths were read with the leftover quota; absent in older results. */
  backfilled?: number;
}

export interface EnrichTotals {
  enriched: number;
  matched: number;
  provider: string | null;
  budgetTruncated: boolean;
}

export function addFitPass(total: FitTotals, pass: FitTotals): FitTotals {
  const verdicts = { ...total.verdicts };
  for (const [verdict, count] of Object.entries(pass.verdicts ?? {})) {
    verdicts[verdict] = (verdicts[verdict] ?? 0) + count;
  }
  return {
    judged: (total.judged ?? 0) + (pass.judged ?? 0),
    verdicts,
    skippedForBudget: (total.skippedForBudget ?? 0) + (pass.skippedForBudget ?? 0),
    unjudged: (total.unjudged ?? 0) + (pass.unjudged ?? 0),
    unreplayable: (total.unreplayable ?? 0) + (pass.unreplayable ?? 0),
  };
}

export function addWebsiteProfilePass(total: WebsiteProfileTotals, pass: WebsiteProfileTotals): WebsiteProfileTotals {
  return {
    profiled: total.profiled + pass.profiled,
    matched: total.matched + pass.matched,
    skippedSubjects: (total.skippedSubjects ?? 0) + (pass.skippedSubjects ?? 0),
    budgetTruncated: (total.budgetTruncated ?? false) || (pass.budgetTruncated ?? false),
    unclassified: (total.unclassified ?? 0) + (pass.unclassified ?? 0),
    unreplayable: (total.unreplayable ?? 0) + (pass.unreplayable ?? 0),
    backfilled: (total.backfilled ?? 0) + (pass.backfilled ?? 0),
  };
}

/** Joins the `+`-separated provider keys of two enrich activities without repeating one. */
function mergeProviders(left: string | null, right: string | null): string | null {
  const keys = [...new Set([left, right].flatMap((value) => (value ? value.split('+') : [])))];
  return keys.length ? keys.join('+') : null;
}

export function addEnrichPass(total: EnrichTotals, pass: EnrichTotals): EnrichTotals {
  return {
    enriched: total.enriched + pass.enriched,
    matched: total.matched + pass.matched,
    provider: mergeProviders(total.provider, pass.provider),
    budgetTruncated: total.budgetTruncated || pass.budgetTruncated,
  };
}

