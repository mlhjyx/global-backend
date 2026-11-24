import { searchLanguagesForMarkets, partitionSearchTerms, type SearchLanguage } from '../discovery/search-localization';

export const PLANNER_LANGUAGE_NAMES: Readonly<Record<SearchLanguage, string>> = Object.freeze({
  de: '德语', en: '英语', fr: '法语', it: '意大利语', es: '西班牙语', nl: '荷兰语', pl: '波兰语', zh: '中文',
  ms: '马来语', id: '印度尼西亚语', vi: '越南语', th: '泰语', ja: '日语', ko: '韩语', pt: '葡萄牙语', tr: '土耳其语',
  ar: '阿拉伯语',
});

/**
 * Planner keywords go straight into the target market's search engine, so a
 * Chinese keyword wastes the search and every extraction behind it.
 */
export function plannerKeywordLanguage(targetMarkets: unknown, companyAttributes: unknown): string {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
  const country = (companyAttributes as { country?: unknown } | null)?.country;
  const names = searchLanguagesForMarkets([...list(targetMarkets), ...list(country)])
    .map((code) => PLANNER_LANGUAGE_NAMES[code]);
  const rule = names.length > 1
    ? `每条查询的 keywords 必须用该查询 filters.country 所在国家的语言书写（本 ICP 涉及${names.join('、')}）`
    : `keywords 必须全部用${names[0] ?? '目标市场的当地语言'}书写`;
  const fallback = names.length ? '' : '无法确定时用英语。';
  return `keywords 会直接交给目标市场的搜索引擎。${rule}，使用当地行业的常用说法与同义词，不得出现中文。${fallback}filters 里的 industry、country 仍可用中文，供规范词表映射。`;
}

/** P2 §2.3：关键词存在却全部不能用于目标语言的检索 → 规划器语言不符（触发一次重写）。 */
export function plannerKeywordsMismatch(
  queries: readonly { keywords?: readonly string[]; filters?: Record<string, unknown> }[],
  fallbackLanguage: SearchLanguage | undefined,
): boolean {
  return queries.some((query) => {
    const keywords = (query.keywords ?? []).filter(
      (keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0,
    );
    if (keywords.length === 0) return false;
    const byCountry = searchLanguagesForMarkets((query.filters ?? {}).country)[0];
    const language = (byCountry ?? fallbackLanguage) as SearchLanguage | undefined;
    if (!language) return false;
    return partitionSearchTerms(keywords, language).usable.length === 0;
  });
}

