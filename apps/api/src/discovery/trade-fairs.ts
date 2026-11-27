import { TRADE_FAIRS, type TradeFairTemplate } from '../adapters/trade-fair-catalog';

export { TRADE_FAIRS, type TradeFairTemplate };

/** 按 ICP 行业/关键词（+可选地域）选相关展会模板。命中 = 主题词出现在行业/关键词里。 */
export function selectFairs(params: {
  industryTerms?: string[];
  keywords?: string[];
  region?: string;
}): TradeFairTemplate[] {
  const hay = [...(params.industryTerms ?? []), ...(params.keywords ?? [])]
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (!hay.length) return [];
  return TRADE_FAIRS.filter((fair) =>
    fair.topics.some((t) => hay.some((h) => h.includes(t) || t.includes(h))),
  );
}
