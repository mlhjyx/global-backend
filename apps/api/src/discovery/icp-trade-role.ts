import type { PlanQueryShape } from './icp-to-cpv';
import { tradeRoleFor, type TradeRole } from './search-localization';

/** Cold-path or spatial/registry sources where stamping a distributor role distorts queries. */
const SKIP_ROLE_HINTS: ReadonlySet<string> = new Set([
  'ted',
  'openfda',
  'openstreetmap',
  'registry_frame',
]);

/** Non-distributor buyer/project/manufacturer intents that must not be overwritten with distributor words. */
const NON_DISTRIBUTOR_QUERY_INTENT =
  /\b(?:epc|installers?|installator[ei]|installateur[e]?|developers?|sviluppator[ei]|contractors?|integrators?|system[- ]integrators?|solar[- ]parks?|parco[- ]fotovoltaico|utility[- ]scale|power[- ]plants?|manufacturers?|factory|factories|hersteller|produttor[ei])\b|安装商|工程总包|开发商|系统集成商|集成商|电站|制造商|工厂/iu;

const EXPLICIT_DISTRIBUTOR_QUERY_INTENT =
  /\b(?:distributors?|wholesalers?|grossist[ai]|großhandel|händler|vertrieb|importeurs?|importers?|resellers?|dealers?)\b|分销商|批发商|经销商|进口商/iu;

function queryTargetsNonDistributorRole(query: PlanQueryShape): boolean {
  const filters = query.filters ?? {};
  const haystack = [
    ...(query.keywords ?? []),
    text(filters.industry),
    text(filters.sub_industry),
    text(filters.product),
  ].join(' ');
  if (!haystack.trim()) return false;
  return NON_DISTRIBUTOR_QUERY_INTENT.test(haystack) && !EXPLICIT_DISTRIBUTOR_QUERY_INTENT.test(haystack);
}

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
    if (!role || SKIP_ROLE_HINTS.has(hint) || tradeRoleFor({ filters })) return query;
    if (role === 'distributor' && queryTargetsNonDistributorRole(query)) return query;
    return { ...query, filters: { ...filters, trade_side: role } };
  });
}
