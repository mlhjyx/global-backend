import type { PlanQueryShape } from './icp-to-cpv';
import { tradeRoleFor, type TradeRole } from './search-localization';

/** Cold-path sources that carry their own deterministic filters. */
const COLD_PATH_HINTS: ReadonlySet<string> = new Set(['ted', 'openfda']);

function text(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').join(' ');
  return typeof value === 'string' ? value : '';
}

/** The ICP's trade role: `trade_side` first, then `business_model`; null when neither names one. */
export function icpTradeRole(companyAttributes: unknown): TradeRole | null {
  if (!companyAttributes || typeof companyAttributes !== 'object' || Array.isArray(companyAttributes)) {
    return null;
  }
  const attributes = companyAttributes as Record<string, unknown>;
  return (
    tradeRoleFor({ filters: { trade_side: text(attributes.trade_side) } }) ??
    tradeRoleFor({ filters: { business_model: text(attributes.business_model) } })
  );
}

/**
 * Carry the ICP trade role into planner queries that name none (G3 5.3).
 * Keyword discovery builds its role words (Großhandel/Händler/Vertrieb …) from
 * `filters.trade_side`, but the planner schema has no `business_model` filter
 * and may omit `trade_side`; this writes the canonical role before the plan is
 * stored, so the human plan review sees it. TED/openFDA queries are untouched.
 */
export function withIcpTradeRole<Q extends PlanQueryShape>(
  queries: readonly Q[],
  companyAttributes: unknown,
): Q[] {
  const role = icpTradeRole(companyAttributes);
  return queries.map((query) => {
    const filters = query.filters ?? {};
    const hint = typeof filters.source_hint === 'string' ? filters.source_hint.toLowerCase() : '';
    if (!role || COLD_PATH_HINTS.has(hint) || tradeRoleFor({ filters })) return query;
    return { ...query, filters: { ...filters, trade_side: role } };
  });
}
