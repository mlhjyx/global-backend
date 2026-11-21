import {
  MAX_QUERY_TAXONOMY_COUNTRY_TERMS,
  MAX_QUERY_TAXONOMY_INDUSTRY_TERMS,
} from './execution-envelope';
import { isSpecificIndustryNode, wikidataBroadIndustryMode } from './wikidata-industry-scope';

function terms(values: readonly unknown[], limit: number): string[] {
  const out: string[] = [];
  for (const value of values.flat()) {
    if (!value) continue;
    const term = String(value);
    if (!out.includes(term)) out.push(term);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * Plan-query terms that executeQuery sends to the taxonomy resolver. Planner
 * filters may hold up to 32 values each and every unresolved term costs one
 * `taxonomy.normalize` call, so the resolver input is capped per query to keep
 * the cold path inside the discovery.run quote.
 */
export function queryTaxonomyTerms(filters: Readonly<Record<string, unknown>>): {
  industryTerms: string[];
  countryTerms: string[];
} {
  return {
    industryTerms: terms([filters.industry, filters.sub_industry], MAX_QUERY_TAXONOMY_INDUSTRY_TERMS),
    countryTerms: terms([filters.country, filters.region], MAX_QUERY_TAXONOMY_COUNTRY_TERMS),
  };
}

/**
 * Wikidata query pivots: only class-level industry nodes (3+ digit codes) are
 * specific enough for P452; section letters and 2-digit divisions recall any
 * manufacturer. `DISCOVERY_WIKIDATA_BROAD_INDUSTRY_MODE=off` keeps the old list.
 */
export function queryableIndustryNodes<T extends { code: string; wikidataQid?: string | null }>(
  nodes: readonly T[],
  mode = wikidataBroadIndustryMode(),
): readonly T[] {
  return nodes.filter((node) => mode === 'off' || isSpecificIndustryNode(node));
}
